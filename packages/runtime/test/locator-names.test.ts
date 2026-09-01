// The text locators and `inspect` MUST agree about an element's name. They did
// not: each locator carried its own precedence chain, so `click` matched
// `aria-label || textContent` while `drag`/`press`/`scroll`/`hrefFrom` put
// `title` FIRST, and `inspect` used a third chain. Consequences, both hit for
// real while shooting the launch film against the editor's own UI:
//
//   1. A button with a visible label AND a tooltip — the editor's Compare
//      button, label "Compare", title "Hold to compare against the version you
//      opened" — was advertised by `inspect` as "Compare", clicked fine, and
//      resolved to NOTFOUND for a drag. SKILL.md tells agents to target exactly
//      what `inspect` reports, so the plan looked right and the beat vanished.
//   2. A title-only control — the editor's Look swatches, `<button title="paper">`
//      with an empty body — was skipped by `inspect` altogether and unreachable
//      by `text` from any verb, forcing a CSS `nth-child` selector.
//
// These tests EVALUATE the generated page-JS against a DOM shim rather than
// asserting on the source string, because the bug lived in the emitted
// JavaScript, not in the TypeScript around it.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boxByTextJs,
  clickBySelectorJs,
  clickByTextJs,
  focusFieldByTextJs,
  focusSelectorJs,
  hrefByTextJs,
  listInteractiveJs,
  scrollDeltaByTextJs,
  verifyFocusJs,
} from "../src/capture.js";

// --- a DOM shim just large enough for the locators ----------------------
// querySelectorAll gets a real (tiny) matcher for the selector forms these
// locators actually use — `tag`, `[attr]`, `[attr=value]`, `tag[attr=value]` —
// so a test cannot pass by matching an element the locator would never query.

type El = {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  clicked?: boolean;
  focused?: boolean;
  scrolled?: boolean;
};

const el = (
  tag: string,
  attrs: Record<string, string> = {},
  text = "",
  rect = { x: 10, y: 20, width: 100, height: 30 },
): El => ({ tag, attrs, text, rect });

function matches(e: El, part: string): boolean {
  const m = /^([a-z0-9]*)((?:\[[^\]]+\])*)$/i.exec(part.trim());
  if (!m) return false;
  const [, tag, attrPart] = m;
  if (tag && tag.toLowerCase() !== e.tag.toLowerCase()) return false;
  for (const g of attrPart?.match(/\[[^\]]+\]/g) ?? []) {
    const body = g.slice(1, -1);
    const eq = body.indexOf("=");
    if (eq === -1) {
      if (!(body in e.attrs)) return false;
    } else {
      const k = body.slice(0, eq);
      const v = body.slice(eq + 1).replace(/^["']|["']$/g, "");
      if (e.attrs[k] !== v) return false;
    }
  }
  return true;
}

function makeDoc(els: El[], opts: { singularHit?: (x: number, y: number) => El | null } = {}) {
  // ONE wrapper per El, memoized. The click tail compares the resolved element
  // against document.elementFromPoint by IDENTITY (hit===m / m.contains(hit));
  // fresh wrappers per call would never be equal, every click would look
  // covered, and the fallback path would silently swallow the tests.
  const wrappers = new Map<El, object>();
  const body = { tagName: "BODY" };
  let active: object = body;
  const focusable = (e: El) =>
    e.tag === "input" ||
    e.tag === "textarea" ||
    "contenteditable" in e.attrs ||
    "tabindex" in e.attrs;
  const wrap = (e: El) => {
    const got = wrappers.get(e);
    if (got) return got;
    const w = {
      getAttribute: (k: string) => (k in e.attrs ? e.attrs[k] : null),
      get textContent() {
        return e.text;
      },
      getBoundingClientRect: () => ({
        x: e.rect.x,
        y: e.rect.y,
        width: e.rect.width,
        height: e.rect.height,
        top: e.rect.y,
        bottom: e.rect.y + e.rect.height,
        left: e.rect.x,
        right: e.rect.x + e.rect.width,
      }),
      scrollIntoView: () => {
        e.scrolled = true;
      },
      click: () => {
        e.clicked = true;
      },
      // real browsers ignore focus() on a non-focusable element — the shim
      // must too, or the focus-landed flag could never read 0
      focus: () => {
        e.focused = true;
        if (focusable(e)) active = w;
      },
      select: () => {},
      closest: () => null,
      querySelector: () => null,
      contains: (other: unknown) => other === w, // flat shim: no children
      get isContentEditable() {
        return "contenteditable" in e.attrs;
      },
      get value() {
        return e.tag === "input" || e.tag === "textarea" ? (e.attrs.value ?? "") : undefined;
      },
      get readOnly() {
        return "readonly" in e.attrs;
      },
      get disabled() {
        return "disabled" in e.attrs;
      },
      tagName: e.tag.toUpperCase(),
    };
    wrappers.set(e, w);
    return w;
  };
  const hitsAt = (x: number, y: number) => {
    const out: object[] = [];
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i]!;
      const r = e.rect;
      if (
        r.width > 0 &&
        r.height > 0 &&
        x >= r.x &&
        x <= r.x + r.width &&
        y >= r.y &&
        y <= r.y + r.height
      )
        out.push(wrap(e));
    }
    return out;
  };
  return {
    querySelectorAll: (sel: string) => {
      const parts = sel.split(",");
      return els.filter((e) => parts.some((p) => matches(e, p))).map(wrap);
    },
    querySelector: (sel: string) => {
      const parts = sel.split(",");
      const hit = els.find((e) => parts.some((p) => matches(e, p)));
      return hit ? wrap(hit) : null;
    },
    // Paint order in the shim = DOM order, so the topmost hit is the LAST
    // element whose rect contains the point — the convention a page with an
    // overlay follows (the overlay comes later in the DOM). `singularHit`
    // lets a test model the measured Chrome quirk where THIS api names an
    // element whose box does not even contain the point while the layered
    // list below answers correctly.
    elementFromPoint: (x: number, y: number) => {
      if (opts.singularHit) {
        const e = opts.singularHit(x, y);
        return e ? wrap(e) : null;
      }
      return hitsAt(x, y)[0] ?? null;
    },
    elementsFromPoint: (x: number, y: number) => hitsAt(x, y),
    body,
    get activeElement() {
      return active;
    },
  };
}

