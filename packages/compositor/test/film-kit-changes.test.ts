// What an action changed (kit/media.js changesIn, wordDiff): components.json
// read by screen, innermost part first, before and now in whole words.

import assert from "node:assert/strict";
import { test } from "node:test";
import { changesIn, wordDiff } from "../kit/media.js";

const file = {
  version: 2,
  states: [
    { id: "empty", action: null },
    {
      id: "typed",
      action: {
        kind: "type",
        label: "rx",
        acted: "typed:e9",
        changes: ["typed:e1", "typed:e2", "typed:e3", "typed:e4"],
      },
    },
  ],
  components: [
    {
      ref: "empty:e2",
      kind: "heading",
      label: "Regex",
      values: { text: { text: "Substitution 3 replacements 2.1 ms" } },
      box: [0, 0, 400, 30],
    },
    // a panel round the count: changed too, but not the change itself
    {
      ref: "typed:e1",
      kind: "card",
      label: "Results",
      values: { text: { text: "Results 3 matches" } },
      box: [0, 40, 400, 200],
      facts: { changed: "Results → Results3 matches" },
    },
    {
      ref: "typed:e2",
      kind: "heading",
      label: "Regex",
      values: { text: { text: "Substitution 3 replacements 400 μs" } },
      box: [0, 0, 400, 30],
      before: "empty:e2",
      facts: { changed: "x → y" },
    },
    {
      ref: "typed:e3",
      kind: "stat",
      label: "3 matches",
      values: { text: { text: "3 matches" } },
      box: [10, 50, 80, 20],
      facts: { appeared: true },
    },
    {
      ref: "typed:e4",
      kind: "button",
      label: "Copy",
      box: [300, 50, 30, 30],
      facts: { restyled: "disabled: true → –" },
    },
  ],
};

test("changesIn: the parts an action changed, innermost first, with what they showed", () => {
  const c = changesIn(file, "typed");
  assert.equal(c.since, "empty");
  assert.deepEqual(c.action, { kind: "type", label: "rx", acted: "typed:e9" });
  assert.deepEqual(
    c.parts.map((p) => [p.ref, p.what, p.inner]),
    [
      ["typed:e2", "changed", true],
      ["typed:e3", "appeared", true],
      ["typed:e4", "restyled", true],
      ["typed:e1", "changed", false],
    ],
  );
  const h = c.parts[0]!;
  assert.equal(h.was, "Substitution 3 replacements 2.1 ms");
  assert.equal(h.added, "400 μs");
  assert.equal(h.removed, "2.1 ms");
  assert.deepEqual(h.box, { x: 0, y: 0, width: 400, height: 30 });
  const n = c.parts[1]!;
  assert.equal(n.was, null);
  assert.equal(n.added, "3 matches");
  assert.equal(c.parts[2]!.restyled, "disabled: true → –");
  assert.deepEqual(changesIn(file, "empty").parts, []);
  assert.throws(() => changesIn(file, "nope"), /no screen nope — components.json has empty, typed/);
});

test("wordDiff: whole words, run-together facts, a cut-short before", () => {
  assert.deepEqual(wordDiff("Regular Expression", "Regular Expression 3 matches"), {
    added: "3 matches",
    removed: "",
  });
  assert.deepEqual(
    wordDiff("Regular Expression3 matches46 steps800 …", "Regular Expression Pattern Error"),
    {
      added: "Pattern Error",
      removed: "3 matches46 steps800",
    },
  );
  assert.deepEqual(wordDiff("Flavor: PCRE2 (PHP)", "Flavor: Python"), {
    added: "Python",
    removed: "PCRE2 (PHP)",
  });
  assert.deepEqual(wordDiff("same", "same"), { added: "", removed: "" });
});

test("stills().changes, stills().output and a take's changes read what the shoot kept beside the log", async () => {
  const shots = {
    viewport: { w: 400, h: 300 },
    stills: [
      { file: "000-empty.png", name: "empty", t: 0, state: "empty" },
      { file: "001-k.png", name: "k-1", t: 1 },
      { file: "002-typed.png", name: "rx", t: 2, state: "typed" },
      { file: "003-after.png", name: "after", t: 3 },
    ],
    outputs: [
      {
        name: "result",
        file: "outputs/result.svg",
        kind: "svg",
        bytes: 10,
        t: 2.5,
        url: "https://p/",
        still: 2,
        after: "rx",
        w: 120,
        h: 80,
      },
    ],
  };
  const take = {
    viewport: { w: 400, h: 300 },
    events: [{ kind: "type", tMs: 900, x: 0, y: 0 }],
    states: {
      dir: "states",
      items: [
        { id: "empty", tMs: 0 },
        { id: "typed", tMs: 1200, step: 0 },
      ],
    },
  };
  const files: Record<string, unknown> = {
    "http://x/shots/shots.json": shots,
    "http://x/shots/components.json": file,
    "http://x/t.take/capture.json": take,
    "http://x/t.take/components.json": file,
  };
  const g = globalThis as unknown as { fetch: unknown; location: unknown };
  const was = { fetch: g.fetch, location: g.location };
  g.location = { href: "http://x/film/index.html" };
  g.fetch = async (u: URL | string) => {
    const body = files[new URL(String(u), "http://x/film/index.html").href];
    return { ok: body != null, status: body ? 200 : 404, json: async () => body };
  };
  try {
    const { stills, readTake } = await import("../kit/media.js");
    const st = await stills("../shots/shots.json", {} as HTMLImageElement);
    assert.equal(st.changes("typed").still, 2);
    assert.deepEqual(st.outputs, ["result"]);
    const o = st.output("result");
    assert.equal(o.url, "http://x/shots/outputs/result.svg");
    assert.equal(o.still, 2);
    assert.equal(o.kind, "svg");
    assert.throws(() => st.output("nope"), /saved nothing called "nope" — it has "result"/);
    assert.equal(st.changes(3).screen, "typed", "a still shows the last screen kept before it");
    assert.equal(st.changes("rx").parts[0]!.added, "400 μs");
    assert.equal(st.changes(1).screen, "empty");
    const t = await readTake("../t.take/");
    const c = t.changes(0);
    assert.equal(c.screen, "typed");
    assert.equal(c.tMs, 1200);
  } finally {
    g.fetch = was.fetch;
    g.location = was.location;
  }
});

test("changedLine: per screen, the innermost part that changed and the words it gained", async () => {
  const { changedLine } = await import("../src/film/components");
  const f = {
    ...file,
    source: { kind: "shoot", log: "shots.json", viewport: { w: 400, h: 300 } },
    states: file.states.map((s) => ({
      ...s,
      url: "",
      components: file.components.filter((e) => e.ref.startsWith(`${s.id}:`)).map((e) => e.ref),
    })),
    components: file.components.map((e) => ({
      ...e,
      box: e.box as [number, number, number, number],
      facts: e.facts ?? {},
    })),
  };
  const line = changedLine(f as never, "/tmp/film/shots", "/tmp/film");
  assert.match(
    line!,
    /^changed: typed heading "400 μs" \(\+1\) — \(await stills\("\/shots\/shots.json", img\)\)\.changes\("<screen>"\) in kit\/media.js/,
  );
  assert.equal(
    changedLine({ ...f, states: [f.states[0]!] } as never, "/tmp/film/shots", "/tmp/film"),
    null,
  );
});
