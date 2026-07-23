// Dual-writer safety for `open-take edit`. The editor and the agent both write
// <base>.composition.json — the editor autosaves every ~700ms while the agent
// rewrites the whole file between renders. Before this, the later write simply
// won and the other party's edit vanished with no trace. Now a write carries
// the mtime the client last saw and the server refuses (409) when the file
// moved since, so the loser is a human who gets asked instead of an edit that
// disappears.
//
// These tests drive a real edit-server over HTTP — the guard has to hold at the
// wire, not just in a unit.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { planComposition } from "@open-take/compositor";
import { startEditServer } from "../src/edit-server.js";
import type { RenderCompositionOpts } from "../src/index.js";

const log = {
  video: { width: 1280, height: 720 },
  viewport: { w: 1280, h: 720 },
  events: [
    { tMs: 800, kind: "click", point: { x: 300, y: 240 }, label: "a" },
    { tMs: 2400, kind: "click", point: { x: 900, y: 480 }, label: "b" },
  ],
  tEndMs: 3600,
} as Parameters<typeof planComposition>[0];

let dir: string;
let base: string;
let server: Awaited<ReturnType<typeof startEditServer>>;
let url: string;
let renderGate: ReturnType<typeof deferred<void>> | null = null;
let renderStarted: ReturnType<typeof deferred<void>> | null = null;
let lastRenderOpts: RenderCompositionOpts | null = null;
let renderCalls = 0;
let commitGate: ReturnType<typeof deferred<void>> | null = null;
let commitStarted: ReturnType<typeof deferred<void>> | null = null;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const fakeRender = async (opts: RenderCompositionOpts) => {
  renderCalls++;
  lastRenderOpts = opts;
  renderStarted?.resolve(undefined);
  await renderGate?.promise;
  return {
    mp4Path: opts.outPath,
    compositionPath: opts.outPath.replace(/\.mp4$/i, ".composition.json"),
  };
};

const post = (path: string, body: unknown) =>
  fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const getTake = async () =>
  (await (await fetch(`${url}api/take`)).json()) as { composition: unknown; mtime: number };

/** An agent writing the file behind the editor's back. Waits first: mtime is
 *  the whole signal, and two writes inside the same millisecond are invisible
 *  to it (a real agent round-trip is never that fast). */
async function agentWrites(patch: (c: Record<string, unknown>) => void): Promise<number> {
  await new Promise((r) => setTimeout(r, 12));
  const comp = JSON.parse(await readFile(`${base}.composition.json`, "utf8"));
  patch(comp);
  await writeFile(`${base}.composition.json`, JSON.stringify(comp, null, 2));
  return (await stat(`${base}.composition.json`)).mtimeMs;
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-editsrv-"));
  base = join(dir, "demo");
  await writeFile(`${base}.composition.json`, JSON.stringify(planComposition(log), null, 2));
  await writeFile(`${base}.capture.json`, JSON.stringify(log));
  await writeFile(`${base}.capture.mp4`, ""); // only stat'd unless /video is fetched
  server = await startEditServer(
    { takePath: `${base}.mp4`, port: 0, open: false },
    {
      renderComposition: fakeRender,
      beforeCompositionCommit: async () => {
        commitStarted?.resolve(undefined);
        await commitGate?.promise;
      },
    },
  );
  url = server.url;
});