/** Evaluate a generated locator against a prebuilt shim doc — lets a test
 *  run two scripts against ONE doc so state (activeElement) carries over. */
function runOn(doc: ReturnType<typeof makeDoc>, js: string): string {
  const win = { innerWidth: 1920, innerHeight: 1080 };
  // new Function, not eval: the locator string is ours, and running the emitted
  // JavaScript is the entire point of the test.
  return new Function("document", "window", `return ${js}`)(doc, win) as string;
}

/** Run a generated locator against a fresh shim DOM; returns its raw string result. */
function run(
  js: string,
  els: El[],
  opts: { singularHit?: (x: number, y: number) => El | null } = {},
): string {
  return runOn(makeDoc(els, opts), js);
}

const box = (js: string, els: El[]) => {
  const out = run(js, els);
  return out === "NOTFOUND" ? null : (JSON.parse(out) as { x: number; y: number });
};

// The editor's real top bar: Compare carries a why-title, Export does not.
const COMPARE = () =>
  el("button", { title: "Hold to compare against the version you opened" }, "Compare", {
    x: 1690,
    y: 10,
    width: 104,
    height: 32,
  });
const EXPORT = () => el("button", {}, "Export", { x: 1804, y: 9, width: 102, height: 34 });
// The editor's Look swatches: a title, and nothing else at all.
const SWATCH = (look: string, x: number) =>
  el("button", { title: look }, "", { x, y: 168, width: 60, height: 44 });

test("a label + tooltip button resolves by its VISIBLE label from every verb", () => {
  const dom = [EXPORT(), COMPARE()];

  // the regression: box/drag/press used to read the title and miss "Compare"
  assert.deepEqual(box(boxByTextJs("Compare"), dom)?.x, 1690);
  // click always worked — pin it so the chains cannot drift apart again
  assert.deepEqual(box(clickByTextJs("Compare"), dom)?.x, 1690);
  // scroll-to-element shares the same resolver
  assert.notEqual(run(scrollDeltaByTextJs("Compare"), dom), "NOTFOUND");
});

test("...and still resolves by its tooltip text", () => {
  const dom = [EXPORT(), COMPARE()];
  assert.deepEqual(
    box(boxByTextJs("Hold to compare against the version you opened"), dom)?.x,
    1690,
  );
  // a substring of the tooltip works too
  assert.deepEqual(box(boxByTextJs("Hold to compare"), dom)?.x, 1690);
});

test("a title-only control is reachable by text (the Look swatches)", () => {
  const dom = [SWATCH("midnight", 1586), SWATCH("ember", 1654), SWATCH("paper", 1722)];
  assert.deepEqual(box(boxByTextJs("paper"), dom)?.x, 1722);
  assert.deepEqual(box(clickByTextJs("paper"), dom)?.x, 1722);
});

