// `open-take shoot` against real Chrome: a served page with a button, a text
// field and a range slider, shot by a script the way a film's author writes
// one. What the film page reads back must be what happened — stills at twice
// the viewport, the cursor where the mouse was, every tracked box in page px,
// one still per keystroke and per drag step when asked — and the native exits
// (raw CDP, the browser's endpoint, a hook that runs before the page's own
// scripts) must reach the same browser. Skips without Chrome for Testing.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { resolveFfmpeg } from "@open-take/compositor";
import { resolveChrome } from "../src/cdp";
import { replaceShoot, runShoot, type ShootLog, type ShootOpts, shootHome } from "../src/shoot";

const exec = promisify(execFile);

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
// a tall page: red at its top, blue a screen further down
const TALL = `<!doctype html><html><body style="margin:0;height:3000px;background:#fff">
<div style="position:absolute;left:0;top:0;width:400px;height:200px;background:#f00;color:#f00">top</div>
<div style="position:absolute;left:0;top:1000px;width:400px;height:200px;background:#00f;color:#00f">down</div></body></html>`;
// a total that counts up from 0 over 1.5 s every time it changes, as a
// product's own animated figure does: on the button, to 2,705; on the slider,
// to its value × 113 — longer than the activity settle's budget (1.2 s)
const COUNT = `<!doctype html><html><head><style>
body{margin:0;font:16px Arial,sans-serif}
#total{position:absolute;left:100px;top:40px;margin:0;font-size:40px}
#calc{position:absolute;left:100px;top:120px;width:120px;height:40px}
#months{position:absolute;left:100px;top:200px;width:480px;height:20px;margin:0}
</style></head><body>
<p id="total">0</p><button id="calc">Calculate</button>
<input id="months" type="range" min="0" max="24" value="0">
<script>
const el = document.getElementById("total");
let raf = 0;
function countTo(v) {
  cancelAnimationFrame(raf);
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / 1500);
    el.textContent = Math.round(v * p).toLocaleString("en-US");
    if (p < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}
document.getElementById("calc").addEventListener("click", () => countTo(2705));
document.getElementById("months").addEventListener("input", (e) => countTo(Number(e.target.value) * 113));
</script></body></html>`;
// a counter that never holds still (a ticker), beside a field to type into
const TICK = `<!doctype html><html><head><title>tick</title></head><body style="margin:0;font:16px Arial,sans-serif">
<p id="n" style="position:absolute;left:100px;top:40px;margin:0">0</p>
<input id="q" style="position:absolute;left:100px;top:120px;width:300px;height:30px">
<script>let i = 0; setInterval(() => { document.getElementById("n").textContent = String(++i); }, 30);</script>
</body></html>`;
// a shell that listens at once and says "Loading…", its app arriving as a
// script fetched after the load event, 2.5 s later: no mutation, no fetch, no
// timer in between — only the request itself says the page is not there yet
const SLOW = `<!doctype html><html><body><p id="wait">Loading…</p><div id="root"></div>
<script>document.addEventListener("click", () => {});
addEventListener("load", () => { const s = document.createElement("script"); s.src = "/slow.js"; document.head.append(s); });</script>
</body></html>`;
const SLOW_JS = `document.getElementById("root").innerHTML = '<h1 id="mounted">The app</h1><button>Make</button>';
document.getElementById("wait").remove();`;
// a page that makes things: a styled SVG, a drawn canvas, an image, a field
// with a result, a result panel, and an export button that downloads a file
const MAKES = `<!doctype html><html><head><style>.blob{fill:rgb(200,30,90)}#panel{width:200px;height:80px;background:#123;color:#fff}</style></head><body>
<svg id="shape" width="120" height="100"><path class="blob" d="M10 50 Q60 0 110 50 T10 50Z"/></svg>
<canvas id="cv" width="60" height="40"></canvas>
<img id="pic" src="/pic.svg" width="40" height="40">
<textarea id="out">sha256: 3f2a…</textarea>
<div id="panel">Saved 42%</div>
<button id="export">Export</button>
<script>const g = document.getElementById("cv").getContext("2d"); g.fillStyle = "#0a0"; g.fillRect(0, 0, 60, 40);
document.getElementById("export").addEventListener("click", () => {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["<svg>made</svg>"], { type: "image/svg+xml" }));
  a.download = "shape.svg"; document.body.append(a); a.click();
});</script></body></html>`;
const PIC = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#00f"/></svg>`;
const BLANK = `<!doctype html><html><body><div id="root"></div><script>/* the app never mounts */</script></body></html>`;
// a button disabled by its fieldset (its own .disabled stays false), enabled later
const FIELDSET = `<!doctype html><html><body><fieldset id="fs" disabled><button id="b2">Go</button></fieldset><p id="n">0</p>
<script>setTimeout(() => { document.getElementById("fs").disabled = false; }, 1500);
document.getElementById("b2").addEventListener("click", () => { const n = document.getElementById("n"); n.textContent = String(+n.textContent + 1); });</script>
</body></html>`;

