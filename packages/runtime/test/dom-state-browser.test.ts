// DOM states against real Chrome: a small served page with the things markup
// alone cannot carry (a typed value, a checked box, a scrolled container, a
// drawn canvas, a finished fade-in, a web font, a playing video) → probe +
// snapshot → state.html → re-opened offline and scored against the live
// screenshot. Also proves the live page was never touched. Skips without a
// Chrome for Testing (the runtime's own resolver: OPEN_TAKE_CHROME, the
// managed download, or a legacy agent-browser install — never system Chrome).

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { resolveFfmpeg } from "@open-take/compositor";
import { type Browser, CDP, fitViewport, launchBrowser, resolveChrome } from "../src/cdp";
import {
  captureDomState,
  type DomStateIndex,
  finalizeDomStates,
  visuallyStill,
} from "../src/dom-state";

const exec = promisify(execFile);
const chrome = process.env.OPEN_TAKE_E2E_CHROME ?? resolveChrome();
const skip = chrome ? false : "no Chrome for Testing";
const VW = 800;
const VH = 600;

/** a real woff2 from the workspace's font packages, if one is installed */
function findWoff2(): string | null {
  const store = join(import.meta.dirname, "..", "..", "..", "node_modules", ".pnpm");
  if (!existsSync(store)) return null;
  for (const pkg of readdirSync(store).filter((d) => d.startsWith("@fontsource+"))) {
    const name = pkg.slice("@fontsource+".length).replace(/@.*$/, "");
    const files = join(store, pkg, "node_modules", "@fontsource", name, "files");
    if (!existsSync(files)) continue;
    const f = readdirSync(files).find((x) => /-latin-400-normal\.woff2$/.test(x));
    if (f) return join(files, f);
  }
  return null;
}

/** a one-second VP9 clip, or null when this ffmpeg cannot encode one */
async function makeVideo(dir: string): Promise<string | null> {
  try {
    const ffmpeg = await resolveFfmpeg();
    const out = join(dir, "clip.webm");
    await exec(ffmpeg, [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x2266cc:s=96x64:d=1:r=10",
      "-c:v",
      "libvpx-vp9",
      "-pix_fmt",
      "yuv420p",
      out,
    ]);
    return out;
  } catch {
    return null;
  }
}