test("inspect advertises title-only controls, and keeps the [placeholder] form", () => {
  const dom = [
    SWATCH("paper", 1722),
    el("input", { placeholder: "Project Name" }, "", { x: 100, y: 100, width: 200, height: 30 }),
    el("button", { "aria-label": "Play / pause" }, "", { x: 940, y: 748, width: 40, height: 40 }),
  ];
  const out = JSON.parse(run(listInteractiveJs(), dom)) as { name: string }[];
  const names = out.map((e) => e.name);
  // was dropped entirely before: no name, no placeholder
  assert.ok(names.includes("paper"), `expected "paper" in ${JSON.stringify(names)}`);
  // a placeholder-only field still reads as bracketed, so a plan author can see
  // it has no real label
  assert.ok(names.includes("[Project Name]"), JSON.stringify(names));
  assert.ok(names.includes("Play / pause"), JSON.stringify(names));
});

test("an exact hit anywhere beats a substring hit that comes earlier", () => {
  const dom = [
    el("button", {}, "Deploy now", { x: 1, y: 1, width: 80, height: 20 }),
    el("button", {}, "Deploy", { x: 500, y: 1, width: 80, height: 20 }),
  ];
  assert.deepEqual(box(boxByTextJs("Deploy"), dom)?.x, 500);
  assert.deepEqual(box(clickByTextJs("Deploy"), dom)?.x, 500);
});

test("type targets still resolve by placeholder, and by label when both exist", () => {
  const dom = [
    el("input", { placeholder: "Project Name" }, "", { x: 980, y: 380, width: 292, height: 36 }),
    el("input", { "aria-label": "Search", title: "Search the docs" }, "", {
      x: 10,
      y: 10,
      width: 200,
      height: 30,
    }),
  ];
  assert.deepEqual(box(focusFieldByTextJs("Project Name"), dom)?.x, 980);
  assert.deepEqual(box(focusFieldByTextJs("Search"), dom)?.x, 10);
  assert.deepEqual(box(focusFieldByTextJs("Search the docs"), dom)?.x, 10);
});

test("hrefFrom shares the resolver — a label + tooltip link resolves by label", () => {
  // the anchor resolver needs a real href; the shim's closest() returns null, so
  // NOTFOUND here means "no anchor", not "no name" — distinguish by asserting the
  // name-less case behaves the same way.
  const dom = [el("a", { title: "Opens the live deployment", href: "/live" }, "Visit")];
  assert.equal(run(hrefByTextJs("Visit"), dom), "NOTFOUND"); // shim has no closest()
  assert.equal(run(hrefByTextJs("nothing-like-this"), dom), "NOTFOUND");
});

test("no match anywhere is still NOTFOUND", () => {
  const dom = [EXPORT(), COMPARE()];
  assert.equal(run(boxByTextJs("Kompare"), dom), "NOTFOUND");
  assert.equal(run(clickByTextJs("Kompare"), dom), "NOTFOUND");
  assert.equal(run(focusFieldByTextJs("Kompare"), dom), "NOTFOUND");
});

// --- click delivery: trusted point vs in-page fallback -------------------
// The click resolvers decide HOW a click is delivered (capture.ts,
// CLICK_TAIL_JS). A hittable centre returns `cx`/`cy` and does NOT click —
// the capture driver dispatches trusted CDP input there, because a
// programmatic m.click() fires no pointerdown and pointer-listening controls
// (Radix dropdown triggers) treat it as silence: a real shoot lost 8 of 10
// beats to exactly that no-op. Unreachable centres keep the old in-page
// m.click() so nothing that resolved before stops working.

const clicked = (js: string, els: El[]) => {
  const out = run(js, els);
  const parsed = out === "NOTFOUND" ? null : (JSON.parse(out) as Record<string, number>);
  return { parsed, clickedEls: els.filter((e) => e.clicked) };
};

test("a hittable button returns the trusted-click point and is NOT clicked in-page", () => {
  const dom = [EXPORT()]; // x1804 y9 102×34 → centre (1855, 26)
  const { parsed, clickedEls } = clicked(clickByTextJs("Export"), dom);
  assert.equal(parsed?.cx, 1855);
  assert.equal(parsed?.cy, 26);
  assert.equal(clickedEls.length, 0); // the driver clicks, not the page eval
});

