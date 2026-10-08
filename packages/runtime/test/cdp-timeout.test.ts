// CDP requests never wait forever: a per-request budget, and every pending
// request rejected when the connection closes or the page crashes. Run against
// a fake DevTools endpoint (a bare WebSocket server, no Chrome) whose commands
// can be told to never answer.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type Browser, CDP, CdpError, cdpTimeoutFor, isCdpStall } from "../src/cdp";
import { type DomStateRaw, finalizeDomStates, measureStateDirs } from "../src/dom-state";

type Msg = { id: number; method: string; params: Record<string, unknown> };
/** how the fake answers one command: a result, nothing (null), or by hand */
type Policy = (m: Msg, send: (o: unknown) => void, sock: Socket) => unknown | null;

// --- a minimal WebSocket server (RFC 6455 text frames, enough for CDP) -------

function frame(text: string): Buffer {
  const body = Buffer.from(text);
  const n = body.length;
  const head =
    n < 126
      ? Buffer.from([0x81, n])
      : n < 65536
        ? Buffer.from([0x81, 126, n >> 8, n & 255])
        : (() => {
            const h = Buffer.alloc(10);
            h[0] = 0x81;
            h[1] = 127;
            h.writeBigUInt64BE(BigInt(n), 2);
            return h;
          })();
  return Buffer.concat([head, body]);
}

/** decode the client's (masked) frames from `buf`; returns texts + the rest */
function unframe(buf: Buffer): { texts: string[]; rest: Buffer; close: boolean } {
  const texts: string[] = [];
  let close = false;
  for (;;) {
    if (buf.length < 2) break;
    const op = buf[0]! & 0x0f;
    let len = buf[1]! & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      len = Number(buf.readBigUInt64BE(2));
      off = 10;
    }
    const masked = (buf[1]! & 0x80) !== 0;
    const maskAt = off;
    if (masked) off += 4;
    if (buf.length < off + len) break;
    const data = Buffer.from(buf.subarray(off, off + len));
    if (masked) for (let i = 0; i < len; i++) data[i]! ^= buf[maskAt + (i % 4)]!;
    if (op === 1) texts.push(data.toString("utf8"));
    if (op === 8) close = true;
    buf = buf.subarray(off + len);
  }
  return { texts, rest: buf, close };
}

/** A fake DevTools endpoint: each path gets its own policy. */
function fakeDevtools(policies: (path: string) => Policy): Promise<{
  server: Server;
  port: number;
  seen: { path: string; method: string }[];
}> {
  const seen: { path: string; method: string }[] = [];
  const server = createServer((_q, r) => r.writeHead(404).end());
  server.on("upgrade", (req, sock: Socket) => {
    const key = req.headers["sec-websocket-key"] as string;
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    sock.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const path = req.url ?? "/";
    const policy = policies(path);
    const send = (o: unknown) => {
      if (!sock.destroyed) sock.write(frame(JSON.stringify(o)));
    };
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      const r = unframe(Buffer.concat([buf, d]));
      buf = r.rest;
      for (const t of r.texts) {
        const m = JSON.parse(t) as Msg;
        seen.push({ path, method: m.method });
        const result = policy(m, send, sock);
        if (result !== null) send({ id: m.id, result });
      }
      if (r.close) sock.end();
    });
    sock.on("error", () => {});
  });
  return new Promise((res) =>
    server.listen(0, "127.0.0.1", () =>
      res({ server, port: (server.address() as AddressInfo).port, seen }),
    ),
  );
}

let fake: Awaited<ReturnType<typeof fakeDevtools>>;
let fakeSetupStall = false;
before(async () => {
  fake = await fakeDevtools((path) => {
    if (path.startsWith("/devtools/browser"))
      return (m) =>
        m.method === "Target.createTarget" ? { targetId: `t${fake.seen.length}` } : {};
    if (path.startsWith("/devtools/page/")) {
      // a fidelity page whose navigation never answers (a stuck renderer) —
      // or, with fakeSetupStall, one that never answers its set-up
      return (m) =>
        m.method === "Page.navigate" || (fakeSetupStall && m.method === "Page.enable") ? null : {};
    }
    return (m, send, sock) => {
      switch (m.method) {
        case "Never":
          return null;
        case "Late":
          setTimeout(() => send({ id: m.id, result: { late: true } }), 150);
          return null;
        case "Fail":
          send({ id: m.id, error: { code: -32000, message: "nope" } });
          return null;
        case "Crash":
          send({ method: "Inspector.targetCrashed", params: {} });
          return null;
        case "Drop":
          sock.destroy();
          return null;
        default:
          return { echo: m.method, params: m.params };
      }
    };
  });
});
after(() => {
  fake.server.closeAllConnections();
  fake.server.close();
});