function page(opts: { font: boolean; video: boolean }): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>dom-state fixture</title>
<style>
${opts.font ? '@font-face{font-family:"Fx";src:url("/font.woff2") format("woff2")}' : ""}
html,body{margin:0;background:#f4f4f6;font-family:${opts.font ? '"Fx",' : ""}Arial,sans-serif;color:#1a1a2e}
header{position:fixed;top:0;left:0;right:0;height:48px;background:#1f2a44;color:#fff;display:flex;align-items:center;padding:0 16px;font-size:18px}
main{padding:72px 24px 24px}
.row{display:flex;gap:12px;margin-bottom:16px;align-items:center}
button{font:inherit;padding:8px 16px;border-radius:6px;border:1px solid #888;background:#fff}
#box{height:120px;overflow:auto;border:1px solid #aaa;background:#fff;width:320px}
#box div{height:600px;background:linear-gradient(#fff,#88c)}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
#fade{opacity:0;animation:fadeIn .2s forwards;padding:12px;background:#ffd166;width:200px}
#spin{width:24px;height:24px;background:#e63946;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head>
<body>
<script>window.__x = 1;</script>
<header>Fixture <span hidden>hidden</span></header>
<noscript>no js</noscript>
<main>
  <div class="row"><button id="b1">Save</button><button id="b2" aria-label="Delete row">🗑</button><a href="/docs" id="lnk">Docs</a></div>
  <div class="row"><label for="txt">Name</label><input id="txt" value="attr"><input id="cb" type="checkbox"><select id="sel"><option>one</option><option>two</option></select></div>
  <div class="row"><canvas id="cv" width="80" height="60"></canvas>${opts.video ? '<video id="vid" src="/clip.webm" width="96" height="64" muted autoplay loop playsinline></video>' : ""}<div id="spin"></div></div>
  <div id="box"><div>scroll me</div></div>
  <p id="fade">faded in</p>
  <p>A paragraph of text, in the web font when one is served.</p>
  <details><summary>More</summary><p>tucked away</p></details>
</main>
<script>
  document.getElementById("txt").value = "typed";
  document.getElementById("cb").checked = true;
  document.getElementById("sel").selectedIndex = 1;
  const c = document.getElementById("cv").getContext("2d"); c.fillStyle = "#06d6a0"; c.fillRect(0, 0, 80, 60); c.fillStyle = "#000"; c.fillRect(20, 15, 40, 30);
  document.getElementById("box").scrollTop = 150;
  document.getElementById("txt").focus();
</script>
</body></html>`;
}

async function serve(dir: string, html: string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const u = req.url ?? "/";
    if (u === "/") return res.writeHead(200, { "content-type": "text/html" }).end(html);
    const file = join(dir, u.slice(1));
    if (existsSync(file)) {
      const type = u.endsWith(".woff2")
        ? "font/woff2"
        : u.endsWith(".webm")
          ? "video/webm"
          : "application/octet-stream";
      return res.writeHead(200, { "content-type": type }).end(readFileSync(file));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` };
}

const evaluate = async <T>(cdp: CDP, expression: string): Promise<T> =>
  (
    await cdp.send<{ result?: { value?: T } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
  ).result!.value as T;

test("probe → snapshot → state.html → offline re-render matches the live page; the live page is untouched", {
  skip,
  timeout: 120000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-dom-state-browser-"));
  let browser: Browser | null = null;
  let server: Server | null = null;
  try {
    const woff2 = findWoff2();
    if (woff2) await copyFile(woff2, join(dir, "font.woff2"));
    const video = (await makeVideo(dir)) != null;
    const served = await serve(dir, page({ font: woff2 != null, video }));
    server = served.server;
    browser = await launchBrowser({
      width: VW,
      height: VH,
      chromePath: chrome!,
      deviceScaleFactor: 2,
    });
    const { cdp } = browser;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const inner = await fitViewport(cdp, browser.targetId, VW, VH);
    const loaded = new Promise<void>((r) => cdp.on("Page.loadEventFired", () => r()));
    await cdp.send("Page.navigate", { url: served.url });
    await loaded;
    await evaluate(cdp, "document.fonts.ready.then(() => true)");
    if (video)
      await evaluate(
        cdp,
        "new Promise(r => { const v = document.getElementById('vid'); const t = () => v.readyState >= 2 ? r(true) : setTimeout(t, 50); t(); })",
      );
    await new Promise((r) => setTimeout(r, 500)); // the fade-in finishes; the spinner keeps going

    const liveBefore = await evaluate<string>(
      cdp,
      "JSON.stringify({ tagged: document.querySelectorAll('[data-ot-id]').length, freeze: !!document.querySelector('style[data-ot-freeze]'), canvas: document.getElementById('cv').localName, fadeStyle: document.getElementById('fade').getAttribute('style'), scripts: document.scripts.length, html: document.documentElement.outerHTML.length })",
    );

    // --- during the take: the raw capture --------------------------------------
    const statesDir = join(dir, "states");
    const raw = await captureDomState(cdp, {
      statesDir,
      id: "s0",
      tMs: 1234,
      vw: inner[0],
      vh: inner[1],
      dpr: 2,
    });
    console.error(
      `dom-state fixture: probe ${raw.ms.probe}ms, screenshot ${raw.ms.shot}ms, snapshot ${raw.ms.snap}ms, total ${raw.ms.total}ms, ${raw.probe.elements.length} elements`,
    );
    const p = raw.probe;
    assert.ok(p.canvases.length >= 1, "a still page's canvas is read");
    assert.equal(p.viewport.w, inner[0]);
    assert.equal(p.viewport.dpr, 2);
    const byId = (id: string) =>
      p.elements.find((e) => (e.tag !== "html" && e.name === id) || e.id === id);
    const save = p.elements.find((e) => e.tag === "button" && e.text === "Save")!;
    assert.ok(
      save?.interactive && save.role === "button" && save.name === "Save",
      `Save button indexed: ${JSON.stringify(save)}`,
    );
    const del = p.elements.find((e) => e.tag === "button" && e.name === "Delete row")!;
    assert.ok(del?.interactive, "aria-label names the icon button");
    const header = p.elements.find((e) => e.tag === "header")!;
    assert.ok(header?.fixed && header.role === "banner", `fixed header: ${JSON.stringify(header)}`);
    const input = p.elements.find((e) => e.tag === "input" && e.role === "textbox")!;
    assert.equal(input?.name, "Name", "label text names the input");
    assert.ok(!p.elements.some((e) => e.text === "hidden"), "[hidden] never listed");
    // a closed <details> keeps boxes for its rows but does not draw them
    assert.ok(p.elements.some((e) => e.tag === "summary" && e.text === "More"));
    assert.ok(
      !p.elements.some((e) => e.text === "tucked away"),
      "closed <details> content not listed",
    );
    const txtEntry = p.inputs.find((i) => i.path.join(".") === input.path.join("."))!;
    assert.equal(txtEntry?.value, "typed", "live .value, not the attribute");
    assert.ok(
      p.inputs.some((i) => i.checked === true),
      "checkbox recorded checked",
    );
    assert.ok(
      p.inputs.some((i) => i.selectedIndex === 1),
      "select recorded",
    );
    assert.equal(p.scrolled.length, 1);
    assert.equal(p.scrolled[0]!.top, 150);
    assert.equal(p.canvases.length, 1);
    assert.match(p.canvases[0]!.dataUrl, /^data:image\/png;base64,/);
    assert.deepEqual(p.focus, input.path, "the focused field is recorded");
    if (video) assert.equal(p.videos.length, 1, "video frame captured");
    const fade = p.elements.find((e) => e.tag === "p" && e.text === "faded in")!;
    const fadeAnim = p.animated.find((a) => a.path.join(".") === fade.path.join("."));
    assert.equal(fadeAnim?.styles.opacity, "1", "the finished fade-in's live opacity is recorded");
    assert.ok(p.layers.length >= 1, `layers: ${JSON.stringify(p.layers)}`);
    assert.ok(byId(header.id), "sanity");
    assert.ok(
      existsSync(join(statesDir, "s0", "live.png")) &&
        existsSync(join(statesDir, "s0", "page.mhtml")) &&
        existsSync(join(statesDir, "s0", "probe.json")),
    );

    // --- after the screencast: convert + fidelity --------------------------------------
    const items = await finalizeDomStates({
      browser,
      statesDir,
      states: [raw],
      vw: inner[0],
      vh: inner[1],
      warn: (l) => console.error(l),
    });
    assert.equal(items.length, 1);
    const fid = items[0]!.fidelity!;
    console.error(
      `dom-state fixture: fidelity psnr ${fid.psnr} dB, ${(fid.diffFrac * 100).toFixed(2)}% px differ`,
    );
    assert.ok(fid.ok && fid.psnr >= 30, `fidelity ${JSON.stringify(fid)}`);
    assert.ok(
      !existsSync(join(statesDir, "s0", "page.mhtml")) &&
        !existsSync(join(statesDir, "s0", "probe.json")),
      "raw files removed",
    );
    assert.ok(
      existsSync(join(statesDir, "s0", "state.html")) &&
        existsSync(join(statesDir, "s0", "live.png")),
    );
    assert.ok(readdirSync(join(statesDir, "assets")).length >= (woff2 ? 1 : 0), "assets written");
    const index = JSON.parse(
      readFileSync(join(statesDir, "s0", "index.json"), "utf8"),
    ) as DomStateIndex;
    assert.deepEqual(Object.keys(index).sort(), [
      "elements",
      "fidelity",
      "id",
      "layers",
      "scroll",
      "tMs",
      "title",
      "url",
      "version",
      "viewport",
    ]);
    assert.equal(index.version, 1);
    assert.equal(index.tMs, 1234);
    assert.equal(index.step, undefined);
    assert.equal(index.title, "dom-state fixture");
    assert.deepEqual(index.fidelity, fid);

    // --- the saved state, opened offline ------------------------------------------
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    const c2 = await CDP.connect(`ws://127.0.0.1:${browser.port}/devtools/page/${targetId}`);
    await c2.send("Page.enable");
    await c2.send("Runtime.enable");
    const l2 = new Promise<void>((r) => c2.on("Page.loadEventFired", () => r()));
    await c2.send("Page.navigate", { url: `file://${join(statesDir, "s0", "state.html")}` });
    await l2;
    await evaluate(
      c2,
      "new Promise(r => { const t = () => document.documentElement.dataset.otReady === '1' ? r(true) : setTimeout(t, 50); t(); })",
    );
    const state = JSON.parse(
      await evaluate<string>(
        c2,
        `JSON.stringify({
          misses: document.documentElement.dataset.otMisses,
          value: document.getElementById('txt').value,
          checked: document.getElementById('cb').checked,
          sel: document.getElementById('sel').selectedIndex,
          scrollTop: document.getElementById('box').scrollTop,
          tagged: document.querySelectorAll('[data-ot-id]').length,
          saveTag: document.getElementById('b1').getAttribute('data-ot-id'),
          delTag: document.getElementById('b2').getAttribute('data-ot-id'),
          inputTag: document.getElementById('txt').getAttribute('data-ot-id'),
          canvasNow: document.getElementById('cv').localName,
          canvasMarked: document.getElementById('cv').getAttribute('data-ot-canvas'),
          canvasPixels: (() => { const x = document.getElementById('cv').getContext('2d'); return [Array.from(x.getImageData(5, 5, 1, 1).data), Array.from(x.getImageData(40, 30, 1, 1).data)]; })(),
          fadeOpacity: getComputedStyle(document.getElementById('fade')).opacity,
          scripts: Array.from(document.scripts).map(s => s.type || (s.hasAttribute('data-ot-restore') ? 'restore' : 'other')),
          freeze: !!document.querySelector('head > style[data-ot-freeze]:last-child'),
          fonts: Array.from(document.fonts).map(f => f.status),
          remote: performance.getEntriesByType('resource').map(r => r.name).filter(n => !n.startsWith('file:')),
          poster: ${video ? "(document.getElementById('vid').getAttribute('poster') || '').slice(0, 15)" : "'n/a'"},
          focused: document.activeElement && document.activeElement.id,
        })`,
      ),
    ) as Record<string, unknown>;
    assert.equal(state.misses, "0", "every element path resolved in state.html");
    assert.equal(state.value, "typed");
    assert.equal(state.checked, true);
    assert.equal(state.sel, 1);
    assert.equal(state.scrollTop, 150, "scrolled container restored");
    assert.equal(state.saveTag, save.id);
    assert.equal(state.delTag, del.id);
    assert.equal(state.inputTag, input.id);
    assert.ok(
      (state.tagged as number) >= p.elements.length - 1,
      `tagged ${state.tagged} of ${p.elements.length}`,
    );
    // the canvas stays a canvas (every CSS rule that targets it still applies),
    // painted with the pixels it showed: green with a black middle
    assert.equal(state.canvasNow, "canvas", "the canvas element stays");
    assert.equal(state.canvasMarked, "1");
    const [edge, middle] = state.canvasPixels as number[][];
    assert.ok(edge![1]! > 180 && edge![0]! < 40, `painted edge ${edge}`);
    assert.ok(middle![0]! < 30 && middle![1]! < 30, `painted middle ${middle}`);
    assert.equal(state.fadeOpacity, "1", "finished fade-in re-applied");
    // Chrome's serializer already drops the page's own scripts; what it leaves
    // (its custom-elements shim) is inert, and ours is the only one that runs
    assert.deepEqual(
      (state.scripts as string[]).filter((s) => s !== "application/x-open-take-inert"),
      ["restore"],
      `only the restore script runs: ${JSON.stringify(state.scripts)}`,
    );
    assert.ok((state.scripts as string[]).length >= 2, "the shim script survived in place, inert");
    assert.equal(state.focused, "txt", "focus restored on the field that had it");
    assert.equal(state.freeze, true, "freeze style is the last thing in head");
    assert.deepEqual(state.remote, [], "nothing loaded from the network");
    if (woff2)
      assert.ok(
        (state.fonts as string[]).includes("loaded"),
        `web font loaded offline: ${JSON.stringify(state.fonts)}`,
      );
    if (video)
      // a frame of video is opaque: JPEG, an order of magnitude faster to encode
      assert.equal(state.poster, "data:image/jpeg", "video shows its captured frame as poster");
    c2.close();
    await cdp.send("Target.closeTarget", { targetId });

    // --- the live page was never touched ------------------------------------------
    const liveAfter = await evaluate<string>(
      cdp,
      "JSON.stringify({ tagged: document.querySelectorAll('[data-ot-id]').length, freeze: !!document.querySelector('style[data-ot-freeze]'), canvas: document.getElementById('cv').localName, fadeStyle: document.getElementById('fade').getAttribute('style'), scripts: document.scripts.length, html: document.documentElement.outerHTML.length })",
    );
    assert.equal(liveAfter, liveBefore, "live DOM identical before and after");
    assert.equal(JSON.parse(liveAfter).tagged, 0);
    assert.equal(JSON.parse(liveAfter).canvas, "canvas");

    // moving is a matter of pixels: the spinner turns; stopped, the page is still
    assert.equal(await visuallyStill(cdp, inner[0], inner[1]), false, "the spinner moves");
    await evaluate(cdp, "document.getElementById('spin').style.animation = 'none'; true");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await visuallyStill(cdp, inner[0], inner[1]), true, "nothing moves");
  } finally {
    await browser?.close();
    server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
