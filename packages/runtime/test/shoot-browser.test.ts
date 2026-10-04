// `open-take shoot` against real Chrome: a served page with a button, a text
// field and a range slider, shot by a script the way a film's author writes
// one. What the film page reads back must be what happened — stills at twice
// the viewport, the cursor where the mouse was, every tracked box in page px,
// one still per keystroke and per drag step when asked — and the native exits
// (raw CDP, the browser's endpoint, a hook that runs before the page's own
// scripts) must reach the same browser. Skips without Chrome for Testing.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveChrome } from "../src/cdp";
import { runShoot, type ShootLog, type ShootOpts } from "../src/shoot";

const chrome = process.env.OPEN_TAKE_E2E_CHROME ?? resolveChrome();
const skip = chrome ? false : "no Chrome for Testing";
const VW = 800;
const VH = 600;

// box-sizing keeps every box exactly what the CSS says, so the test can name it
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>shoot fixture</title>
<script>window.__seenHook = window.__hook === 42;</script>
<style>
*{box-sizing:border-box}
body{margin:0;font:16px Arial,sans-serif;background:#fff}
#go{position:absolute;left:100px;top:80px;width:120px;height:40px}
#q{position:absolute;left:100px;top:160px;width:300px;height:30px;font-size:16px}
#vol{position:absolute;left:100px;top:240px;width:400px;height:20px;margin:0}
#out{position:absolute;left:100px;top:300px;margin:0}
#far{position:absolute;left:100px;top:1500px;width:100px;height:40px}
#tall{height:3000px}
</style></head><body>
<button id="go">Go</button>
<input id="q" placeholder="Search">
<input id="vol" type="range" min="0" max="100" value="50">
<p id="out">clicks: 0</p>
<button id="far">Far</button>
<div id="tall"></div>
<script>
let n = 0;
document.getElementById("go").addEventListener("click", () => {
  document.getElementById("out").textContent = "clicks: " + ++n;
});
</script>
</body></html>`;

// content at once, an input handler (on an element deep in the page) only
// 2.3 s later: past the settle probe's timer horizon (2 s), so only a check
// for the handlers themselves waits for it
const LATE = `<!doctype html><html><body><main><h1 id="title">Late</h1><a href="/next" id="next">Next</a></main>
<script>setTimeout(() => { window.__hydrated = true; document.getElementById("title").addEventListener("click", () => {}); }, 2300);</script>
</body></html>`;
const NEXT = `<!doctype html><html><body><h1>Next page</h1></body></html>`;
const BLANK = `<!doctype html><html><body><div id="root"></div><script>/* the app never mounts */</script></body></html>`;

async function serve(): Promise<{ server: Server; url: string }> {
  const pages: Record<string, string> = {
    "/": PAGE,
    "/late": LATE,
    "/next": NEXT,
    "/blank": BLANK,
  };
  const server = createServer((req, res) => {
    const html = pages[req.url ?? "/"];
    if (html == null) return res.writeHead(404).end();
    // the page a link leads to answers slowly: an action must wait for it,
    // not read the quiet page it is leaving
    const delay = req.url === "/next" ? 700 : 0;
    setTimeout(
      () => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html),
      delay,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` };
}

