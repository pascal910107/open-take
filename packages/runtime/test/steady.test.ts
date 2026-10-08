// steady.ts without a browser: what changed between two readings of the
// screen, and the wait for it to hold still on a clock the test drives.

import assert from "node:assert/strict";
import { test } from "node:test";
import { type ShootLog, shootSteadyLine } from "../src/shoot";
import { type Screen, STEADY_QUIET_MS, screenChange, waitSteady } from "../src/steady";

const screen = (t: [string, number, number][], o: Partial<Screen> = {}): Screen => ({
  t,
  sx: 0,
  sy: 0,
  a: 0,
  ...o,
});

test("screenChange: a number on its way is paired with what it became, in page px", () => {
  const a = screen(
    [
      ["Total", 10, 10],
      ["993", 10, 60],
    ],
    { sy: 200 },
  );
  const b = screen(
    [
      ["Total", 10, 10],
      ["1,012", 4, 60],
    ],
    { sy: 200 },
  );
  const c = screenChange(a, b);
  assert.deepEqual(c.texts, [{ x: 10, y: 260, before: "993", after: "1,012" }]);
  assert.equal(c.moved, false, "a text that changed is not counted as moved too");
  assert.equal(c.animations, 0);
  assert.deepEqual(screenChange(a, a), { texts: [], moved: false, animations: 0 });
});

test("screenChange: text drawn elsewhere or a scroll is movement; a text that appears is a change", () => {
  const a = screen([["Menu", 0, 0]]);
  assert.equal(screenChange(a, screen([["Menu", 0, 6]])).moved, true);
  assert.equal(screenChange(a, screen([["Menu", 0, 0]], { sy: 1 })).moved, true);
  const grown = screenChange(
    a,
    screen([
      ["Menu", 0, 0],
      ["Saved", 40, 0],
    ]),
  );
  assert.deepEqual(grown.texts, [{ x: 40, y: 0, before: "", after: "Saved" }]);
  assert.equal(screenChange(screen([], { a: 2 }), screen([])).animations, 2);
});

/** a clock the wait runs on: each sleep moves it on */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

test("waitSteady: a still screen costs the quiet reading and is not called a change", async () => {
  const clock = fakeClock();
  const r = await waitSteady(async () => screen([["2,705", 0, 0]]), 3000, clock);
  assert.equal(r.steady, true);
  assert.equal(r.changed, false);
  assert.equal(r.waitedMs, STEADY_QUIET_MS);
});

test("waitSteady: waits out a count-up and a running animation, then holds", async () => {
  const clock = fakeClock();
  // counts for 600 ms, an animation runs to 800 ms, then nothing changes
  const read = async () => {
    const t = clock.now();
    return screen([[String(Math.min(2705, Math.round((2705 * t) / 600))), 0, 0]], {
      a: t < 800 ? 1 : 0,
    });
  };
  const r = await waitSteady(read, 3000, clock);
  assert.equal(r.steady, true);
  assert.equal(r.changed, true);
  // the last busy reading at 750 ms, then a quiet stretch
  assert.ok(r.waitedMs >= 750 + STEADY_QUIET_MS && r.waitedMs < 1000, `${r.waitedMs}`);
});

test("waitSteady: a screen that never holds still is taken when the budget runs out", async () => {
  const clock = fakeClock();
  const r = await waitSteady(async () => screen([[String(clock.now()), 0, 0]]), 500, clock);
  assert.deepEqual(r, { steady: false, waitedMs: 500, changed: true });
  // a page that cannot be read (a navigation) starts the reading over
  const c2 = fakeClock();
  let n = 0;
  const r2 = await waitSteady(async () => (n++ < 3 ? null : screen([])), 3000, c2);
  assert.equal(r2.steady, true);
  assert.equal(r2.changed, true);
});

test("shootSteadyLine: what was measured, or nothing", () => {
  const still = (name: string, extra: object = {}) => ({
    file: `${name}.png`,
    name,
    t: 0,
    cursor: { x: 0, y: 0 },
    scroll: { x: 0, y: 0 },
    boxes: {},
    ...extra,
  });
  const log: ShootLog = { viewport: { w: 8, h: 8 }, scale: 1, steady: true, stills: [still("a")] };
  assert.equal(shootSteadyLine(log), null);
  log.stills.push(
    still("b", { steadyMs: 1400 }),
    still("c", {
      moving: { texts: [{ x: 0, y: 0, before: "993", after: "1,012" }], animations: 0 },
    }),
  );
  const line = shootSteadyLine(log)!;
  assert.match(line, /1 of 3 stills taken while the screen was still changing/);
  assert.match(line, /"993" → "1,012"/);
  assert.match(line, /1 waited for it to stop, 1\.4 s in all/);
  assert.doesNotMatch(line, /should|too |issue/i);
});
