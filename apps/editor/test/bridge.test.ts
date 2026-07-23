import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConflictError,
  getBaseMtime,
  renderViaBridge,
  saveComposition,
  setBaseMtime,
} from "../src/lib/bridge.js";
import type { TakeComposition } from "../src/lib/compositor.js";

const composition = { version: 1 } as unknown as TakeComposition;

class MockEventSource {
  static latest: MockEventSource | null = null;
  readonly url: string;
  onerror: (() => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor(url: string | URL) {
    this.url = String(url);
    MockEventSource.latest = this;
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close(): void {
    this.closed = true;
  }
}

async function waitForEventSource(): Promise<MockEventSource> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await Promise.resolve();
    const source = MockEventSource.latest as MockEventSource | null;
    if (source) return source;
  }
  throw new Error("renderViaBridge did not open an EventSource");
}

test("render re-bases from POST and completion cannot adopt a later disk mtime", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const progress: number[] = [];
  MockEventSource.latest = null;
  setBaseMtime(10);

  try {
    globalThis.fetch = (async (input, init) => {
      assert.equal(input, "/api/render");
      assert.equal(init?.method, "POST");
      const sent = JSON.parse(String(init?.body)) as { baseMtime: number };
      assert.equal(sent.baseMtime, 10);
      return Response.json({ jobId: "job-1", mtime: 20 });
    }) as typeof fetch;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

    const pending = renderViaBridge(composition, (value) => progress.push(value));
    const source = await waitForEventSource();
    assert.equal(getBaseMtime(), 20, "the guarded POST write re-bases immediately");
    assert.equal(source.url, "/api/render/job-1/events");

    source.emit("progress", { progress: 0.4 });
    source.emit("done", { mp4Url: "/api/take/output?v=new" });
    assert.deepEqual(await pending, { mp4Url: "/api/take/output?v=new" });
    assert.deepEqual(progress, [0.4]);
    assert.equal(getBaseMtime(), 20, "SSE done did not overwrite the guarded-write base");
    assert.equal(source.closed, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    setBaseMtime(undefined);
  }
});

test("a 409 response exposes the server mtime without moving the local base", async () => {
  const originalFetch = globalThis.fetch;
  setBaseMtime(7);
  try {
    globalThis.fetch = (async () =>
      Response.json({ conflict: true, mtime: 9 }, { status: 409 })) as typeof fetch;
    await assert.rejects(saveComposition(composition), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.mtime, 9);
      return true;
    });
    assert.equal(getBaseMtime(), 7);
  } finally {
    globalThis.fetch = originalFetch;
    setBaseMtime(undefined);
  }
});