const url = (path = "/test") => `ws://127.0.0.1:${fake.port}${path}`;

test("the default budget: ordinary 30 s, the slow commands and awaited evaluates 120 s", () => {
  const saved = process.env.OPEN_TAKE_CDP_TIMEOUT_MS;
  delete process.env.OPEN_TAKE_CDP_TIMEOUT_MS;
  try {
    assert.equal(cdpTimeoutFor("Page.enable", {}), 30_000);
    assert.equal(cdpTimeoutFor("Runtime.evaluate", { expression: "1" }), 30_000);
    assert.equal(cdpTimeoutFor("Runtime.evaluate", { awaitPromise: true }), 120_000);
    assert.equal(cdpTimeoutFor("Page.captureScreenshot", {}), 120_000);
    assert.equal(cdpTimeoutFor("Page.captureSnapshot", {}), 120_000);
    assert.equal(cdpTimeoutFor("Page.navigate", {}), 120_000);
    // a connection's own base, then the env, scale both
    assert.equal(cdpTimeoutFor("Page.enable", {}, 500), 500);
    assert.equal(cdpTimeoutFor("Page.captureScreenshot", {}, 500), 2000);
    process.env.OPEN_TAKE_CDP_TIMEOUT_MS = "250";
    assert.equal(cdpTimeoutFor("Page.enable", {}), 250);
    assert.equal(cdpTimeoutFor("Page.captureSnapshot", {}), 1000);
  } finally {
    if (saved == null) delete process.env.OPEN_TAKE_CDP_TIMEOUT_MS;
    else process.env.OPEN_TAKE_CDP_TIMEOUT_MS = saved;
  }
});

test("answers and error answers still arrive as before", async () => {
  const cdp = await CDP.connect(url());
  try {
    assert.deepEqual(await cdp.send("Echo", { a: 1 }), { echo: "Echo", params: { a: 1 } });
    await assert.rejects(cdp.send("Fail"), (e: Error) => {
      assert.ok(!isCdpStall(e), "a protocol error is an answer, not a stall");
      return /nope/.test(e.message);
    });
    assert.equal(cdp.waiting, 0);
  } finally {
    cdp.close();
  }
});

test("a command that is never answered times out (per call), and the connection goes on", async () => {
  const cdp = await CDP.connect(url());
  try {
    const t0 = Date.now();
    await assert.rejects(cdp.send("Never", {}, { timeoutMs: 120 }), (e: unknown) => {
      assert.ok(e instanceof CdpError);
      assert.equal(e.reason, "timeout");
      assert.equal(e.method, "Never");
      assert.match(e.message, /Never: no answer within 0\.1 s/);
      return true;
    });
    const took = Date.now() - t0;
    assert.ok(took >= 100 && took < 2000, `timed out after ${took} ms`);
    assert.equal(cdp.waiting, 0);
    // an answer after its timeout is dropped; the next request is unaffected
    await assert.rejects(cdp.send("Late", {}, { timeoutMs: 40 }), isCdpStall);
    assert.deepEqual(await cdp.send("Echo"), { echo: "Echo", params: {} });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(cdp.waiting, 0);
  } finally {
    cdp.close();
  }
});

test("the connection's own budget and the env budget apply when a call names none", async () => {
  const cdp = await CDP.connect(url(), { timeoutMs: 80 });
  try {
    await assert.rejects(cdp.send("Never"), (e: CdpError) => e.reason === "timeout");
    // a per-call budget still wins
    assert.deepEqual(await cdp.send("Late", {}, { timeoutMs: 2000 }), { late: true });
  } finally {
    cdp.close();
  }
  const saved = process.env.OPEN_TAKE_CDP_TIMEOUT_MS;
  process.env.OPEN_TAKE_CDP_TIMEOUT_MS = "80";
  const c2 = await CDP.connect(url());
  try {
    await assert.rejects(c2.send("Never"), (e: CdpError) => e.reason === "timeout");
  } finally {
    c2.close();
    if (saved == null) delete process.env.OPEN_TAKE_CDP_TIMEOUT_MS;
    else process.env.OPEN_TAKE_CDP_TIMEOUT_MS = saved;
  }
});

