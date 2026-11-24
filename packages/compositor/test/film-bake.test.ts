import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bakeGuard, eventsPathFor, filmStills, renderFilm } from "../src/film/render";
import { findChrome } from "./fixtures/find-chrome";

const page = (hash: string) => `<!doctype html><body style="margin:0;background:#123"><script>
  window.__bake = { hash: ${hash}, parts: {} };
  window.__film = { duration: 0.2, width: 64, height: 36 };
  window.__render = () => {};
</script>`;

test("the bake guard takes the first hash and stops on another", async () => {
  const guard = bakeGuard();
  const page = (hash: unknown) => ({ evaluate: async <T>() => hash as T });
  await guard.check(page(null));
  assert.equal(guard.hash, null);
  await guard.check(page("1c0e2a9f"));
  await guard.check(page("1c0e2a9f"));
  assert.equal(guard.hash, "1c0e2a9f");
  await assert.rejects(guard.check(page("77aa0b31")),
    /film: the physics bakes differ \(window\.__bake\.hash 1c0e2a9f in one page, 77aa0b31 in another worker\)/);
});

const chrome = findChrome();

test("a render stops when its workers bake different films, and records the hash when they agree", {
  skip: chrome ? false : "no Chrome for Testing",
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-film-bake-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const opts = { chromePath: chrome!, audio: null, draft: true, workers: 2 };
  // Math.random is seeded alike in every worker; crypto is not
  await writeFile(join(dir, "loose.html"), page("crypto.getRandomValues(new Uint32Array(1))[0].toString(16)"));
  await assert.rejects(
    renderFilm({ ...opts, page: join(dir, "loose.html"), out: join(dir, "loose.mp4") }),
    /the physics bakes differ/,
  );
  await writeFile(join(dir, "fixed.html"), page('"853dd369"'));
  const out = join(dir, "fixed.mp4");
  const r = await renderFilm({ ...opts, page: join(dir, "fixed.html"), out });
  assert.equal(r.bake, "853dd369");
  assert.equal(JSON.parse(await readFile(eventsPathFor(out), "utf8")).bake, "853dd369");
});

test("overlapping still shutters check the bake again when the clock starts over", {
  skip: chrome ? false : "no Chrome for Testing",
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-still-bake-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "clock.html");
  await writeFile(file, page("crypto.getRandomValues(new Uint32Array(1))[0].toString(16)")
    .replace("window.__render = () => {};", ""));
  await assert.rejects(filmStills({
    page: file, chromePath: chrome!, outDir: dir, at: [0.1, 0.101],
  }), /the physics bakes differ.*in a fresh page for the stills/);
});
