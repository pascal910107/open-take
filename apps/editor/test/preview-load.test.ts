// loadVideo must always settle. A <video> whose request is refused or stalled
// fires NEITHER `loadeddata` NOR `error` — it just sits at networkState LOADING —
// and the promise used to hang on that forever. The visible symptom is the whole
// editor parked on its "Loading…" seed screen with no message, which is exactly
// what happened when a browser extension answered 503 for the bridge's
// /api/take/video: several minutes of debugging a hang that a one-line rejection
// would have named. The seed screen already renders `p.error`.
//
// These tests exercise only the two REJECTION paths, so they need no canvas 2D:
// a successful load is the one branch that draws.

import assert from "node:assert/strict";
import { test } from "node:test";
import { PreviewEngine } from "../src/engine/preview";

type Listener = () => void;

/** The smallest thing loadVideo can talk to: it listens, sets src, calls load(). */
function fakeVideo(init: { readyState?: number; networkState?: number } = {}) {
  const listeners = new Map<string, Set<Listener>>();
  const v = {
    src: "",
    readyState: init.readyState ?? 0,
    networkState: init.networkState ?? 2, // NETWORK_LOADING
    duration: 0,
    error: null as { code: number; message: string } | null,
    loadCalls: 0,
    addEventListener(type: string, cb: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(cb);
    },
    removeEventListener(type: string, cb: Listener) {
      listeners.get(type)?.delete(cb);
    },
    load() {
      v.loadCalls++;
    },
    fire(type: string) {
      for (const cb of [...(listeners.get(type) ?? [])]) cb();
    },
    count(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
  return v;
}

const fakeCanvas = () => ({ getContext: () => ({}) });

function engine(v: ReturnType<typeof fakeVideo>) {
  const eng = new PreviewEngine(
    fakeCanvas() as unknown as HTMLCanvasElement,
    v as unknown as HTMLVideoElement,
  );
  // the success path draws; that branch is not what these tests are about
  (eng as unknown as { drawFrame: (t: number) => void }).drawFrame = () => {};
  return eng;
}

test("a stalled video rejects instead of hanging forever", async () => {
  const v = fakeVideo({ readyState: 0, networkState: 2 });
  const eng = engine(v);
  await assert.rejects(
    // 30ms stands in for the 15s default
    () => eng.loadVideo("/api/take/video", 30),
    (err: Error) => {
      assert.match(err.message, /stalled/);
      // the diagnosis has to name the state, or it is just a different dead end
      assert.match(err.message, /readyState 0/);
      assert.match(err.message, /networkState 2/);
      assert.match(err.message, /\/api\/take\/video/);
      return true;
    },
  );
  assert.equal(v.loadCalls, 1);
});

test("an error event rejects with a decoded MediaError, not 'failed to load'", async () => {
  const v = fakeVideo();
  const eng = engine(v);
  const p = eng.loadVideo("/api/take/video", 5_000);
  v.error = { code: 4, message: "" };
  v.fire("error");
  await assert.rejects(p, (err: Error) => {
    assert.match(err.message, /source not supported/);
    return true;
  });
});

test("settling once detaches both listeners (no leak, no double-settle)", async () => {
  const v = fakeVideo();
  const eng = engine(v);
  const p = eng.loadVideo("/api/take/video", 20);
  await assert.rejects(p, /stalled/);
  assert.equal(v.count("loadeddata"), 0);
  assert.equal(v.count("error"), 0);
  // a late event now goes nowhere rather than settling an already-settled promise
  v.fire("loadeddata");
  v.fire("error");
});

test("a video that becomes readable resolves, and the stall timer stops mattering", async () => {
  const v = fakeVideo({ readyState: 4, networkState: 1 });
  v.duration = 12.5;
  const eng = engine(v);
  const p = eng.loadVideo("/api/take/video", 40);
  v.fire("loadeddata");
  await p; // resolves
  assert.equal(v.count("loadeddata"), 0);
  // outlive the stall window: a surviving timer would reject an already-resolved
  // promise (harmless) or, worse, fire after the engine was disposed
  await new Promise((r) => setTimeout(r, 60));
});