test("close() rejects every pending request at once, and later sends fail at once", async () => {
  const cdp = await CDP.connect(url());
  const a = cdp.send("Never", {}, { timeoutMs: 0 }); // no budget: only close ends it
  const b = cdp.send("Never");
  assert.equal(cdp.waiting, 2);
  cdp.close();
  await assert.rejects(
    a,
    (e: CdpError) => e.reason === "closed" && /Never: .*closed/.test(e.message),
  );
  await assert.rejects(b, (e: CdpError) => e.reason === "closed");
  assert.equal(cdp.waiting, 0);
  assert.ok(cdp.closed);
  await assert.rejects(cdp.send("Echo"), (e: CdpError) => e.reason === "closed");
});

test("the other end going away rejects what was pending", async () => {
  const cdp = await CDP.connect(url());
  const pending = cdp.send("Never", {}, { timeoutMs: 0 });
  const drop = cdp.send("Drop", {}, { timeoutMs: 0 });
  await assert.rejects(pending, (e: CdpError) => e.reason === "closed");
  await assert.rejects(drop, (e: CdpError) => e.reason === "closed");
  assert.ok(cdp.closed);
  await assert.rejects(cdp.send("Echo"), (e: CdpError) => e.reason === "closed");
});

test("a crashed page rejects what was pending; the connection itself stays open", async () => {
  const cdp = await CDP.connect(url());
  try {
    let crashed = false;
    cdp.on("Inspector.targetCrashed", () => {
      crashed = true;
    });
    const waiting = cdp.send("Never", {}, { timeoutMs: 0 });
    void cdp.send("Crash", {}, { timeoutMs: 0 }).catch(() => {});
    await assert.rejects(
      waiting,
      (e: CdpError) => e.reason === "crashed" && /crashed/.test(e.message),
    );
    assert.ok(crashed, "the event still reaches its handler");
    assert.deepEqual(await cdp.send("Echo"), { echo: "Echo", params: {} });
  } finally {
    cdp.close();
  }
});

test("connect to an endpoint that is not there fails instead of waiting", async () => {
  await assert.rejects(CDP.connect("ws://127.0.0.1:1/devtools/page/x"), /CDP connect failed/);
});

test("measureStateDirs: a saved screen whose page never answers is reported, the page is replaced, the run ends", async () => {
  const saved = process.env.OPEN_TAKE_CDP_TIMEOUT_MS;
  process.env.OPEN_TAKE_CDP_TIMEOUT_MS = "60"; // a navigation waits 4× = 240 ms
  const root = mkdtempSync(join(tmpdir(), "open-take-cdp-timeout-"));
  const browserCdp = await CDP.connect(url("/devtools/browser/b"));
  try {
    const dirs = ["a", "b"].map((id) => {
      const dir = join(root, "states", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "state.html"), "<!doctype html><p>x</p>");
      writeFileSync(
        join(dir, "index.json"),
        JSON.stringify({
          version: 1,
          id,
          url: "http://x",
          title: "x",
          tMs: 0,
          viewport: { w: 320, h: 200 },
          scroll: { x: 0, y: 0 },
          elements: [],
          layers: [],
        }),
      );
      return dir;
    });
    const browser: Browser = {
      cdp: browserCdp,
      targetId: "b",
      port: fake.port,
      close: async () => {},
    };
    const before = fake.seen.length;
    const t0 = Date.now();
    const r = await measureStateDirs({ browser, dirs, pictures: false });
    const took = Date.now() - t0;
    assert.equal(r.measured.length, 0);
    assert.deepEqual(
      r.failed.map((f) => f.dir),
      dirs,
    );
    for (const f of r.failed) assert.match(f.why, /Page\.navigate: no answer within/);
    const mine = fake.seen.slice(before);
    // one fresh page per screen: the stuck one is closed, not reused
    assert.equal(mine.filter((s) => s.method === "Target.createTarget").length, 2);
    assert.equal(mine.filter((s) => s.method === "Target.closeTarget").length, 2);
    assert.ok(took < 5000, `the run took ${took} ms`);
  } finally {
    browserCdp.close();
    rmSync(root, { recursive: true, force: true });
    if (saved == null) delete process.env.OPEN_TAKE_CDP_TIMEOUT_MS;
    else process.env.OPEN_TAKE_CDP_TIMEOUT_MS = saved;
  }
});

