// The text locators in a real Chrome, for what a DOM shim cannot model: a
// checkbox whose only name is the <label> wrapping it, and a field the page
// does not show — inside a closed <details>, or under an overlay — whose
// capture must say WHY it cannot be typed into (a run once spent seven
// attempts on "its centre is covered" for a field that sat in a collapsed
// "use your phone" disclosure). Skips without Chrome for Testing.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { clickByTextJs, focusFieldByTextJs } from "../src/capture";
import { type Browser, type CDP, launchBrowser, resolveChrome } from "../src/cdp";
import { probeJs } from "../src/precheck";

const chrome = process.env.OPEN_TAKE_E2E_CHROME ?? resolveChrome();
const skip = chrome ? false : "no Chrome for Testing";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:16px sans-serif}
label{display:flex;gap:8px;margin:10px}
.cover{position:absolute;left:0;top:300px;width:600px;height:80px;background:#fff8}
</style></head><body>
<button id="accept">Accept all</button>
<label id="adult"><input type="checkbox" name="adult"> I confirm I am over 18 <small>(required by law)</small></label>
<label id="plan"><input type="radio" name="plan" value="pro"> Pro plan</label>
<details id="alt"><summary>Use your phone instead</summary>
  <input id="phone" placeholder="0912 345 678">
</details>
<input id="email" placeholder="you@example.com" style="position:absolute;left:20px;top:320px;width:300px">
<div class="cover" id="sheet">Cookie notice</div>
</body></html>`;

async function serve(): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
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

test("click by text: a label wrapping a checkbox or a radio, when no control carries the name", {
  skip,
  timeout: 60000,
}, async () => {
  const { server, url } = await serve();
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser({ width: 800, height: 600, chromePath: chrome! });
    const { cdp } = browser;
    await cdp.send("Page.enable");
    const loaded = new Promise<void>((r) => cdp.on("Page.loadEventFired", () => r()));
    await cdp.send("Page.navigate", { url });
    await loaded;
    // the label is found by its own words (the control has no other name)
    const adult = JSON.parse(await evaluate<string>(cdp, clickByTextJs("I confirm I am over 18")));
    assert.ok(adult.w > 100, `the label's box, not the 13 px box: ${JSON.stringify(adult)}`);
    assert.ok(typeof adult.cx === "number", "its centre is hittable: a real press goes there");
    const pro = JSON.parse(await evaluate<string>(cdp, clickByTextJs("Pro plan")));
    assert.ok(pro.w > 50);
    // a real control with the name still wins: nothing that resolved before moves
    const accept = JSON.parse(await evaluate<string>(cdp, clickByTextJs("Accept all")));
    const acceptBox = await evaluate<number>(
      cdp,
      "document.getElementById('accept').getBoundingClientRect().width",
    );
    assert.equal(accept.w, Math.round(acceptBox));
    // the pre-capture check resolves exactly as the capture does
    const probe = JSON.parse(
      await evaluate<string>(cdp, probeJs("text", "I confirm I am over 18", "click")),
    );
    assert.equal(probe.count, 1);
    assert.equal(probe.first.tag, "LABEL");
  } finally {
    await browser?.close();
    server.close();
  }
});

test("a field the page does not show says why it cannot be typed into", {
  skip,
  timeout: 60000,
}, async () => {
  const { server, url } = await serve();
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser({ width: 800, height: 600, chromePath: chrome! });
    const { cdp } = browser;
    await cdp.send("Page.enable");
    const loaded = new Promise<void>((r) => cdp.on("Page.loadEventFired", () => r()));
    await cdp.send("Page.navigate", { url });
    await loaded;
    // a field in a closed <details> cannot even take focus: the capture says why
    const phone = JSON.parse(await evaluate<string>(cdp, focusFieldByTextJs("0912 345 678")));
    assert.equal(phone.f, 0);
    assert.equal(phone.hit, 0);
    assert.match(phone.why, /inside a closed <details>/);
    assert.match(phone.why, /"Use your phone instead"/);
    // the reasons themselves, for every way a field can be out of reach
    const why = await evaluate<string[]>(
      cdp,
      `(() => {
        ${"" /* the same function the capture embeds, run on both fields */}
        const js = ${JSON.stringify(focusFieldByTextJs("x"))};
        const fn = js.match(/function unreachable\\(m\\)\\{[\\s\\S]*?return 'its centre is covered by '\\+d\\(top\\);\\}/)[0];
        const unreachable = new Function(fn + "; return unreachable;")();
        const hidden = document.createElement("input");
        hidden.style.display = "none";
        document.body.append(hidden);
        return [unreachable(document.getElementById("phone")), unreachable(document.getElementById("email")), unreachable(hidden)];
      })()`,
    );
    assert.match(
      why[0]!,
      /inside a closed <details> — open it first: click its summary "Use your phone instead"/,
    );
    assert.match(why[1]!, /its centre is covered by div#sheet\.cover "Cookie notice"/);
    assert.match(why[2]!, /it has no size — not shown yet/);
  } finally {
    await browser?.close();
    server.close();
  }
});
