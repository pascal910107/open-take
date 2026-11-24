import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gsapTickerRunning } from "../src/film/clock";
import { renderFilm } from "../src/film/render";
import { findChrome } from "./fixtures/find-chrome";

const chrome = findChrome();

test("a GSAP ticker needs a running animation or a listener of the page's own", () => {
  const add = () => {};
  assert.equal(gsapTickerRunning({ ticker: { add }, globalTimeline: { getChildren: () => [] } }), false);
  assert.equal(gsapTickerRunning({ ticker: { add }, globalTimeline: { getChildren: () => [{ paused: () => true }] } }), false);
  assert.equal(gsapTickerRunning({ ticker: { add }, globalTimeline: { getChildren: () => [{}] } }), true);
  assert.equal(gsapTickerRunning({ ticker: { add, _listeners: [add, add] } }), true);
});

test("a render warns once for active library tickers in clock mode only", {
  skip: chrome ? false : "no Chrome for Testing",
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-film-ticker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const mode of ["clock", "render"]) {
    const page = join(dir, mode + ".html");
    // The GSAP ticker and the engine record anime v4's ESM build registers.
    await writeFile(page, `<!doctype html><body><p>Motion</p><script>
      window.__film = { duration: 0.1, width: 160, height: 90 };
      window.gsap = { ticker: { _listeners: [() => {}], add(fn) {
        this._listeners.push(fn);
        requestAnimationFrame(fn);
      } } };
      const engine = { reqId: 0 };
      window.AnimeJS = [{ version: "4.5.0", engine }];
      const tick = () => { engine.reqId = requestAnimationFrame(tick); };
      window.gsap.ticker.add(tick);
      ${mode === "render" ? "window.__render = () => {};" : ""}
    </script>`);
    const film = await renderFilm({
      page,
      out: join(dir, mode + ".mp4"),
      chromePath: chrome!,
      audio: null,
      draft: true,
      workers: 1,
    });
    assert.equal(film.mode, mode);
    const warnings = film.warnings.filter((w) => w.includes("ticker"));
    if (mode === "render") assert.deepEqual(warnings, []);
    else {
      assert.equal(warnings.length, 1);
      assert.match(
        warnings[0]!,
        /GSAP and anime\.js running on their own tickers.*their motion gets no blur.*cannot be probed in parallel/,
      );
      assert.match(warnings[0]!, /__render\(t\).*timeline\.seek\(t\).*animation\.seek\(t\*1000\)/);
    }
  }
});

test("GSAP loaded with nothing to run is not warned about", {
  skip: chrome ? false : "no Chrome for Testing",
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-film-idle-gsap-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const page = join(dir, "index.html");
  // GSAP 3's shape: one listener of its own, an empty global timeline
  await writeFile(page, `<!doctype html><body><p>Still</p><script>
    window.__film = { duration: 0.1, width: 160, height: 90 };
    window.gsap = {
      ticker: { _listeners: [() => {}], add() {}, sleep() {} },
      globalTimeline: { getChildren: () => [] },
    };
    window.gsap.ticker.sleep();
  </script>`);
  const film = await renderFilm({
    page, out: join(dir, "film.mp4"), chromePath: chrome!, audio: null, draft: true, workers: 1,
  });
  assert.equal(film.mode, "clock");
  assert.deepEqual(film.warnings.filter((w) => w.includes("ticker")), []);
});