/** width × height from a PNG's IHDR chunk */
function pngSize(file: string): [number, number] {
  const b = readFileSync(file);
  assert.equal(b.toString("latin1", 1, 4), "PNG", `${file} is a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

/** the page targets a browser-level endpoint lists */
async function browserPages(ws: string): Promise<string[]> {
  const sock = new WebSocket(ws);
  await new Promise((ok, fail) => {
    sock.addEventListener("open", ok);
    sock.addEventListener("error", fail);
  });
  const reply = new Promise<{ result: { targetInfos: { type: string; url: string }[] } }>((ok) =>
    sock.addEventListener("message", (e) => ok(JSON.parse(String(e.data)))),
  );
  sock.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
  const { result } = await reply;
  sock.close();
  return result.targetInfos.filter((t) => t.type === "page").map((t) => t.url);
}

const base = (outDir: string): Omit<ShootOpts, "script"> => ({
  chromePath: chrome!,
  outDir,
  width: VW,
  height: VH,
  scale: 2,
  onNote: () => {},
});

test("shoot: 2× stills with the cursor and every tracked box, a still per keystroke and per drag step", {
  skip,
  timeout: 120000,
}, async () => {
  const { server, url } = await serve();
  const out = await mkdtemp(join(tmpdir(), "open-take-shoot-"));
  const seen: Record<string, unknown> = {};
  try {
    const { log, path } = await runShoot({
      ...base(out),
      script: async (s) => {
        await s.open(url, { ready: "#go" });
        await s.track("#out");
        await s.still("home");
        await s.click("text=Go", { name: "go" });
        await s.type("#q", "abc", { each: true, name: "q" });
        await s.drag("#vol", { dx: 100 }, { every: 25, name: "vol" });
        seen.out = await s.evaluate("document.getElementById('out').textContent");
        seen.q = await s.evaluate("document.getElementById('q').value");
        seen.vol = await s.evaluate("Number(document.getElementById('vol').value)");
      },
    });

    // the shoot did what the stills say it did
    assert.equal(seen.out, "clicks: 1", "the click was a real one");
    assert.equal(seen.q, "abc");
    assert.ok(
      (seen.vol as number) > 65 && (seen.vol as number) < 85,
      `the slider followed a 100 px drag from its middle (value ${seen.vol})`,
    );

    // shots.json on disk is the log
    assert.equal(path, join(out, "shots.json"));
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), log);
    assert.deepEqual(log.viewport, { w: VW, h: VH });
    assert.equal(log.scale, 2);
    assert.deepEqual(
      log.stills.map((s) => s.name),
      ["home", "go", "q-1", "q-2", "q-3", "q", "vol-1", "vol-2", "vol-3", "vol-4", "vol"],
      "one still per keystroke and per 25 px of drag, then each action's own",
    );
    log.stills.forEach((s, i) => {
      assert.equal(s.file, `${String(i).padStart(3, "0")}-${s.name}.png`);
      assert.deepEqual(
        pngSize(join(out, s.file)),
        [VW * 2, VH * 2],
        `${s.file} is 2× the viewport`,
      );
      assert.deepEqual(s.scroll, { x: 0, y: 0 });
      if (i > 0) assert.ok(s.t >= log.stills[i - 1]!.t, "t only goes forward");
    });
    const at = (name: string) => log.stills.find((s) => s.name === name)!;

    // before any action: the resting cursor, and only what was tracked
    assert.deepEqual(at("home").cursor, { x: VW * 0.25, y: VH * 0.9 });
    assert.deepEqual(Object.keys(at("home").boxes), ["#out"]);
    assert.equal(at("home").boxes["#out"]!.x, 100);
    assert.equal(at("home").boxes["#out"]!.y, 300);
    assert.equal(at("home").action, undefined);

    // the click: the cursor on the button's centre, and the button's box recorded
    assert.deepEqual(at("go").cursor, { x: 160, y: 100 });
    assert.deepEqual(at("go").boxes["text=Go"], { x: 100, y: 80, width: 120, height: 40 });
    assert.equal(at("go").action, "click");

    // typing: the cursor stays on the field it clicked into; each key a new picture
    for (const name of ["q-1", "q-2", "q-3", "q"]) {
      assert.deepEqual(at(name).cursor, { x: 250, y: 175 }, name);
      assert.equal(at(name).action, "type");
      assert.deepEqual(at(name).boxes["#q"], { x: 100, y: 160, width: 300, height: 30 });
    }
    assert.notDeepEqual(
      readFileSync(join(out, at("q-1").file)),
      readFileSync(join(out, at("q-3").file)),
      "the keystroke stills show the text growing",
    );

    // dragging: one still every 25 px with the button held, then the release
    [325, 350, 375, 400].forEach((x, i) => {
      const s = at(`vol-${i + 1}`);
      assert.deepEqual(s.cursor, { x, y: 250 }, s.name);
      assert.equal(s.down, true, `${s.name} has the button held`);
      assert.equal(s.action, "drag");
    });
    assert.deepEqual(at("vol").cursor, { x: 400, y: 250 });
    assert.equal(at("vol").down, undefined, "released");
    assert.deepEqual(at("vol").boxes["#vol"], { x: 100, y: 240, width: 400, height: 20 });
    assert.deepEqual(Object.keys(at("vol").boxes).sort(), ["#out", "#q", "#vol", "text=Go"]);
  } finally {
    server.close();
    await rm(out, { recursive: true, force: true });
  }
});

test("shoot: boxes and the cursor are page px — a scrolled still moves its origin, not the boxes", {
  skip,
  timeout: 60000,
}, async () => {
  const { server, url } = await serve();
  const out = await mkdtemp(join(tmpdir(), "open-take-shoot-"));
  try {
    const { log } = await runShoot({
      ...base(out),
      script: async (s) => {
        await s.open(url);
        await s.track("#out");
        await s.click("#far", { name: "far" }); // below the fold: scrolled into view first
      },
    });
    const far = log.stills[0]!;
    // centred: the button's middle (y 1520) at the viewport's middle (300)
    assert.deepEqual(far.scroll, { x: 0, y: 1220 });
    assert.deepEqual(far.boxes["#far"], { x: 100, y: 1500, width: 100, height: 40 });
    assert.deepEqual(far.cursor, { x: 150, y: 1520 });
    assert.equal(far.boxes["#out"]!.y, 300, "a tracked box stays where it is on the page");
  } finally {
    server.close();
    await rm(out, { recursive: true, force: true });
  }
});

test("shoot: s.cdp and s.wsEndpoint reach the same browser, and s.inject runs before the page's scripts", {
  skip,
  timeout: 60000,
}, async () => {
  const { server, url } = await serve();
  const out = await mkdtemp(join(tmpdir(), "open-take-shoot-"));
  const seen: Record<string, unknown> = {};
  try {
    await runShoot({
      ...base(out),
      script: async (s) => {
        await s.inject("window.__hook = 42");
        await s.open(url);
        seen.hook = await s.evaluate(
          () => (window as unknown as { __seenHook: boolean }).__seenHook,
        );
        const r = await s.cdp.send<{ result: { value: number } }>("Runtime.evaluate", {
          expression: "6 * 7",
          returnByValue: true,
        });
        seen.cdp = r.result.value;
        // a move made over the raw session is still where the logged cursor is
        await s.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: 33,
          y: 44,
          button: "none",
        });
        seen.raw = (await s.still("raw")).cursor;
        seen.ws = s.wsEndpoint;
        seen.pages = await browserPages(s.wsEndpoint);
      },
    });
    assert.equal(seen.hook, true, "the hook was there before the page's first script ran");
    assert.equal(seen.cdp, 42);
    assert.deepEqual(seen.raw, { x: 33, y: 44 });
    assert.match(seen.ws as string, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);
    assert.ok((seen.pages as string[]).includes(url), "the endpoint's browser holds the shot page");
  } finally {
    server.close();
    await rm(out, { recursive: true, force: true });
  }
});

test("shoot: a script that throws fails with its own message; the last good shoot stays", {
  skip,
  timeout: 60000,
}, async () => {
  const { server, url } = await serve();
  const out = await mkdtemp(join(tmpdir(), "open-take-shoot-"));
  try {
    // a good shoot first
    await runShoot({
      ...base(out),
      script: async (s) => {
        await s.open(url);
        await s.still("keep");
      },
    });
    const script = join(out, "broken.mjs");
    await writeFile(
      script,
      `export default async (s) => {\n` +
        `  await s.open(${JSON.stringify(url)});\n` +
        `  await s.still("before");\n` +
        `  throw new Error("the script broke on purpose");\n` +
        `};\n`,
    );
    await assert.rejects(
      runShoot({ ...base(out), script }),
      (e: Error) =>
        /the script broke on purpose/.test(e.message) && /broken\.mjs:4/.test(e.message),
    );
    // the film page still reads the good shoot …
    const kept = JSON.parse(readFileSync(join(out, "shots.json"), "utf8")) as ShootLog;
    assert.deepEqual(
      kept.stills.map((s) => s.name),
      ["keep"],
    );
    assert.ok(existsSync(join(out, kept.stills[0]!.file)));
    // … and what the failed one took is kept aside, with why it stopped
    const partial = JSON.parse(readFileSync(join(out, ".shoot", "shots.json"), "utf8")) as ShootLog;
    assert.deepEqual(
      partial.stills.map((s) => s.name),
      ["before"],
    );
    assert.match(partial.error ?? "", /the script broke on purpose/);
    assert.ok(existsSync(join(out, ".shoot", partial.stills[0]!.file)));

    const empty = join(out, "empty.mjs");
    await writeFile(empty, "export const nothing = 1;\n");
    await assert.rejects(runShoot({ ...base(out), script: empty }), /default export/);
  } finally {
    server.close();
    await rm(out, { recursive: true, force: true });
  }
});

test("shoot: s.open waits for a page that hydrates late, follows a link, refuses a blank or dead page", {
  skip,
  timeout: 90000,
}, async () => {
  const { server, url } = await serve();
  const out = await mkdtemp(join(tmpdir(), "open-take-shoot-"));
  const seen: Record<string, unknown> = {};
  try {
    await runShoot({
      ...base(out),
      script: async (s) => {
        await s.open(`${url}late`);
        seen.hydrated = await s.evaluate("window.__hydrated === true");
        await s.click("text=Next", { name: "next" });
        seen.path = await s.evaluate("location.pathname");
        seen.ready = await s.evaluate("document.readyState");
      },
    });
    assert.equal(seen.hydrated, true, "open returned only once the page had its input handlers");
    assert.equal(seen.path, "/next", "a click that navigates returns on the new page");
    assert.equal(seen.ready, "complete");

    await assert.rejects(
      runShoot({
        ...base(out),
        script: async (s) => {
          await s.open(`${url}blank`, { timeoutMs: 1500 });
        },
      }),
      /shows nothing/,
    );
    await assert.rejects(
      runShoot({
        ...base(out),
        script: async (s) => {
          await s.open("http://127.0.0.1:9/");
        },
      }),
      /did not answer/,
    );
  } finally {
    server.close();
    await rm(out, { recursive: true, force: true });
  }
});