test("finalizeDomStates: two checks in a row that never answer end the checks; every state is still reported, the take goes on", async () => {
  const saved = process.env.OPEN_TAKE_CDP_TIMEOUT_MS;
  process.env.OPEN_TAKE_CDP_TIMEOUT_MS = "60";
  const root = mkdtempSync(join(tmpdir(), "open-take-cdp-finalize-"));
  const browserCdp = await CDP.connect(url("/devtools/browser/b"));
  const errors: string[] = [];
  const consoleError = console.error;
  console.error = (l: string) => errors.push(l);
  try {
    const statesDir = join(root, "states");
    const B = "----b----";
    const mhtml = [
      "From: <Saved by Blink>",
      "Snapshot-Content-Location: http://app.test/",
      "MIME-Version: 1.0",
      `Content-Type: multipart/related; type="text/html"; boundary="${B}"`,
      "",
      `--${B}`,
      "Content-Type: text/html",
      "Content-ID: <frame-main@mhtml.blink>",
      "Content-Location: http://app.test/",
      "",
      "<html><head></head><body><p>x</p></body></html>",
      `--${B}--`,
      "",
    ].join("\r\n");
    const states: DomStateRaw[] = ["s0", "s1", "s2"].map((id) => {
      const dir = join(statesDir, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "page.mhtml"), mhtml);
      return {
        id,
        tMs: 0,
        dir,
        ms: 0,
        probe: {
          url: "http://app.test/",
          title: "t",
          viewport: { w: 320, h: 200, dpr: 1 },
          scroll: { x: 0, y: 0 },
          elements: [],
          layers: [],
          scrolled: [],
          inputs: [],
          canvases: [],
          videos: [],
          animated: [],
          custom: [],
        },
      };
    });
    const browser: Browser = {
      cdp: browserCdp,
      targetId: "b",
      port: fake.port,
      close: async () => {},
    };
    const before = fake.seen.length;
    const t0 = Date.now();
    const items = await finalizeDomStates({ browser, statesDir, states, vw: 320, vh: 200 });
    const took = Date.now() - t0;
    assert.deepEqual(
      items.map((i) => i.id),
      ["s0", "s1", "s2"],
    );
    for (const i of items) assert.equal(i.fidelity?.ok, false);
    const mine = fake.seen.slice(before);
    // s0 and s1 each stall on a fresh page; s2 is not tried
    assert.equal(mine.filter((s) => s.method === "Target.createTarget").length, 2);
    assert.equal(mine.filter((s) => s.method === "Target.closeTarget").length, 2);
    assert.ok(
      errors.some((l) => /two checks in a row/.test(l)),
      errors.join("\n"),
    );
    assert.ok(took < 5000, `finalize took ${took} ms`);
  } finally {
    console.error = consoleError;
    browserCdp.close();
    rmSync(root, { recursive: true, force: true });
    if (saved == null) delete process.env.OPEN_TAKE_CDP_TIMEOUT_MS;
    else process.env.OPEN_TAKE_CDP_TIMEOUT_MS = saved;
  }
});

test("a page that cannot be set up is closed, not left behind the error", async () => {
  const saved = process.env.OPEN_TAKE_CDP_TIMEOUT_MS;
  process.env.OPEN_TAKE_CDP_TIMEOUT_MS = "60";
  const root = mkdtempSync(join(tmpdir(), "open-take-cdp-setup-"));
  const browserCdp = await CDP.connect(url("/devtools/browser/b"));
  try {
    const dir = join(root, "states", "a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.html"), "<!doctype html><p>x</p>");
    writeFileSync(
      join(dir, "index.json"),
      JSON.stringify({
        version: 1,
        id: "a",
        url: "http://x",
        title: "x",
        tMs: 0,
        viewport: { w: 320, h: 200 },
        scroll: { x: 0, y: 0 },
        elements: [],
        layers: [],
      }),
    );
    const before = fake.seen.length;
    const browser: Browser = {
      cdp: browserCdp,
      targetId: "b",
      port: fake.port,
      close: async () => {},
    };
    fakeSetupStall = true; // the fake's pages never answer Page.enable
    const r = await measureStateDirs({ browser, dirs: [dir], pictures: false });
    assert.equal(r.failed.length, 1);
    assert.match(r.failed[0]!.why, /Page\.enable: no answer within/);
    const mine = fake.seen.slice(before);
    assert.equal(mine.filter((s) => s.method === "Target.createTarget").length, 1);
    assert.equal(mine.filter((s) => s.method === "Target.closeTarget").length, 1);
  } finally {
    fakeSetupStall = false;
    browserCdp.close();
    rmSync(root, { recursive: true, force: true });
    if (saved == null) delete process.env.OPEN_TAKE_CDP_TIMEOUT_MS;
    else process.env.OPEN_TAKE_CDP_TIMEOUT_MS = saved;
  }
});