async function serve(): Promise<{ server: Server; url: string }> {
  const pages: Record<string, string> = {
    "/": PAGE,
    "/late": LATE,
    "/next": NEXT,
    "/blank": BLANK,
    "/fieldset": FIELDSET,
    "/tall": TALL,
    "/count": COUNT,
    "/tick": TICK,
    "/slow": SLOW,
    "/slow.js": SLOW_JS,
    "/makes": MAKES,
    "/pic.svg": PIC,
  };
  const server = createServer((req, res) => {
    const html = pages[req.url ?? "/"];
    if (html == null) return res.writeHead(404).end();
    // the page a link leads to answers slowly: an action must wait for it,
    // not read the quiet page it is leaving
    const delay = req.url === "/next" ? 700 : req.url === "/slow.js" ? 2500 : 0;
    const type = req.url?.endsWith(".js")
      ? "text/javascript"
      : req.url?.endsWith(".svg")
        ? "image/svg+xml"
        : "text/html; charset=utf-8";
    setTimeout(() => res.writeHead(200, { "content-type": type }).end(html), delay);
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

test("shoot: s.open waits for a page that hydrates late or is still arriving, follows a link, refuses a blank or dead page", {
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
        await s.open(`${url}slow`);
        seen.mounted = await s.evaluate(
          "!!document.getElementById('mounted') && !document.getElementById('wait')",
        );
      },
    });
    assert.equal(seen.mounted, true, "open waited for the app its shell was still fetching");
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

test("shoot: a new shoot that cannot be put in place leaves the last good one as it was", {
  skip,
  timeout: 60000,
}, async () => {
  const { server, url } = await serve();
  const out = await mkdtemp(join(tmpdir(), "open-take-shoot-"));
  try {
    await runShoot({
      ...base(out),
      script: async (s) => {
        await s.open(url);
        await s.still("keep");
      },
    });
    // something of the user's sits where the new still must go
    await mkdir(join(out, "000-new.png"));
    await writeFile(join(out, "000-new.png", "theirs.txt"), "not ours");
    await assert.rejects(
      runShoot({
        ...base(out),
        script: async (s) => {
          await s.open(url);
          await s.still("new");
        },
      }),
      /could not replace the last one/,
    );
    const kept = JSON.parse(readFileSync(join(out, "shots.json"), "utf8")) as ShootLog;
    assert.deepEqual(
      kept.stills.map((s) => s.name),
      ["keep"],
      "the last good log is back",
    );
    assert.ok(existsSync(join(out, kept.stills[0]!.file)), "and its still");
    assert.ok(existsSync(join(out, "000-new.png", "theirs.txt")), "what was there is untouched");
    const staged = JSON.parse(readFileSync(join(out, ".shoot", "shots.json"), "utf8")) as ShootLog;
    assert.deepEqual(
      staged.stills.map((s) => s.name),
      ["new"],
      "the new shoot is kept aside, whole",
    );
  } finally {
    server.close();
    await rm(out, { recursive: true, force: true });
  }
});

test("shoot: a last shoot that cannot all be moved aside is put back whole", {
  skip: skip || (process.platform !== "darwin" && "an immutable file is set with chflags"),
  timeout: 60000,
}, async () => {
  const { server, url } = await serve();
  const out = await mkdtemp(join(tmpdir(), "open-take-shoot-"));
  let locked = "";
  try {
    const last = await runShoot({
      ...base(out),
      script: async (s) => {
        await s.open(url);
        await s.still("a");
        await s.still("b");
      },
    });
    // its second still cannot be moved: the first is aside by then
    locked = join(out, last.log.stills[1]!.file);
    await exec("chflags", ["uchg", locked]);
    await assert.rejects(
      runShoot({
        ...base(out),
        script: async (s) => {
          await s.open(url);
          await s.still("new");
        },
      }),
      /could not replace the last one/,
    );
    const kept = JSON.parse(readFileSync(join(out, "shots.json"), "utf8")) as ShootLog;
    assert.deepEqual(
      kept.stills.map((s) => s.name),
      ["a", "b"],
    );
    for (const st of kept.stills)
      assert.ok(existsSync(join(out, st.file)), `${st.file} is back in place`);
    assert.ok(
      !(await readdir(out)).some((n) => n.startsWith(".shoot-previous")),
      "nothing is left aside",
    );
  } finally {
    server.close();
    if (locked) await exec("chflags", ["nouchg", locked]).catch(() => {});
    await rm(out, { recursive: true, force: true });
  }
});

test("shoot: a last shoot that cannot be put back stays aside, and the error says where", async () => {
  const out = await mkdtemp(join(tmpdir(), "open-take-shoot-"));
  try {
    const stage = join(out, ".shoot");
    await mkdir(stage);
    const log = (names: string[]) =>
      `${JSON.stringify({ viewport: { w: 800, h: 600 }, scale: 2, stills: names.map((file) => ({ file })) })}\n`;
    // the last shoot
    await writeFile(join(out, "000-a.png"), "old a");
    await writeFile(join(out, "shots.json"), log(["000-a.png"]));
    // the new one: a still of the same name, and one that cannot be placed
    await writeFile(join(stage, "000-a.png"), "new a");
    await writeFile(join(stage, "001-b.png"), "new b");
    await writeFile(join(stage, "shots.json"), log(["000-a.png", "001-b.png"]));
    await mkdir(join(out, "001-b.png"));
    await writeFile(join(out, "001-b.png", "theirs.txt"), "not ours");
    // and the old still cannot be put back
    const move = async (from: string, to: string) => {
      if (from.includes(".shoot-previous") && from.endsWith("000-a.png"))
        throw new Error("EIO: i/o error");
      await rename(from, to);
    };
    const err = await replaceShoot(out, stage, ["000-a.png", "001-b.png"], move).then(
      () => null,
      (e: Error) => e,
    );
    assert.ok(err, "it fails");
    const aside = (await readdir(out)).find((n) => n.startsWith(".shoot-previous"));
    assert.ok(aside, `the last shoot's still is kept aside: ${await readdir(out)}`);
    assert.equal(readFileSync(join(out, aside, "000-a.png"), "utf8"), "old a");
    assert.match(err.message, new RegExp(`${aside}.*000-a\\.png|000-a\\.png.*${aside}`));
    assert.doesNotMatch(err.message, /back in place/);
    assert.equal(
      readFileSync(join(out, "shots.json"), "utf8"),
      log(["000-a.png"]),
      "its log is back",
    );
    assert.equal(readFileSync(join(stage, "000-a.png"), "utf8"), "new a", "the new one is staged");
    assert.ok(existsSync(join(out, "001-b.png", "theirs.txt")), "what was there is untouched");
    // a later shoot does not clear what an earlier one left aside
    await rm(join(out, "001-b.png"), { recursive: true });
    await writeFile(join(stage, "001-b.png"), "new b");
    await replaceShoot(out, stage, ["000-a.png", "001-b.png"]);
    assert.equal(readFileSync(join(out, aside, "000-a.png"), "utf8"), "old a");
    assert.equal(readFileSync(join(out, "000-a.png"), "utf8"), "new a");
    assert.equal(
      (await readdir(out)).filter((n) => n.startsWith(".shoot-previous")).length,
      1,
      "only the one that could not be put back is left aside",
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("shoot: a button its fieldset disables is waited for, not clicked dead", {
  skip,
  timeout: 60000,
}, async () => {
  const { server, url } = await serve();
  const out = await mkdtemp(join(tmpdir(), "open-take-shoot-"));
  try {
    let clicks = "";
    await runShoot({
      ...base(out),
      script: async (s) => {
        await s.open(`${url}fieldset`, { settle: false });
        await s.click("#b2", { settle: false, still: false });
        clicks = String(await s.evaluate("document.getElementById('n').textContent"));
      },
    });
    assert.equal(clicks, "1", "the click landed once the fieldset was enabled");
  } finally {
    server.close();
    await rm(out, { recursive: true, force: true });
  }
});

test("shoot: a still keeps the interface too — a saved screen, checked, named in the log; on by default, off when asked", {
  skip,
  timeout: 120000,
}, async () => {
  const { server, url } = await serve();
  const out = await mkdtemp(join(tmpdir(), "open-take-shoot-"));
  try {
    // a saved screen that is not this shoot's (film init --url's home) stays put
    await mkdir(join(out, "states", "theirs"), { recursive: true });
    await writeFile(join(out, "states", "theirs", "state.html"), "not ours");
    const t0 = Date.now();
    const { log } = await runShoot({
      ...base(out),
      script: async (s) => {
        await s.open(url);
        await s.still("home");
        await s.still("plain", { state: false });
        await s.click("#go", { name: "home" });
        await s.type("#q", "ab", { each: true });
      },
    });
    const ms = Date.now() - t0;
    assert.deepEqual(
      log.stills.map((st) => st.state ?? null),
      ["home", null, "home-2", null, null, "type"],
      "a still and the still an action ends on keep a screen (a second of the same name its own); one that says no and the keystrokes' on the way do not",
    );
    assert.equal(log.states?.dir, "states");
    assert.deepEqual(
      log.states?.items.map((i) => [i.id, i.still]),
      [
        ["home", log.stills[0]!.file],
        ["home-2", log.stills[2]!.file],
        ["type", log.stills[5]!.file],
      ],
    );
    for (const it of log.states!.items) {
      assert.ok(it.fidelity.ok, `${it.id} re-renders as shot (psnr ${it.fidelity.psnr})`);
      const dir = join(out, "states", it.id);
      for (const f of ["state.html", "index.json", "live.png"])
        assert.ok(existsSync(join(dir, f)), `${it.id}/${f}`);
      for (const f of ["page.mhtml", "probe.json"])
        assert.ok(!existsSync(join(dir, f)), `${it.id}/${f} is gone once converted`);
      const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
      assert.deepEqual(index.viewport, { w: VW, h: VH, dpr: 2 });
      assert.ok(index.fidelity.ok);
    }
    // the screen is the page at that moment: the click's result is in the second
    const second = readFileSync(join(out, "states", "home-2", "state.html"), "utf8");
    assert.match(second, /clicks: 1/);
    assert.match(readFileSync(join(out, "states", "home", "state.html"), "utf8"), /clicks: 0/);
    assert.equal(readFileSync(join(out, "states", "theirs", "state.html"), "utf8"), "not ours");
    console.log(`  (6 stills, 3 saved screens: ${ms} ms)`);

    // a re-shoot replaces this shoot's screens, and only those
    const again = await runShoot({
      ...base(out),
      states: true,
      script: async (s) => {
        await s.open(url);
        await s.still("next");
        await s.still("bare", { state: false });
        await s.type("#q", "c", { each: true });
      },
    });
    assert.deepEqual(
      again.log.stills.map((st) => st.state ?? null),
      ["next", null, "type-1", "type"],
      "--states keeps one with every still whose call does not say, the ones on the way too",
    );
    // a folder of the same name that no shoot's log names is steered round,
    // not moved onto (that would fail the whole shoot)
    await mkdir(join(out, "none", "states", "b"), { recursive: true });
    await writeFile(join(out, "none", "states", "b", "state.html"), "not ours either");
    const none = await runShoot({
      ...base(join(out, "none")),
      states: false,
      script: async (s) => {
        await s.open(url);
        await s.still("a");
        await s.still("b", { state: true });
      },
    });
    assert.deepEqual(
      none.log.stills.map((st) => st.state ?? null),
      [null, "b-2"],
      "--no-states keeps none but where a call asks",
    );
    assert.equal(
      readFileSync(join(out, "none", "states", "b", "state.html"), "utf8"),
      "not ours either",
    );
    assert.ok(existsSync(join(out, "none", "states", "b-2", "state.html")));
    assert.ok(!existsSync(join(out, "states", "home")), "the last shoot's screens are gone");
    assert.ok(!existsSync(join(out, "states", "home-2")));
    assert.ok(existsSync(join(out, "states", "next", "state.html")));
    assert.equal(readFileSync(join(out, "states", "theirs", "state.html"), "utf8"), "not ours");
    assert.ok(!(await readdir(out)).some((n) => n.startsWith(".shoot")), "nothing left aside");

    // a scrolled page: the screen is checked against what is on screen, not
    // against the top of the document (a screenshot's clip is document px)
    const scrolled = await runShoot({
      ...base(out),
      script: async (s) => {
        await s.open(`${url}tall`);
        await s.evaluate("window.scrollTo(0, 900)");
        await s.still("down", { state: true, settle: true });
      },
    });
    const it = scrolled.log.states!.items[0]!;
    assert.ok(it.fidelity.ok, `the scrolled screen re-renders as shot (psnr ${it.fidelity.psnr})`);
    const ffmpeg = await resolveFfmpeg();
    const { stdout } = await exec(
      ffmpeg,
      [
        "-v",
        "error",
        "-i",
        join(out, "states", "down", "live.png"),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
      ],
      { encoding: "buffer", maxBuffer: 1 << 26 },
    );
    const at = (x: number, y: number) => [
      ...(stdout as Buffer).subarray((y * VW + x) * 3, (y * VW + x) * 3 + 3),
    ];
    assert.deepEqual(
      at(50, 200),
      [0, 0, 255],
      "the reference shows the blue a screen down, where it is scrolled to",
    );
  } finally {
    server.close();
    await rm(out, { recursive: true, force: true });
  }
});

test("shoot: a page's landing screen saved on its own (film init --url)", {
  skip,
  timeout: 60000,
}, async () => {
  const { server, url } = await serve();
  const dir = await mkdtemp(join(tmpdir(), "open-take-home-"));
  try {
    const home = await shootHome({
      url,
      dir,
      chromePath: chrome!,
      width: VW,
      height: VH,
      onNote: () => {},
    });
    assert.equal(home.dir, join(dir, "states", "home"));
    assert.equal(home.title, "shoot fixture");
    assert.ok(home.fidelity.ok, `psnr ${home.fidelity.psnr}`);
    assert.ok(existsSync(join(dir, "states", "home", "state.html")));
    assert.deepEqual(
      (await readdir(dir)).sort(),
      ["states"],
      "only the saved screen: no stills, no log, no work folder",
    );
    // again: replaced in place
    await shootHome({ url, dir, chromePath: chrome!, width: VW, height: VH, onNote: () => {} });
    assert.deepEqual((await readdir(dir)).sort(), ["states"]);
    assert.ok(existsSync(join(dir, "states", "home", "index.json")));
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/** the total a saved screen holds */
function totalIn(out: string, state: string | undefined): number {
  assert.ok(state, "the still kept a saved screen");
  const html = readFileSync(join(out, "states", state, "state.html"), "utf8");
  const m = /id="total"[^>]*>([^<]*)</.exec(html);
  assert.ok(m, `${state} holds the total`);
  return Number(m[1]!.replace(/,/g, ""));
}

test("shoot: a product's count-up is shot where it rests — after the action and at every drag step — and marked when it is not", {
  skip,
  timeout: 180000,
}, async () => {
  const { server, url } = await serve();
  const out = await mkdtemp(join(tmpdir(), "open-take-shoot-"));
  try {
    const { log } = await runShoot({
      ...base(out),
      script: async (s) => {
        await s.open(`${url}count`, { ready: "#calc" });
        await s.click("#calc", { name: "calc" });
        await s.drag("#months", { dx: 150 }, { every: 50, name: "m", state: true });
      },
    });
    assert.equal(log.steady, true, "the log says it records moving");
    const at = (name: string) => log.stills.find((st) => st.name === name)!;
    // the click: the total counted all the way, and the still says it waited
    assert.equal(totalIn(out, at("calc").state), 2705);
    assert.equal(at("calc").moving, undefined, "not taken on its way");
    assert.ok((at("calc").steadyMs ?? 0) >= 100, `it waited (${at("calc").steadyMs} ms)`);
    // the drag: each step's still holds the value the slider gives, rising
    // with it — not a count-up's in-between number
    const steps = ["m-1", "m-2", "m-3"].map((n) => at(n));
    const totals = steps.map((st) => totalIn(out, st.state));
    totals.forEach((v, i) => {
      assert.equal(v % 113, 0, `step ${i + 1} rests on a slider value (${v})`);
      assert.equal(steps[i]!.moving, undefined, `step ${i + 1} not marked moving`);
      if (i) assert.ok(v > totals[i - 1]!, `the totals rise with the drag (${totals.join(", ")})`);
    });
    assert.ok(totals[0]! > 0);

    // steady off: the old timing — the stills come as they come, and the ones
    // caught counting say so, with what was changing
    const off = await runShoot({
      ...base(join(out, "off")),
      steady: false,
      script: async (s) => {
        await s.open(`${url}count`, { ready: "#calc" });
        await s.drag("#months", { dx: 150 }, { every: 50, name: "m" });
        await s.click("#calc", { name: "calc", settle: false });
      },
    });
    assert.equal(off.log.steady, false);
    for (const st of off.log.stills)
      assert.equal(st.steadyMs, undefined, `${st.name} did not wait`);
    const moving = off.log.stills.filter((st) => st.moving);
    assert.ok(
      moving.some((st) => st.name.startsWith("m-")),
      `drag steps caught counting are marked (${off.log.stills.map((st) => `${st.name}:${!!st.moving}`).join(" ")})`,
    );
    const calc = off.log.stills.find((st) => st.name === "calc")!;
    assert.ok(calc.moving, "the click's still, taken at once, is marked");
    const c = calc.moving!.texts[0]!;
    assert.ok(c, "with the text that changed");
    assert.notEqual(c.before, c.after);
    assert.ok(/^[\d,]+$/.test(c.before) && /^[\d,]+$/.test(c.after), `${c.before} → ${c.after}`);
    assert.equal(c.x, 100, "where the text is, page px");
    // the screen kept with it says so too
    const item = off.log.states?.items.find((i) => i.still === calc.file);
    assert.equal(item?.moving, true);
    // one call can ask for the wait the shoot turned off
    const one = await runShoot({
      ...base(join(out, "one")),
      steady: false,
      script: async (s) => {
        await s.open(`${url}count`, { ready: "#calc" });
        await s.click("#calc", { name: "calc", steady: true });
      },
    });
    assert.equal(totalIn(join(out, "one"), one.log.stills[0]!.state), 2705);
  } finally {
    server.close();
    await rm(out, { recursive: true, force: true });
  }
});

test("shoot: a screen that never holds still — the steps stop waiting after a few, the call says so, and a landing screen says it was kept changing", {
  skip,
  timeout: 120000,
}, async () => {
  const { server, url } = await serve();
  const out = await mkdtemp(join(tmpdir(), "open-take-shoot-"));
  try {
    const notes: string[] = [];
    const { log } = await runShoot({
      ...base(out),
      onNote: (l) => notes.push(l),
      script: async (s) => {
        await s.open(`${url}tick`, { ready: "#q" });
        await s.type("#q", "abcde", { each: true, name: "k", steady: 300, state: false });
      },
    });
    const keys = log.stills.filter((st) => st.name.startsWith("k-"));
    assert.equal(keys.length, 5);
    // the first three ran out their 300 ms; the rest were taken as they came
    for (const st of keys.slice(0, 3))
      assert.ok((st.steadyMs ?? 0) >= 280, `${st.name} waited (${st.steadyMs} ms)`);
    for (const st of keys.slice(3)) assert.equal(st.steadyMs, undefined, `${st.name} did not wait`);
    assert.ok(
      keys.every((st) => st.moving),
      "every step is marked moving",
    );
    assert.ok(
      notes.some((l) => /the rest of its steps were taken as they came/.test(l)),
      notes.join("\n"),
    );
    assert.ok(
      notes.some((l) => /still changing after/.test(l)),
      "the last still says so too",
    );

    // a landing screen kept while it changed says so; steady: false keeps it at once
    const dir = join(out, "home");
    const home = await shootHome({
      url: `${url}tick`,
      dir,
      chromePath: chrome!,
      width: VW,
      height: VH,
      onNote: () => {},
      steady: false,
    });
    assert.ok(home.moving, "kept while the counter ran");
    assert.ok(home.moving.texts.some((c) => /^\d+$/.test(c.before) && c.before !== c.after));
  } finally {
    server.close();
    await rm(out, { recursive: true, force: true });
  }
});

test("shoot: s.save keeps what the product made — an SVG with its styles, a canvas, an image, a value, a picture of a box, a download — and the log says what each is", {
  skip,
  timeout: 90000,
}, async () => {
  const { server, url } = await serve();
  const out = await mkdtemp(join(tmpdir(), "open-take-save-"));
  try {
    const { log } = await runShoot({
      ...base(out),
      states: false,
      components: false,
      materials: false,
      script: async (s) => {
        await s.open(`${url}makes`);
        await s.still("made");
        await s.save("shape", "#shape");
        await s.save("drawn", "#cv");
        await s.save("pic", "#pic");
        await s.save("hash", "#out");
        await s.save("panel", "#panel");
        await s.save("export", { download: () => s.click("#export", { still: false }) });
        await assert.rejects(s.save("shape", "#shape"), /already saved one by that name/);
        await assert.rejects(s.save("../x", "#shape"), /a file name/);
      },
    });
    const by = Object.fromEntries((log.outputs ?? []).map((o) => [o.name, o]));
    assert.deepEqual(
      Object.fromEntries(Object.entries(by).map(([k, o]) => [k, [o.kind, o.file]])),
      {
        shape: ["svg", "outputs/shape.svg"],
        drawn: ["png", "outputs/drawn.png"],
        pic: ["image", "outputs/pic.svg"],
        hash: ["text", "outputs/hash.txt"],
        panel: ["picture", "outputs/panel.png"],
        export: ["download", "outputs/export.svg"],
      },
    );
    const svg = readFileSync(join(out, "outputs/shape.svg"), "utf8");
    assert.match(svg, /xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    assert.match(svg, /fill:\s*rgb\(200, 30, 90\)/, "the class's fill is inlined");
    assert.deepEqual(pngSize(join(out, "outputs/drawn.png")), [60, 40], "the canvas's own pixels");
    assert.match(readFileSync(join(out, "outputs/pic.svg"), "utf8"), /fill="#00f"/);
    assert.equal(readFileSync(join(out, "outputs/hash.txt"), "utf8"), "sha256: 3f2a…");
    assert.deepEqual(
      pngSize(join(out, "outputs/panel.png")),
      [400, 160],
      "the box at the shoot's 2×",
    );
    assert.equal(by.panel!.text, "Saved 42%");
    assert.equal(readFileSync(join(out, "outputs/export.svg"), "utf8"), "<svg>made</svg>");
    assert.equal(by.export!.filename, "shape.svg");
    for (const o of Object.values(by)) {
      assert.equal(o.after, "made", `${o.name}: the still before it`);
      assert.equal(o.still, 0);
      assert.match(o.url, /\/makes$/);
    }
    // a new shoot replaces the last one's outputs with its own
    await runShoot({
      ...base(out),
      states: false,
      components: false,
      materials: false,
      script: async (s) => {
        await s.open(`${url}makes`);
        await s.save("again", "#out");
      },
    });
    assert.ok(existsSync(join(out, "outputs/again.txt")));
    assert.ok(!existsSync(join(out, "outputs/shape.svg")), "the last shoot's outputs went with it");
  } finally {
    server.close();
    await rm(out, { recursive: true, force: true });
  }
});
