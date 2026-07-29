// resolveNavigateUrl — the `navigate` step's destination rules. These are the
// cases that decide whether a two-page demo can be ONE take: the plan is
// written before the run, so the interesting destinations are the ones only the
// running app can supply.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveNavigateUrl } from "../src/nav";

const CURRENT = "https://app.example.com/projects/42";

test("an href read off the page beats a url written in the plan", () => {
  // the whole point of late binding: the plan guessed, the app knows
  assert.equal(
    resolveNavigateUrl({
      current: CURRENT,
      url: "https://guessed.example.com/",
      href: "https://my-app-gamma.vercel.app/",
    }),
    "https://my-app-gamma.vercel.app/",
  );
});

test("query params are merged onto the href the page supplied", () => {
  // the case a click could never produce: the page links to the bare domain,
  // the demo needs it parameterised to fit the animation in the shot
  assert.equal(
    resolveNavigateUrl({
      current: CURRENT,
      href: "https://my-app-gamma.vercel.app/",
      query: { speed: "3" },
    }),
    "https://my-app-gamma.vercel.app/?speed=3",
  );
});

test("a query param overwrites one already on the destination", () => {
  assert.equal(
    resolveNavigateUrl({
      current: CURRENT,
      url: "https://x.example.com/?speed=1&keep=yes",
      query: { speed: "3" },
    }),
    "https://x.example.com/?speed=3&keep=yes",
  );
});

test("query alone re-enters the CURRENT page with params", () => {
  assert.equal(
    resolveNavigateUrl({ current: CURRENT, query: { debug: "1" } }),
    `${CURRENT}?debug=1`,
  );
});

test("a relative url resolves against the current page", () => {
  assert.equal(
    resolveNavigateUrl({ current: CURRENT, url: "/pricing" }),
    "https://app.example.com/pricing",
  );
  assert.equal(
    resolveNavigateUrl({ current: CURRENT, url: "settings" }),
    "https://app.example.com/projects/settings",
  );
});

test("an absolute url ignores the current page", () => {
  assert.equal(
    resolveNavigateUrl({ current: CURRENT, url: "https://other.example.com/x" }),
    "https://other.example.com/x",
  );
});

test("no url, no href, no query resolves to the current page — a reload", () => {
  // not an error: re-entering the same URL is a real beat (show the app cold-
  // starting). It is a RELOAD, not a no-op — the step still navigates.
  assert.equal(resolveNavigateUrl({ current: CURRENT }), CURRENT);
});

test("an unresolvable destination is null, not a throw", () => {
  // a relative url with no usable base is the realistic way this happens
  assert.equal(resolveNavigateUrl({ current: "not a url", url: "/pricing" }), null);
  assert.equal(resolveNavigateUrl({ current: "", url: "" }), null);
});

test("an empty href falls through to the plan's url rather than blocking", () => {
  assert.equal(
    resolveNavigateUrl({ current: CURRENT, url: "/next", href: null }),
    "https://app.example.com/next",
  );
});
