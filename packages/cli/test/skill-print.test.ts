// What `skill …` prints, read from the source skill (skills/open-take).
//
// The size checks are the point: an agent reads these from stdout, and a print
// past Claude Code's inline limit (about 30 KB) comes back as a 2 KB preview
// plus a file the session may not be allowed to open. Exp7's guide printed
// 32.7 KB in one piece and one session saw 200 of its 555 lines.
import assert from "node:assert/strict";
import { posix } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadSkillBundle } from "../src/init";
import { caseNames, FILM_TOPICS, skillPrint } from "../src/skill-print";

const DIR = fileURLToPath(new URL("../../../skills/open-take", import.meta.url));
const LIMIT = 24 * 1024;
const bytes = (s: string) => Buffer.byteLength(s);
const print = async (args: string[], all = false) =>
  skillPrint(await loadSkillBundle(DIR), DIR, { args, all });

test("skill film prints a core under 24 KB that names every topic and its files", async () => {
  const core = await print(["film"]);
  assert.ok(bytes(core) < LIMIT, `skill film is ${bytes(core)} bytes`);
  assert.ok(core.startsWith(`guide: ${DIR}/references/film.md\n`));
  assert.match(core, new RegExp(`cases: ${DIR}/references/cases/\n`));
  for (const heading of ["## One way to work", "## What's there for", "## Start"])
    assert.ok(core.includes(heading), heading);
  for (const topic of FILM_TOPICS) assert.ok(core.includes(`skill film ${topic}`), topic);
  assert.ok(core.includes("skill cases"));
  assert.ok(core.includes("skill film --all"));
});

// Exp11: the core's only handoff example was one morphRect to full frame, and
// one session wrote it at every scene change; the examples show several.
test("the core's code examples show handoffs of different kinds, not one", async () => {
  const core = await print(["film"]);
  const code = [...core.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
  const kinds = ["morphRect(", "carry(", "cam.cut(", "lift("].filter((k) => code.includes(k));
  assert.equal(kinds.length, 4, `handoffs in the core's examples: ${kinds.join(", ")}`);
  assert.ok(core.includes("a screen with more text than a viewer reads"));
});

test("each film topic prints on its own, under 24 KB, with its path", async () => {
  for (const topic of FILM_TOPICS) {
    const text = await print(["film", topic]);
    assert.ok(bytes(text) < LIMIT, `skill film ${topic} is ${bytes(text)} bytes`);
    assert.ok(text.startsWith(`guide: ${DIR}/references/film/${topic}.md\n`), topic);
    assert.match(text, /\n## /);
  }
  assert.equal(await print(["film", "MATERIAL"]), await print(["film", "material"]));
  await assert.rejects(print(["film", "nope"]), /no topic "nope" — topics: story, material, page/);
});

test("skill film --all is the core and every topic, material before the plumbing", async () => {
  const all = await print(["film"], true);
  const order = [
    "## One way to work",
    "## What's there for",
    "## Start",
    "## The first thing that can be run",
    "## Material from the real product",
    "## The page",
    "## Cutting on the music",
    "## The product's look",
    "## Look at it",
    "## Render",
    "## Sound",
    "## Cases",
    "## Numbers that are facts, not taste",
  ];
  const at = order.map((h) => all.indexOf(h));
  assert.ok(
    at.every((i, n) => i >= 0 && (n === 0 || i > at[n - 1]!)),
    `order: ${at.join(", ")}`,
  );
  assert.ok(!all.includes("## The rest of this guide"), "the core's topic list is left out");
  for (const topic of FILM_TOPICS) {
    const body = (await print(["film", topic])).split("\n").slice(3).join("\n").trimEnd();
    assert.ok(all.includes(body), topic);
  }
  await assert.rejects(print(["film", "material"], true), /--all prints every topic/);
  await assert.rejects(print(["cases"], true), /--all goes with `skill film`/);
});

test("every `skill film <word>` the guide mentions is a topic", async () => {
  const bundle = await loadSkillBundle(DIR);
  const texts = Object.entries(bundle.resources ?? {})
    .filter(([p]) => p === "references/film.md" || p.startsWith("references/film/"))
    .map(([, t]) => t)
    .concat(bundle.skillText);
  for (const text of texts)
    for (const m of text.matchAll(/`skill film ([a-z-]+)`/g))
      assert.ok((FILM_TOPICS as readonly string[]).includes(m[1]!) || m[1] === "--all", m[1]);
});

test("every relative link in the film guide and the cases resolves inside the skill", async () => {
  const bundle = await loadSkillBundle(DIR);
  const files = Object.keys(bundle.resources ?? {});
  for (const [path, text] of Object.entries(bundle.resources ?? {})) {
    if (!(path === "references/film.md" || /^references\/(film|cases)\//.test(path))) continue;
    for (const m of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      const link = m[1]!;
      if (/^[a-z]+:/i.test(link)) continue;
      const to = posix.normalize(posix.join(posix.dirname(path), link));
      assert.ok(files.includes(to), `${path} → ${link}`);
    }
  }
});

test("skill cases prints the index or one case, with the folder's path", async () => {
  const bundle = await loadSkillBundle(DIR);
  const names = caseNames(bundle);
  assert.ok(names.includes("carbon") && !names.includes("README"));
  const index = await print(["cases"]);
  assert.ok(bytes(index) < LIMIT, `skill cases is ${bytes(index)} bytes`);
  assert.ok(index.startsWith(`cases: ${DIR}/references/cases/ · each case: skill cases <`));
  assert.ok(index.includes(bundle.resources!["references/cases/README.md"]!));
  assert.equal(await print(["cases", "readme"]), index);
  for (const name of names) {
    const text = await print(["cases", name]);
    assert.ok(bytes(text) < LIMIT, name);
    assert.ok(text.includes(bundle.resources![`references/cases/${name}.md`]!), name);
  }
  assert.equal(await print(["cases", "Carbon.md"]), await print(["cases", "carbon"]));
  await assert.rejects(print(["cases", "nope"]), /no case "nope" — cases: carbon/);
});

test("skill and skill motion print what they printed before", async () => {
  const bundle = await loadSkillBundle(DIR);
  assert.equal(await print([]), bundle.skillText);
  assert.equal(await print(["motion"]), bundle.resources!["references/motion-composition.md"]);
  await assert.rejects(print(["nope"]), /expected motion, film/);
});