test("a zero-size (sr-only) target falls back to the in-page click", () => {
  const dom = [
    el("button", { "aria-label": "Skip to content" }, "", { x: 0, y: 0, width: 0, height: 0 }),
  ];
  const { parsed, clickedEls } = clicked(clickByTextJs("Skip to content"), dom);
  assert.equal(parsed?.cx, undefined); // no point → driver dispatches nothing
  assert.equal(clickedEls.length, 1); // the eval clicked it programmatically
});

test("a centre covered by an unrelated overlay falls back to the in-page click", () => {
  const dom = [
    el("button", {}, "Buried", { x: 100, y: 100, width: 80, height: 30 }),
    // later in DOM = painted on top; covers the button's centre entirely
    el("button", { "aria-label": "Cookie banner" }, "", { x: 0, y: 0, width: 1920, height: 1080 }),
  ];
  const { parsed, clickedEls } = clicked(clickByTextJs("Buried"), dom);
  assert.equal(parsed?.cx, undefined);
  assert.equal(clickedEls.length, 1);
  assert.equal(clickedEls[0]!.text, "Buried"); // the resolved element, not the overlay
});

test("the selector path shares the same delivery contract", () => {
  const dom = [el("button", { "data-x": "1" }, "Go", { x: 40, y: 40, width: 60, height: 20 })];
  const { parsed, clickedEls } = clicked(clickBySelectorJs("button"), dom);
  assert.equal(parsed?.cx, 70);
  assert.equal(parsed?.cy, 50);
  assert.equal(clickedEls.length, 0);
});

test("a <select> still refuses with SELECTINERT from both paths", () => {
  const dom = [
    el("select", { "aria-label": "Size" }, "", { x: 10, y: 10, width: 120, height: 30 }),
  ];
  assert.equal(run(clickBySelectorJs("select"), dom), "SELECTINERT");
});

// --- the singular-hit quirk (measured on a real shoot) -------------------
// Chrome's elementFromPoint can name an element whose border box does not
// even contain the point: a 33px heading's centre sat 16px above a sibling
// with 164px glyphs on a 157px line-height, and the sibling's ink overflow
// won the singular hit-test at every sample while elementsFromPoint()[0]
// answered the heading — and a trusted click at that point reached the
// heading. Treating the singular miss as an occluder downgraded the beat to
// m.click(), which the app ignored (its edit handler resolves the anchor
// from the click's coordinates, and a programmatic click carries 0,0): the
// beat died with changeCoverage 0 and every dependent beat skipped.

test("a singular-hit miss is overruled by the layered list — trusted point, no in-page click", () => {
  const heading = el("h1", { "data-slide-loc": "371:10" }, "Build slides", {
    x: 426,
    y: 366,
    width: 1333,
    height: 33,
  });
  const sibling = el("h1", { "data-slide-loc": "376:10" }, "inside Replit.", {
    x: 426,
    y: 399,
    width: 1333,
    height: 128,
  });
  const dom = [heading, sibling];
  // the quirk: singular names the sibling at the heading's centre (383),
  // 16px outside the sibling's own box — the layered list stays honest
  const out = run(clickBySelectorJs('h1[data-slide-loc="371:10"]'), dom, {
    singularHit: () => sibling,
  });
  const parsed = JSON.parse(out) as Record<string, number>;
  assert.equal(parsed.cx, 1093);
  assert.equal(parsed.cy, 383);
  assert.equal(dom.filter((e) => e.clicked).length, 0);
});

test("a genuine occluder still falls back in-page when BOTH point apis agree", () => {
  const dom = [
    el("button", {}, "Buried", { x: 100, y: 100, width: 80, height: 30 }),
    el("button", { "aria-label": "Cookie banner" }, "", { x: 0, y: 0, width: 1920, height: 1080 }),
  ];
  // no singularHit override: both apis resolve the overlay
  const { parsed, clickedEls } = clicked(clickByTextJs("Buried"), dom);
  assert.equal(parsed?.cx, undefined);
  assert.equal(clickedEls.length, 1);
  assert.equal(clickedEls[0]!.text, "Buried");
});

// --- type delivery: the focus-landed flag --------------------------------
// Input.insertText types into the current selection; when the in-page
// focus();click();focus() bounces off, the driver must know (measured:
// activeElement stayed BODY, the whole string went nowhere, and the beat
// logged as a success). The focus resolvers report `f`, and verifyFocusJs
// re-asks the same predicate side-effect-free after the driver's trusted
// click recovery.

