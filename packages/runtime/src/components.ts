// `open-take components`: the component inventory of a shoot, a take, or a
// folder of saved screens. Screens saved before the component probe existed
// (no parts.json), or measured before it kept each part's full text and
// fields, are measured first — one page in one Chrome, as the fidelity check
// opens them (dom-state.ts measureStateDirs); the rest is the compositor's
// gather, which needs no browser.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type ComponentSource,
  type ComponentsFile,
  gatherComponents,
  readComponentSource,
  readStateIndex,
  writeComponents,
} from "@open-take/compositor";
import { ensureChrome, launchBrowser } from "./cdp";
import { measureStateDirs } from "./dom-state";

export type InventoryOpts = {
  /** a shoot's folder, a take (its .mp4 or .take/), a saved screen, or a folder of them */
  path: string;
  /** measure only this screen (when it has no parts.json, or with minArea) */
  state?: string;
  /** re-measure with this size floor (a fraction of the screen); measures
   *  every screen in scope again */
  minArea?: number;
  /** false: never open Chrome — screens without parts.json stay unmeasured */
  measure?: boolean;
  chromePath?: string;
  /** write components.json (default true) */
  write?: boolean;
};

export type InventoryResult = {
  file: ComponentsFile;
  /** components.json, when written */
  path?: string;
  source: ComponentSource;
  /** screens measured now, and how long that took in all (Chrome included) */
  measured: string[];
  measureMs: number;
  /** screens that could not be measured, and why */
  failed: { state: string; why: string }[];
};

/** parts.json is there and was measured with full values (each part's
 *  `text`, which the probe has written since it kept values whole) */
export function partsCurrent(dir: string): boolean {
  try {
    const f = JSON.parse(readFileSync(join(dir, "parts.json"), "utf8")) as {
      parts?: { text?: unknown }[];
    };
    return Array.isArray(f.parts) && f.parts.every((p) => typeof p.text === "string");
  } catch {
    return false;
  }
}

const writtenSince = (p: string, t: number): boolean => {
  try {
    return statSync(p).mtimeMs >= t;
  } catch {
    return false;
  }
};

/** Measure what is missing, gather, and write `<root>/components.json`. */
export async function inventoryComponents(opts: InventoryOpts): Promise<InventoryResult> {
  const source = readComponentSource(opts.path);
  if (opts.state && !source.states.some((s) => s.id === opts.state))
    throw new Error(
      `components: no saved screen ${opts.state} here (it has ${source.states.map((s) => s.id).join(", ") || "none"})`,
    );
  const scope = source.states.filter((s) => !opts.state || s.id === opts.state);
  const need = scope.filter(
    (s) =>
      typeof readStateIndex(s.dir) !== "string" && (opts.minArea != null || !partsCurrent(s.dir)),
  );
  const measured: string[] = [];
  const failed: { state: string; why: string }[] = [];
  let measureMs = 0;
  if (need.length && opts.measure !== false) {
    const t0 = Date.now();
    const first = readStateIndex(need[0]!.dir);
    const vp = typeof first === "string" ? { w: 1920, h: 1080 } : first.viewport;
    const browser = await launchBrowser({
      width: vp.w,
      height: vp.h,
      chromePath: await ensureChrome(opts.chromePath),
    });
    const idOf = new Map(need.map((s) => [s.dir, s.id]));
    // a Chrome that stops answering (seen now and then mid-run, a send that
    // never returns) must not hang the verb: past the budget the browser is
    // closed and what was written so far is gathered; the rest say why
    const budgetMs = Math.max(60_000, need.length * 20_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<"stalled">((res) => {
      timer = setTimeout(() => res("stalled"), budgetMs);
    });
    try {
      const r = await Promise.race([
        measureStateDirs({
          browser,
          dirs: need.map((s) => s.dir),
          ...(opts.minArea != null ? { minArea: opts.minArea } : {}),
        }),
        stalled,
      ]);
      if (r === "stalled") {
        for (const s of need)
          if (writtenSince(join(s.dir, "parts.json"), t0)) measured.push(s.id);
          else
            failed.push({
              state: s.id,
              why: `Chrome stopped answering — measuring stopped after ${Math.round(budgetMs / 1000)} s; run it again to measure the rest`,
            });
      } else {
        for (const m of r.measured) measured.push(idOf.get(m.dir) ?? m.dir);
        for (const f of r.failed) failed.push({ state: idOf.get(f.dir) ?? f.dir, why: f.why });
      }
    } finally {
      clearTimeout(timer);
      await browser.close();
    }
    measureMs = Date.now() - t0;
  }
  const file = gatherComponents(source);
  const path = opts.write === false ? undefined : writeComponents(file, source.root);
  return { file, ...(path ? { path } : {}), source, measured, measureMs, failed };
}
