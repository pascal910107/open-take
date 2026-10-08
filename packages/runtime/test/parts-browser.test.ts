// The component probe against real Chrome, the way a shoot runs it: two
// saved states of one served page → finalizeDomStates → parts.json beside
// each index.json, crisp see-through pictures in states/assets/. Proves the
// kinds the probe names on a known page, what it leaves out and why, that a
// picture is the part alone (transparent around it), and that the page's
// background override is put back (the second state still re-renders as
// shot). Skips without a Chrome for Testing.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import type { PartsFile } from "@open-take/compositor";
import { type Browser, type CDP, fitViewport, launchBrowser, resolveChrome } from "../src/cdp";
import { captureDomState, finalizeDomStates } from "../src/dom-state";

const chrome = process.env.OPEN_TAKE_E2E_CHROME ?? resolveChrome();
const skip = chrome ? false : "no Chrome for Testing";
const VW = 800;
const VH = 600;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Parts fixture</title><style>
body{margin:0;font:16px/1.4 sans-serif;color:#222}
header{display:flex;justify-content:space-between;align-items:center;padding:8px 16px;height:48px}
.logo{width:120px;height:32px;display:block}
h1{font-size:40px;margin:12px 16px}
.card{margin:12px 16px;padding:16px;width:300px;background:#e8f0e8;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.2)}
.card p{margin:0}
.stat{display:inline-block}
.v{font-size:36px;font-weight:700}
.row{display:flex;gap:8px;margin:12px 16px}
.row button{width:80px;height:40px}
.cta{background:#0a7;color:#fff;border:0;padding:10px 20px;border-radius:8px;margin:12px 16px}
#cookie{position:fixed;bottom:0;left:0;right:0;background:#333;color:#fff;padding:12px}
#more{position:absolute;left:420px;top:110px;width:360px}
#more .icons button{width:40px;height:40px}
#more dd{font-size:40px;font-weight:700;margin:0}
#more td div.big2{font-size:40px;font-weight:700}
#more td div.small{font-size:13px}
</style></head><body>
<header><svg class="logo" viewBox="0 0 120 32"><rect width="120" height="32" rx="6" fill="#0a7"/></svg><nav><a href="#">Docs</a></nav></header>
<h1>Count your savings</h1>
<div class="card" id="result"><div class="stat"><p>You save</p><span class="v" id="total">NT$4,466</span></div><p>Based on 18 months left</p></div>
<div class="row" id="months"><button>12</button><button>24</button><button>36</button></div>
<label id="fee-field">Monthly fee <input id="fee" value="1,288"></label>
<div><button class="cta" id="go">Start now</button></div>
<div><span class="v" id="left">18.5<small>個月</small></span> <button id="chip"><span>NT$1,288</span></button></div>
<div id="more">
<div class="icons"><button id="close" aria-label="Close panel"><svg width="16" height="16"><path d="M0 0L16 16" stroke="#000"/></svg></button><button id="star"><svg width="16" height="16"><title>Star this</title><rect width="16" height="16"/></svg></button></div>
<dl><dt>Monthly</dt><dd id="plan">NT$1,688 起 / 月（含稅，綁約 12 個月）</dd></dl>
<table><tr><td id="feecell"><div class="small">Cancel fee</div><div class="big2" id="free">Free</div></td></tr></table>
<input id="q" placeholder="Search gyms">
<div role="tablist"><button role="tab" id="tab1" aria-selected="true" aria-controls="panel1">Plans</button><button role="tab" id="tab2" aria-selected="false" aria-controls="panel2">Gyms</button></div>
<div id="panel1" role="tabpanel"><p>Three plans, billed monthly.</p></div>
</div>
<div id="cookie">We use cookies. <b>NT$1</b> <button>OK</button></div>
</body></html>`;

async function serve(html: string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if ((req.url ?? "/") === "/")
      return res.writeHead(200, { "content-type": "text/html" }).end(html);
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

/** the alpha of a PNG's top-left pixel (8-bit RGBA): whatever the first
 *  row's filter, its first pixel is stored as is */
function cornerAlpha(png: Buffer): number {
  assert.equal(png.readUInt8(24), 8, "8-bit");
  assert.equal(png.readUInt8(25), 6, "RGBA");
  const idat: Buffer[] = [];
  for (let o = 8; o < png.length; ) {
    const len = png.readUInt32BE(o);
    const type = png.toString("latin1", o + 4, o + 8);
    if (type === "IDAT") idat.push(png.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  return inflateSync(Buffer.concat(idat))[4]!;
}

test("finalizeDomStates measures each state's parts and takes see-through pictures", {
  skip,
  timeout: 120000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-parts-browser-"));
  let browser: Browser | null = null;
  let server: Server | null = null;
  try {
    const served = await serve(PAGE);
    server = served.server;
    browser = await launchBrowser({ width: VW, height: VH, chromePath: chrome! });
    const { cdp } = browser;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const inner = await fitViewport(cdp, browser.targetId, VW, VH);
    const loaded = new Promise<void>((r) => cdp.on("Page.loadEventFired", () => r()));
    await cdp.send("Page.navigate", { url: served.url });
    await loaded;
    await evaluate(cdp, "document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 300)))");
    const statesDir = join(dir, "states");
    const shot = (id: string) =>
      captureDomState(cdp, { statesDir, id, tMs: 0, vw: inner[0], vh: inner[1], dpr: 1 });
    const a = await shot("a");
    // the change is painted before the second state's reference is taken
    await evaluate(
      cdp,
      "new Promise(r => { document.getElementById('total').textContent = 'NT$5,120'; requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 100))); })",
    );
    const b = await shot("b");
    const items = await finalizeDomStates({
      browser,
      statesDir,
      states: [a, b],
      vw: inner[0],
      vh: inner[1],
    });
    // the first state is rendered before any picture is taken; the second
    // after the first state's pictures — a background override left behind
    // would make its page see-through and its fidelity collapse
    const [fa, fb] = items.map((i) => i.fidelity!);
    assert.ok(
      fb!.psnr >= Math.min(30, fa!.psnr) - 2,
      `the second state re-renders as well as the first (the clear background is undone): ${JSON.stringify(items)}`,
    );

    const parts = JSON.parse(readFileSync(join(statesDir, "a", "parts.json"), "utf8")) as PartsFile;
    const index = JSON.parse(readFileSync(join(statesDir, "a", "index.json"), "utf8")) as {
      elements: { id: string; tag: string; text?: string; name?: string }[];
    };
    const idOf = (pred: (e: (typeof index.elements)[number]) => boolean) =>
      index.elements.find(pred)?.id;
    const part = (id: string | undefined) => parts.parts.find((p) => p.el === id);
    const kinds = parts.parts.map((p) => `${p.el}:${p.kind}:${p.label}`).join(" | ");
    console.error(`parts fixture: ${kinds} (${JSON.stringify(parts.ms)})`);
    assert.equal(parts.version, 1);
    assert.equal(parts.state, "a");
    assert.equal(parts.medianTextPx, 16);

    const total = part(idOf((e) => e.text === "NT$4,466"));
    assert.equal(total?.kind, "number", kinds);
    assert.equal(total!.look.weight, 700);
    assert.ok(total!.ink && total!.ink[2] <= total!.box[2] + 2, "the number's ink box");
    assert.equal(total!.lift.box, "ink");
    const stat = part(total!.inside);
    assert.equal(stat?.kind, "stat", "the number with its label is a stat");
    const card = part(stat!.inside);
    assert.equal(card?.kind, "card");
    assert.equal(card!.sub, "result", "a card holding a number");
    assert.ok(card!.look.shadow && card!.look.radius === 12);
    assert.equal(part(idOf((e) => e.tag === "h1"))?.kind, "heading");
    assert.equal(part(idOf((e) => e.tag === "svg"))?.kind, "logo");
    const row = parts.parts.find((p) => p.kind === "group");
    assert.equal(row?.axis, "row");
    assert.equal(row!.members?.length, 3);
    for (const m of row!.members!)
      assert.equal(part(m)?.kind, "button", "a number on a button is a button");
    const go = part(idOf((e) => e.tag === "button" && e.text === "Start now"));
    assert.equal(go?.kind, "button");
    assert.equal(go!.primary, true, "the strongest fill is the primary button");
    assert.equal(go!.lift.box, "box", "a button's picture keeps its fill (not cut to its ink)");
    assert.ok(go!.clip![2] >= go!.box[2] && go!.clip![3] >= go!.box[3], "the clip holds its box");
    const left = part(idOf((e) => e.tag === "span" && (e.text ?? "").startsWith("18.5")));
    assert.equal(left?.kind, "number", `a number with its unit in a child: ${kinds}`);
    assert.equal(left!.label, "18.5個月");
    assert.equal(part(idOf((e) => e.tag === "button" && e.name === "NT$1,288"))?.kind, "button");
    assert.ok(
      !parts.parts.some((p) => p.kind === "number" && p.label === "NT$1,288"),
      "a number on a button is the button's text",
    );
    const fee = part(idOf((e) => e.tag === "input"));
    assert.equal(fee?.kind, "input");
    assert.equal(part(fee!.field)?.kind, "field");
    assert.equal(part(fee!.field)?.input, fee!.el);
    // every part keeps its text whole, apart from the 80-character label
    for (const p of parts.parts) assert.equal(typeof p.text, "string", p.el);
    // an icon-only button reads as its name (aria-label, an svg's <title>)
    const byLabel = (l: string) => parts.parts.find((p) => p.label === l);
    const close = byLabel("Close panel");
    assert.equal(close?.kind, "button", kinds);
    assert.equal(close!.text, "");
    assert.equal(close!.fields?.name, "Close panel");
    assert.equal(byLabel("Star this")?.kind, "button", kinds);
    // a value cell set large is a value, not a heading — kept whole
    const plan = parts.parts.find((p) => (p.text ?? "").startsWith("NT$1,688"));
    assert.equal(plan?.kind, "number", kinds);
    assert.equal(plan!.text, "NT$1,688 起 / 月（含稅，綁約 12 個月）");
    assert.ok(!parts.parts.some((p) => p.kind === "heading" && /Free|NT\$1,688/.test(p.label)));
    const feeCell = parts.parts.find((p) => p.kind === "stat" && /Cancel fee/.test(p.text ?? ""));
    assert.ok(
      feeCell && /Free/.test(feeCell.text!),
      `the cell's value and its label are a stat: ${kinds}`,
    );
    // an input's value apart from its placeholder
    const q = parts.parts.find((p) => p.kind === "input" && p.label === "Search gyms");
    assert.deepEqual(q?.fields, { value: "", placeholder: "Search gyms" });
    // a tab: the state it shows and the panel it controls
    const tab = parts.parts.find((p) => p.label === "Plans");
    assert.deepEqual(tab?.state, { selected: "true" });
    assert.equal(tab!.controls?.length, 1);
    assert.equal(
      tab!.controls![0],
      idOf((e) => e.tag === "div" && (e.text ?? "").startsWith("Three plans")) ?? tab!.controls![0],
    );
    assert.equal(parts.parts.find((p) => p.label === "Gyms")?.state, undefined);
    // left out, with reasons
    const cookieNum = parts.skipped.find((s) => s.label === "NT$1");
    assert.match(cookieNum?.why ?? "", /cookie/, JSON.stringify(parts.skipped));
    assert.ok(!parts.parts.some((p) => p.label === "OK"), "the cookie banner's button is left out");
    assert.ok(
      parts.skipped.some((s) => s.why.startsWith("inside nav")) ||
        !parts.parts.some((p) => p.label === "Docs"),
      "the nav link is not a part",
    );

    // pictures: the part alone, 3×, see-through around it
    assert.ok(total!.picture?.startsWith("../assets/") && total!.clipScale === 3);
    const png = readFileSync(join(statesDir, "a", total!.picture!));
    assert.equal(png.readUInt32BE(16), Math.round(total!.clip![2] * 3), "3× the clip's width");
    assert.equal(cornerAlpha(png), 0, "transparent around the part");
    assert.ok(existsSync(join(statesDir, "a", card!.picture!)));
    const totalB = (
      JSON.parse(readFileSync(join(statesDir, "b", "parts.json"), "utf8")) as PartsFile
    ).parts.find((p) => p.label === "NT$5,120");
    assert.ok(
      totalB?.picture && totalB.picture !== total!.picture,
      "a changed part, a new picture",
    );
  } finally {
    server?.close();
    await browser?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