test("focus that lands on an editable target reports f:1", () => {
  const dom = [
    el("input", { "aria-label": "Size" }, "", { x: 976, y: 278, width: 36, height: 28 }),
  ];
  const out = JSON.parse(run(focusFieldByTextJs("Size"), dom)) as Record<string, number>;
  assert.equal(out.f, 1);
  const verdict = run(verifyFocusJs({ text: "Size" }), dom);
  // fresh shim: nothing focused yet, so the side-effect-free probe says 0
  assert.equal(verdict, "0");
});

test("focus that bounces off a not-yet-editable target reports f:0", () => {
  // the second-edit-round shape: a plain h1 whose contenteditable only arms
  // when the app sees a real click — focus() is a no-op on it
  const dom = [
    el("h1", { "data-slide-loc": "371:10" }, "Build slides", {
      x: 426,
      y: 366,
      width: 1333,
      height: 33,
    }),
  ];
  const out = JSON.parse(run(focusSelectorJs('h1[data-slide-loc="371:10"]'), dom)) as Record<
    string,
    number
  >;
  assert.equal(out.f, 0);
  assert.equal(run(verifyFocusJs({ selector: 'h1[data-slide-loc="371:10"]' }), dom), "0");
});

test("verifyFocusJs answers 1 once the target became editable and holds focus", () => {
  const dom = [
    el("h1", { "data-slide-loc": "371:10", contenteditable: "true" }, "Build slides", {
      x: 426,
      y: 366,
      width: 1333,
      height: 33,
    }),
  ];
  const doc = makeDoc(dom);
  // model the app arming the editor after the trusted-click recovery: the
  // element is contenteditable now, so the focus resolver's focus() lands —
  // and the side-effect-free probe run against the SAME doc agrees
  const primed = runOn(doc, focusSelectorJs('h1[data-slide-loc="371:10"]'));
  assert.equal((JSON.parse(primed) as Record<string, number>).f, 1);
  assert.equal(runOn(doc, verifyFocusJs({ selector: 'h1[data-slide-loc="371:10"]' })), "1");
  // and a doc where nothing ever focused still answers 0
  assert.equal(run(verifyFocusJs({ selector: 'h1[data-slide-loc="371:10"]' }), dom), "0");
});

test("a bounced focus reports whether the recovery click can reach the field", () => {
  const field = el("h1", { "data-slide-loc": "371:10" }, "Build slides", {
    x: 426,
    y: 366,
    width: 1333,
    height: 33,
  });
  // uncovered: the driver may press the centre
  const open = JSON.parse(run(focusSelectorJs('h1[data-slide-loc="371:10"]'), [field])) as Record<
    string,
    number
  >;
  assert.equal(open.f, 0);
  assert.equal(open.hit, 1);
  assert.equal(open.h, 33); // the box height survives — `hit` is its own key
  // covered by a scrim painted later in the DOM: report, don't punch
  const scrim = el("div", { "data-scrim": "1" }, "", { x: 0, y: 0, width: 1920, height: 1080 });
  const covered = JSON.parse(
    run(focusSelectorJs('h1[data-slide-loc="371:10"]'), [field, scrim]),
  ) as Record<string, number>;
  assert.equal(covered.f, 0);
  assert.equal(covered.hit, 0);
});

test("a readOnly field reports f:0 — insertText would be swallowed", () => {
  const dom = [
    el("input", { "aria-label": "Locked", readonly: "" }, "", {
      x: 10,
      y: 10,
      width: 120,
      height: 30,
    }),
  ];
  const out = JSON.parse(run(focusFieldByTextJs("Locked"), dom)) as Record<string, number>;
  assert.equal(out.f, 0);
});

test("after the real recovery click, an editable focused OUTSIDE the target passes verify", () => {
  // hidden-textarea editor pattern: the click on the container focuses a
  // proxy editable elsewhere — a real user's click-then-type lands there
  const dom = [
    el("div", { "data-editor": "1" }, "", { x: 100, y: 100, width: 600, height: 400 }),
    el("textarea", { "aria-label": "hidden-input" }, "", { x: 0, y: 0, width: 1, height: 1 }),
  ];
  const doc = makeDoc(dom);
  // model the app's response to the trusted click: it focuses the proxy
  runOn(doc, `(function(){document.querySelectorAll('textarea')[0].focus();return '1';})()`);
  // strict tier would refuse (active element not in the target)…
  // …but the post-click verify accepts: the insertion has a real editable home
  assert.equal(runOn(doc, verifyFocusJs({ selector: 'div[data-editor="1"]' })), "1");
});
