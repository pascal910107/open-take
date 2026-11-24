// physics-seeds.mjs — which seeds of a film's physics scene come to rest
// readable. Run in Node, before the seed is written into the page:
//
//   node lib/physics-seeds.mjs scene.mjs vendor/rapier.mjs [--seeds 1-20]
//        [--scene <export>] [--check <export>] [--json]
//
// scene.mjs is the film's own module that the page imports too (nothing in it
// may touch window, document or process when it loads). It exports
// scene(seed) → a scene for lib/physics.js's bake(), and may export
// check(baked, scene) → { ok, ...whatever explains it }: what readable means
// for this film (the right number of chips in each column, the logo face up).
// Without check, a seed is clean when settle() says so: nothing moving or
// turning over any frame of the last 0.2 s, and level within 10°. --scene /
// --check name other exports (a --check the module lacks is an error).
// Exits 1 when no seed is clean or a seed threw, 2 on a command it can't read.
//
// Each seed is baked twice; a seed whose two hashes differ is not
// deterministic and is reported as such (it never has been, with Rapier or
// ammo, but a scene that reads a clock or Math.random would be). The hashes
// are the ones the page publishes as window.__bake: the same engine file gives
// the same numbers in Node 22 and in the renderer's Chrome.
//
// Scale: 40 chips settling for 2.6 s bake in 30–150 ms, so 20 seeds (each
// baked twice) take 1–6 s. In the bar chart that this was measured on, 6 of
// 20 seeds came out clean with Rapier and 7 of 20 with ammo; the unclean ones
// had a chip leaning on its neighbour, still creeping, or trembling in place.

import { readFileSync, realpathSync } from "node:fs";
import { createRequire, Module } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { adapters, bake, settle } from "./physics.js";

/**
 * Loads an engine file in Node. Rapier's compat build is an ES module; ammo's
 * is a CommonJS/UMD script, compiled here as CommonJS whatever the folder's
 * package.json says (under "type": "module" Node would read it as ESM and
 * find nothing exported). It finds ammo.wasm.wasm beside itself.
 * @param {string} file @returns {Promise<{ kind: string, make: () => import("./physics.js").Adapter }>}
 */
export async function loadEngine(file) {
  const path = resolve(file);
  const name = basename(path);
  hush(+1); // Rapier warns about its own init parameters
  try {
    if (/rapier/i.test(name)) {
      const mod = await import(pathToFileURL(path).href);
      const R = mod.default ?? mod;
      await R.init?.();
      return { kind: "rapier", make: () => adapters.rapier(R) };
    }
    if (/ammo/i.test(name)) {
      const m = /** @type {any} */ (new Module(path));
      m.filename = path;
      m.paths = /** @type {any} */ (Module)._nodeModulePaths(dirname(path));
      m.require = createRequire(path);
      m._compile(readFileSync(path, "utf8"), path);
      const A = await m.exports();
      return { kind: "ammo", make: () => adapters.ammo(A) };
    }
  } finally {
    hush(-1);
  }
  throw new Error(`physics-seeds: can't tell which engine ${file} is (its name has neither "rapier" nor "ammo" in it)`);
}

let hushed = 0, warn = console.warn;
/** console.warn off while any load is under way, back when the last ends
 *  @param {1 | -1} d */
function hush(d) {
  if (d > 0 && hushed++ === 0) {
    warn = console.warn;
    console.warn = () => {};
  }
  if (d < 0 && --hushed === 0) console.warn = warn;
}

/** "1-20" or "3,7,12" → seeds @param {string} s @returns {number[]} */
export function parseSeeds(s) {
  return s.split(",").flatMap((part) => {
    const p = part.trim(), m = /^(\d+)-(\d+)$/.exec(p);
    if (m && Number(m[1]) <= Number(m[2])) {
      const out = [];
      for (let k = Number(m[1]); k <= Number(m[2]); k++) out.push(k);
      return out;
    }
    if (/^\d+$/.test(p)) return [Number(p)];
    throw new Error(`physics-seeds: "${part}" is not a seed — give whole numbers and ranges, low to high: 1-20, or 3,7,12`);
  });
}

/**
 * Bakes the scene at each seed (twice) and judges it.
 * @param {{ scene: (seed: number) => import("./physics.js").Scene,
 *   check?: (b: import("./physics.js").Baked, s: import("./physics.js").Scene) => { ok: boolean } & Record<string, unknown> }} mod
 * @param {() => import("./physics.js").Adapter} make
 * @param {number[]} seeds
 */