after(async () => {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

test("GET /api/take hands out the mtime its composition was read at", async () => {
  const take = await getTake();
  assert.ok(take.composition, "composition returned");
  assert.equal(take.mtime, (await stat(`${base}.composition.json`)).mtimeMs);
});

test("a save on the current base is accepted and re-bases the client", async () => {
  const take = await getTake();
  const r = await post("api/composition", { composition: take.composition, baseMtime: take.mtime });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { ok: boolean; mtime: number };
  assert.equal(body.ok, true);
  assert.equal(body.mtime, (await stat(`${base}.composition.json`)).mtimeMs);
  assert.notEqual(body.mtime, take.mtime, "the write moved the file");
});

test("a save over an unseen agent write is refused with 409 — and the agent's edit survives", async () => {
  const take = await getTake(); // the editor's base
  const agentMtime = await agentWrites((c) => {
    (c as { durationMs: number }).durationMs = 12345;
  });

  const r = await post("api/composition", { composition: take.composition, baseMtime: take.mtime });
  assert.equal(r.status, 409);
  const body = (await r.json()) as { conflict: boolean; mtime: number };
  assert.equal(body.conflict, true);
  assert.equal(body.mtime, agentMtime, "409 reports the mtime to re-base on");

  const onDisk = JSON.parse(await readFile(`${base}.composition.json`, "utf8"));
  assert.equal(onDisk.durationMs, 12345, "the refused write did not land");
});

test("保留我的: re-sending with the mtime from the 409 goes through", async () => {
  const take = await getTake();
  const conflicting = { ...(take.composition as object), durationMs: 4321 };
  await agentWrites((c) => {
    (c as { durationMs: number }).durationMs = 999;
  });

  const refused = await post("api/composition", {
    composition: conflicting,
    baseMtime: take.mtime,
  });
  assert.equal(refused.status, 409);
  const { mtime } = (await refused.json()) as { mtime: number };

  const retry = await post("api/composition", { composition: conflicting, baseMtime: mtime });
  assert.equal(retry.status, 200);
  const onDisk = JSON.parse(await readFile(`${base}.composition.json`, "utf8"));
  assert.equal(onDisk.durationMs, 4321, "the user's version won, deliberately");
});

test("a bare composition body is rejected and cannot overwrite the file", async () => {
  const take = await getTake();
  const mine = { ...(take.composition as object), durationMs: 6000 };
  const before = await readFile(`${base}.composition.json`, "utf8");
  const r = await post("api/composition", mine);
  assert.equal(r.status, 428);
  assert.match(((await r.json()) as { error: string }).error, /precondition required/);
  assert.equal(await readFile(`${base}.composition.json`, "utf8"), before);
});

test("an envelope without baseMtime is rejected and cannot overwrite the file", async () => {
  const take = await getTake();
  const before = await readFile(`${base}.composition.json`, "utf8");
  const r = await post("api/composition", { composition: take.composition });
  assert.equal(r.status, 428);
  assert.equal(await readFile(`${base}.composition.json`, "utf8"), before);
});

test("a render without baseMtime is rejected before it reaches the renderer", async () => {
  const take = await getTake();
  const callsBefore = renderCalls;
  const r = await post("api/render", { composition: take.composition });
  assert.equal(r.status, 428);
  assert.equal(renderCalls, callsBefore);
  const onDisk = JSON.parse(await readFile(`${base}.composition.json`, "utf8"));
  assert.deepEqual(onDisk, take.composition);
});

test("an invalid composition is rejected before the conflict check runs", async () => {
  const take = await getTake();
  const broken = { ...(take.composition as object), output: { width: 0, height: 0, fps: 0 } };
  const r = await post("api/composition", { composition: broken, baseMtime: 1 /* stale */ });
  assert.equal(r.status, 400, "400 beats 409 — the payload is unusable either way");
});

test("an agent write while the server prepares its temp file is caught before rename", async () => {
  const take = await getTake();
  commitGate = deferred<void>();
  commitStarted = deferred<void>();

  try {
    const pending = post("api/composition", {
      composition: { ...(take.composition as object), durationMs: 7000 },
      baseMtime: take.mtime,
    });
    await commitStarted.promise;
    const agentMtime = await agentWrites((comp) => {
      comp.agentMarker = "written while temp file was pending";
    });
    commitGate.resolve(undefined);

    const response = await pending;
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { conflict: true, mtime: agentMtime });
    const onDisk = JSON.parse(await readFile(`${base}.composition.json`, "utf8"));
    assert.equal(onDisk.agentMarker, "written while temp file was pending");
    assert.equal(
      await stat(`${base}.composition.json.tmp`).catch(() => null),
      null,
      "the refused temp file was cleaned up",
    );
  } finally {
    commitGate?.resolve(undefined);
    commitGate = null;
    commitStarted = null;
  }
});

test("two simultaneous guarded render requests reserve only one job", async () => {
  const take = await getTake();
  commitGate = deferred<void>();
  commitStarted = deferred<void>();
  renderGate = deferred<void>();
  renderStarted = deferred<void>();
  const callsBefore = renderCalls;

  try {
    // Pause the first request during persistence so the second reaches the
    // endpoint while no RenderJob has been assigned yet — the synchronous
    // reservation must be what refuses it.
    const payload = { composition: take.composition, baseMtime: take.mtime };
    const firstPending = post("api/render", payload);
    await commitStarted.promise;
    const secondPending = post("api/render", payload);
    await new Promise((resolve) => setTimeout(resolve, 20));
    commitGate.resolve(undefined);

    const [first, second] = await Promise.all([firstPending, secondPending]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 409);
    assert.deepEqual(await second.json(), { error: "a render is already in progress" });

    const { jobId } = (await first.json()) as { jobId: string };
    await renderStarted.promise;
    assert.equal(renderCalls, callsBefore + 1, "only the reserved request reached the renderer");
    renderGate.resolve(undefined);
    const events = await (await fetch(`${url}api/render/${jobId}/events`)).text();
    assert.match(events, /event: done/);
  } finally {
    commitGate?.resolve(undefined);
    renderGate?.resolve(undefined);
    commitGate = null;
    commitStarted = null;
    renderGate = null;
    renderStarted = null;
  }
});

test("render persists once, re-bases at POST, and preserves an agent write made during rendering", async () => {
  const take = await getTake();
  renderGate = deferred<void>();
  renderStarted = deferred<void>();
  lastRenderOpts = null;

  try {
    const response = await post("api/render", {
      composition: take.composition,
      baseMtime: take.mtime,
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { jobId: string; mtime: number };
    assert.equal(body.mtime, (await stat(`${base}.composition.json`)).mtimeMs);

    await renderStarted.promise;
    assert.equal(
      lastRenderOpts?.writeCompositionSibling,
      false,
      "the renderer must not perform an unguarded second composition write",
    );

    await agentWrites((comp) => {
      comp.agentMarker = "written while rendering";
    });
    renderGate.resolve(undefined);

    const events = await (await fetch(`${url}api/render/${body.jobId}/events`)).text();
    assert.match(events, /event: done/);
    assert.doesNotMatch(events, /"mtime"/, "render completion must not re-base the client");

    const onDisk = JSON.parse(await readFile(`${base}.composition.json`, "utf8"));
    assert.equal(
      onDisk.agentMarker,
      "written while rendering",
      "render completion did not overwrite the agent's edit",
    );
  } finally {
    renderGate?.resolve(undefined);
    renderGate = null;
    renderStarted = null;
  }
});