export function checkSeeds(mod, make, seeds) {
  return seeds.map((seed) => {
    try {
      const sc = mod.scene(seed);
      const a = bake(make(), sc), b = bake(make(), mod.scene(seed));
      const s = settle(a);
      const verdict = mod.check ? mod.check(a, sc) : { ok: s.clean };
      const same = a.hash === b.hash;
      return {
        seed,
        ok: Boolean(verdict.ok) && same,
        hash: a.hash,
        same,
        maxSpeed: s.maxSpeed,
        maxTilt: s.maxTilt,
        moving: s.moving.length,
        tilted: s.tilted.length,
        verdict,
      };
    } catch (e) {
      return { seed, ok: false, error: String(/** @type {Error} */ (e)?.message ?? e) };
    }
  });
}

const USAGE = "usage: node lib/physics-seeds.mjs <scene.mjs> <engine file> [--seeds 1-20] [--scene <export>] [--check <export>] [--json]";

/** The command line, read: exits 2 on anything it does not know.
 *  @param {string[]} argv @returns {{ sceneFile: string, engineFile: string, seeds: number[], sceneName: string, checkName: string, checkGiven: boolean, json: boolean }} */
export function parseArgs(argv) {
  const files = [], o = { seeds: "1-20", scene: "scene", check: "check" };
  let json = false, checkGiven = false;
  for (let k = 0; k < argv.length; k++) {
    const a = /** @type {string} */ (argv[k]);
    if (a === "--json") json = true;
    else if (a === "--seeds" || a === "--scene" || a === "--check") {
      const v = argv[++k];
      if (v == null || v.startsWith("--")) throw new Error(`physics-seeds: ${a} needs a value\n${USAGE}`);
      o[/** @type {"seeds" | "scene" | "check"} */ (a.slice(2))] = v;
      if (a === "--check") checkGiven = true;
    } else if (a.startsWith("-")) throw new Error(`physics-seeds: no option ${a}\n${USAGE}`);
    else files.push(a);
  }
  const [sceneFile, engineFile, ...more] = files;
  if (!sceneFile || !engineFile || more.length) throw new Error(USAGE);
  return { sceneFile, engineFile, seeds: parseSeeds(o.seeds), sceneName: o.scene, checkName: o.check, checkGiven, json };
}

async function main() {
  let a;
  try {
    a = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(/** @type {Error} */ (e).message);
    process.exit(2);
  }
  const { sceneFile, engineFile, seeds, sceneName, checkName, json } = a;
  const mod = await import(pathToFileURL(resolve(sceneFile)).href);
  const missing =
    typeof mod[sceneName] !== "function" ? `${sceneName}(seed)` : a.checkGiven && typeof mod[checkName] !== "function" ? `${checkName}(baked, scene)` : null;
  if (missing) {
    console.error(`physics-seeds: ${sceneFile} exports no ${missing}`);
    process.exit(2);
  }
  const { kind, make } = await loadEngine(engineFile);
  const rows = checkSeeds({ scene: mod[sceneName], check: mod[checkName] }, make, seeds);
  const ok = rows.filter((r) => r.ok).map((r) => r.seed);
  // 1 when no seed is clean or one threw: a script can tell
  if (!ok.length || rows.some((r) => "error" in r)) process.exitCode = 1;
  if (json) {
    console.log(JSON.stringify({ engine: kind, seeds: rows, clean: ok }, null, 2));
    return;
  }
  console.log(`${kind}, ${basename(sceneFile)} ${sceneName}(seed)${mod[checkName] ? ` judged by ${checkName}()` : " judged by settle()"}`);
  console.log("seed  ok  hash      speed m/s  tilt°   notes");
  for (const r of rows) {
    if ("error" in r) {
      console.log(`${String(r.seed).padStart(4)}  --  threw: ${r.error}`);
      continue;
    }
    const { ok: _ok, ...why } = /** @type {Record<string, unknown>} */ (r.verdict);
    const notes = [r.same ? "" : "NOT DETERMINISTIC (two bakes differ)", r.moving ? `${r.moving} moving` : "", r.tilted ? `${r.tilted} tilted` : "", Object.keys(why).length ? JSON.stringify(why) : ""]
      .filter(Boolean)
      .join("; ");
    console.log(
      `${String(r.seed).padStart(4)}  ${r.ok ? "ok" : "--"}  ${r.hash}  ${String(r.maxSpeed).padStart(9)}  ${String(r.maxTilt).padStart(6)}  ${notes}`,
    );
  }
  console.log(ok.length ? `clean: ${ok.join(", ")} (${ok.length} of ${rows.length})` : `no clean seed in ${rows.length}`);
}

/** run as a command (through a symlink, from a folder with a space in its name, too) */
const real = (/** @type {string} */ p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) await main();
