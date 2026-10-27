// `film probe`'s provenance lines: where the values on screen come from, as
// information. The page says where with kit/time.js `tl.source` (a part of
// components.json, a live url, or a note — "demo", "illustrative");
// kit/media.js `readValues(url, { tl })` says it for every value it reads.
// The probe reads the film's own text (outside saved screens and lifted
// parts: those are the product's page) on the film clock, takes the numbers
// in it, and sets each beside the declared sources and the values the
// product's parts showed (components.json):
//
//   - declared: a source covers it (its element, its label or text, or the
//     values of the part it names);
//   - matches a part: no source says so, but a part of components.json
//     showed the same number;
//   - no source declared: neither.
//
// Nothing is graded and nothing is blocked: a number the saved screens did
// not keep can still be real (a formula, the product's code, a live page).
// A count's in-between numbers are the film's, not the product's — a value
// its element shows once, between two others, is counted apart and not
// listed.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { checkSources, type FilmSource } from "./render";

type How = "measured" | "estimated" | "not detected" | "not measured";
type Span = [number, number];

// --- the page ------------------------------------------------------------------------

/** One block of the film's own text at one moment: `k` the same element
 *  across samples, `text` its visible text in full, `cov` the indices of the
 *  page's sources whose selector holds it. */
export type ProvenanceItem = { k: number; text: string; cov: number[] };
export type ProvenanceSample = { t: number; items: ProvenanceItem[]; sources?: unknown };

/** An expression for the film's page (awaited): its own text, block by block
 *  (a caption split into spans is one block), as shown now — text outside
 *  the viewport, hidden or all but transparent is left out; iframes (saved
 *  screens, lifted parts) are not entered — and window.__film.sources as
 *  the page has it. Elements keep their number across calls on one page. */
export const PROVENANCE_PAGE_JS = `(async () => {
  const st = (window.__otProv ??= { ids: new WeakMap(), n: 0 });
  const idOf = (el) => { let k = st.ids.get(el); if (k == null) { k = ++st.n; st.ids.set(el, k); } return k; };
  let sources = window.__film?.sources;
  try { if (typeof sources === "function") sources = await sources(); } catch { sources = null; }
  sources = Array.isArray(sources) ? JSON.parse(JSON.stringify(sources)) : null;
  const sels = (sources ?? []).map((s) => (s && typeof s.selector === "string" ? s.selector : null));
  const vw = innerWidth, vh = innerHeight;
  const shown = new Map();
  const shows = (el) => {
    if (shown.has(el)) return shown.get(el);
    let o = 1, ok = true;
    for (let n = el; n && ok; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === "none") ok = false;
      o *= Number(cs.opacity);
      if (o < 0.05) ok = false;
    }
    if (ok && getComputedStyle(el).visibility !== "visible") ok = false;
    shown.set(el, ok);
    return ok;
  };
  const blocks = new Map();
  const range = document.createRange();
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const v = n.nodeValue ?? "";
      if (!v.trim()) continue;
      const el = n.parentElement;
      if (!el || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(el.tagName)) continue;
      if (!shows(el)) continue;
      range.selectNodeContents(n);
      const on = Array.from(range.getClientRects()).some(
        (r) => r.width >= 1 && r.height >= 1 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh,
      );
      if (!on) continue;
      let owner = el;
      while (
        owner.parentElement &&
        owner.parentElement !== document.body &&
        /^(inline|inline-block|inline-flex|contents)$/.test(getComputedStyle(owner).display)
      )
        owner = owner.parentElement;
      let b = blocks.get(owner);
      if (!b) {
        b = { k: idOf(owner), parts: [], cov: new Set() };
        blocks.set(owner, b);
      }
      b.parts.push(v);
      sels.forEach((sel, i) => {
        if (!sel) return;
        try { if (el.closest(sel)) b.cov.add(i); } catch {}
      });
    }
  }
  const items = [...blocks.values()].map((b) => ({
    k: b.k,
    text: b.parts.join("").replace(/\\s+/g, " ").trim(),
    cov: [...b.cov].sort((x, y) => x - y),
  }));
  return { items, sources };
})()`;

// --- numbers ---------------------------------------------------------------------------

export type NumberToken = { raw: string; norm: string };

const NUMBER_RE = /(?:[A-Z]{0,3}[$€£¥₩₹]\s?)?\d+(?:[.,]\d+)*(?:\s?%)?/g;

/** the numbers in a text, as written, and each as a plain number to compare
 *  ("US$3,376" → "3376", "4.50" → "4.5"): separators of thousands are commas
 *  followed by three digits; any other comma is read as a decimal point */
export function numberTokens(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const raw = m[0].trim();
    const digits = raw.replace(/^[^\d]+/, "").replace(/\s?%$/, "");
    const plain = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(digits)
      ? digits.replace(/,/g, "")
      : digits.replace(/,/g, ".");
    const n = Number(plain);
    out.push({ raw, norm: Number.isFinite(n) ? String(n) : plain });
  }
  return out;
}

const normText = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

// --- components.json ------------------------------------------------------------------

/** a value a part of components.json showed, flattened for matching */
export type PartValueEntry = {
  ref: string;
  field?: string;
  text: string;
  value?: number;
  /** the components.json it is in (absolute) */
  file: string;
  /** a version 2 value; a version 1 file's label or a track's step (matched
   *  on, never shown as a value) */
  by: "values" | "label" | "track";
};

export type ComponentValueIndex = {
  files: { file: string; version: number; parts: number; values: number }[];
  entries: PartValueEntry[];
  refs: Set<string>;
  /** files that could not be read, and why */
  unread: { file: string; why: string }[];
};

/** every value the parts of these components.json files showed */
export function componentValueIndex(files: readonly string[]): ComponentValueIndex {
  const idx: ComponentValueIndex = { files: [], entries: [], refs: new Set(), unread: [] };
  for (const file of [...new Set(files.map((f) => resolve(f)))]) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch (e) {
      idx.unread.push({ file, why: (e as Error).message.split("\n")[0] ?? "" });
      continue;
    }
    if (!raw || !Array.isArray(raw.components)) {
      idx.unread.push({ file, why: "no components list" });
      continue;
    }
    const version = typeof raw.version === "number" ? raw.version : 0;
    let parts = 0;
    let values = 0;
    for (const c of raw.components as Record<string, unknown>[]) {
      if (!c || typeof c.ref !== "string") continue;
      parts++;
      idx.refs.add(c.ref);
      const v =
        c.values && typeof c.values === "object" ? (c.values as Record<string, unknown>) : null;
      if (v)
        for (const [field, x] of Object.entries(v)) {
          const e = x as { text?: unknown; value?: unknown };
          if (!e || typeof e.text !== "string") continue;
          values++;
          idx.entries.push({
            ref: c.ref,
            field,
            text: e.text,
            ...(typeof e.value === "number" && Number.isFinite(e.value) ? { value: e.value } : {}),
            file,
            by: "values",
          });
        }
      else if (typeof c.label === "string" && c.label)
        idx.entries.push({ ref: c.ref, text: c.label, file, by: "label" });
    }
    // a version 1 file: what each step of a track read, too
    if (version < 2 && Array.isArray(raw.tracks))
      for (const tr of raw.tracks as { steps?: { ref?: unknown; text?: unknown }[] }[])
        for (const s of tr?.steps ?? [])
          if (typeof s?.ref === "string" && typeof s.text === "string" && s.text)
            idx.entries.push({ ref: s.ref, text: s.text, file, by: "track" });
    idx.files.push({ file, version, parts, values });
  }
  return idx;
}

/** each entry's numbers, compared as plain numbers */
const entryNorms = (e: PartValueEntry): Set<string> => {
  const s = new Set(numberTokens(e.text).map((x) => x.norm));
  if (e.value != null) s.add(String(e.value));
  return s;
};

/** the components.json files a film's page can mean: those its sources name
 *  (relative to the page's folder, else to `base`; "/…" from the folder it
 *  is served from), and those in the page's
 *  folder and the folders under it, two deep (node_modules, dot folders and
 *  probe folders left out) */
export function findComponentFiles(o: {
  pageDir?: string;
  /** the folder the page is served from: where "/…" paths start */
  root?: string;
  base: string;
  sources: readonly FilmSource[];
}): string[] {
  const out: string[] = [];
  const add = (f: string) => {
    if (existsSync(f) && !out.includes(f)) out.push(f);
  };
  for (const s of o.sources) {
    if (!s.file || /^[a-z]+:/i.test(s.file)) continue;
    let f = s.file.replace(/[?#].*$/, "");
    try {
      f = decodeURIComponent(f);
    } catch {}
    add(
      f.startsWith("/") ? join(o.root ?? o.pageDir ?? o.base, f) : resolve(o.pageDir ?? o.base, f),
    );
  }
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      if (n === "components.json") add(p);
      else if (
        depth > 0 &&
        !n.startsWith(".") &&
        n !== "node_modules" &&
        !n.endsWith(".probe") &&
        isDir(p)
      )
        walk(p, depth - 1);
    }
  };
  if (o.pageDir) walk(o.pageDir, 2);
  return out;
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// --- the reading ------------------------------------------------------------------------

export type ProvenanceKind = "declared" | "matches a part" | "no source declared";

export type ProvenanceValue = {
  /** the number as shown */
  text: string;
  how: ProvenanceKind;
  /** film seconds it is held on screen */
  spans: Span[];
  /** the text of its element where it was first seen, in full */
  in: string;
  /** the labels of the sources that cover it */
  sources?: string[];
  /** the parts that showed it: "<ref> <field>" (or the ref alone) */
  parts?: string[];
};

export type ProvenanceSource = FilmSource & {
  /** film seconds its element, label or text is on screen; null: not read */
  seen: Span[] | null;
  /** for a ref: whether the components.json read has that part */
  part?: "in components.json" | "not in the components.json read" | "no components.json read";
};

export type FilmProvenance = {
  how: How;
  note?: string;
  every: number;
  sources: { from: "page" | "events file" | null; list: ProvenanceSource[] };
  components: ComponentValueIndex["files"];
  unreadComponents: ComponentValueIndex["unread"];
  values: ProvenanceValue[];
  /** a block of the film's own text without a digit that reads exactly as a
   *  part's value */
  strings: { text: string; spans: Span[]; parts: string[] }[];
  /** numbers shown once while their element kept changing (a count, a
   *  tween): not product data, not listed */
  between: { values: number; elements: number };
};

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** add [t, t + every) to a list of spans, joined to the last when it touches */
const addSpan = (spans: Span[], t: number, every: number) => {
  const last = spans[spans.length - 1];
  if (last && t <= last[1] + every * 0.5 + 1e-6) last[1] = round3(Math.max(last[1], t + every));
  else spans.push([round3(t), round3(t + every)]);
};

const partName = (e: PartValueEntry) => (e.field ? `${e.ref} ${e.field}` : e.ref);

/**
 * The film's own text over time set beside its declared sources and the
 * values the product's parts showed. A value counts as shown when its
 * element holds the same text in two samples in a row, or it is the last
 * text the element shows (it then leaves, or the film ends); any other — a
 * text shown once between two others — is in-between and only counted.
 */
export function readProvenance(
  samples: readonly ProvenanceSample[] | null,
  o: {
    sources: readonly FilmSource[];
    sourcesFrom: "page" | "events file" | null;
    index: ComponentValueIndex;
    every: number;
    note?: string;
  },
): FilmProvenance {
  const { index, every } = o;
  const partState = (ref: string): ProvenanceSource["part"] =>
    !index.files.length
      ? "no components.json read"
      : index.refs.has(ref)
        ? "in components.json"
        : "not in the components.json read";
  const base = {
    every,
    components: index.files,
    unreadComponents: index.unread,
  };
  if (!samples)
    return {
      how: "not measured",
      ...(o.note ? { note: o.note } : {}),
      ...base,
      sources: {
        from: o.sourcesFrom,
        list: o.sources.map((s) => ({
          ...s,
          seen: null,
          ...(s.ref ? { part: partState(s.ref) } : {}),
        })),
      },
      values: [],
      strings: [],
      between: { values: 0, elements: 0 },
    };
  const list = [...samples].sort((a, b) => a.t - b.t);
  const at = list.map((s) => new Map(s.items.map((x) => [x.k, x])));
  const norms = index.entries.map(entryNorms);
  // what each source covers: its label's and text's numbers, its part's values
  const srcNorms = o.sources.map((s) => {
    const n = new Set<string>();
    for (const str of [s.label, ...(s.text ?? [])])
      for (const t of numberTokens(str)) n.add(t.norm);
    if (s.ref)
      index.entries.forEach((e, i) => {
        if (e.ref === s.ref && (!s.field || e.field === s.field))
          for (const v of norms[i]!) n.add(v);
      });
    return n;
  });
  const srcStrings = o.sources.map((s) =>
    [s.label, ...(s.text ?? [])].map(normText).filter((x) => x.length >= 2),
  );
  const seen = o.sources.map(() => [] as Span[]);
  const values = new Map<string, ProvenanceValue>();
  const strings = new Map<string, { text: string; spans: Span[]; parts: string[] }>();
  let between = 0;
  const betweenEls = new Set<number>();

  list.forEach((s, i) => {
    const hit = new Set<number>();
    for (const item of s.items) {
      const low = normText(item.text);
      for (const j of item.cov) hit.add(j);
      srcStrings.forEach((ss, j) => {
        if (ss.some((x) => low.includes(x))) hit.add(j);
      });
      const tokens = numberTokens(item.text);
      const prev = i > 0 ? at[i - 1]!.get(item.k) : undefined;
      const next = i < list.length - 1 ? at[i + 1]!.get(item.k) : undefined;
      const held = prev?.text === item.text || next?.text === item.text || next === undefined;
      if (!held) {
        if (tokens.length) {
          between += tokens.length;
          betweenEls.add(item.k);
        }
        continue;
      }
      if (!tokens.length) {
        if (low.length < 2) continue;
        const parts = index.entries.filter((e) => normText(e.text) === low).map(partName);
        if (!parts.length) continue;
        const cur = strings.get(low) ?? { text: item.text, spans: [], parts: [] };
        addSpan(cur.spans, s.t, every);
        for (const p of parts) if (!cur.parts.includes(p)) cur.parts.push(p);
        strings.set(low, cur);
        continue;
      }
      for (const tok of tokens) {
        const by = new Set<number>(item.cov);
        srcNorms.forEach((n, j) => {
          if (n.has(tok.norm)) by.add(j);
        });
        const parts = index.entries.filter((_, j) => norms[j]!.has(tok.norm)).map(partName);
        const how: ProvenanceKind = by.size
          ? "declared"
          : parts.length
            ? "matches a part"
            : "no source declared";
        const key = `${tok.raw}\u0000${how}`;
        const cur = values.get(key) ?? { text: tok.raw, how, spans: [], in: item.text };
        addSpan(cur.spans, s.t, every);
        if (by.size) {
          cur.sources ??= [];
          for (const j of by) {
            const label = o.sources[j]?.label;
            if (label != null && !cur.sources.includes(label)) cur.sources.push(label);
          }
        }
        if (parts.length) {
          cur.parts ??= [];
          for (const p of parts) if (!cur.parts.includes(p)) cur.parts.push(p);
        }
        values.set(key, cur);
      }
    }
    for (const j of hit) addSpan(seen[j]!, s.t, every);
  });

  const vals = [...values.values()].sort(
    (a, b) => a.spans[0]![0] - b.spans[0]![0] || a.text.localeCompare(b.text),
  );
  return {
    how: vals.length || strings.size || between ? "measured" : "not detected",
    ...(o.note ? { note: o.note } : {}),
    ...base,
    sources: {
      from: o.sourcesFrom,
      list: o.sources.map((s, j) => ({
        ...s,
        seen: seen[j]!,
        ...(s.ref ? { part: partState(s.ref) } : {}),
      })),
    },
    values: vals,
    strings: [...strings.values()].sort((a, b) => a.spans[0]![0] - b.spans[0]![0]),
    between: { values: between, elements: betweenEls.size },
  };
}

/** every source the page gave over the samples, checked, in the order first
 *  given (a source declared late — a value read in __render — is kept too),
 *  and each sample's `cov` renumbered to that list (an entry the check left
 *  out covers nothing); null when no sample had a list */
export function pageSourcesOf(
  samples: readonly ProvenanceSample[],
): { sources: FilmSource[]; samples: ProvenanceSample[] } | null {
  const sources: FilmSource[] = [];
  const at = new Map<string, number>();
  let any = false;
  const out = samples.map((s) => {
    if (!Array.isArray(s.sources)) return { ...s, items: s.items.map((x) => ({ ...x, cov: [] })) };
    any = true;
    const local = (s.sources as unknown[]).map((raw) => {
      const [c] = checkSources([raw]);
      if (!c) return -1;
      const key = JSON.stringify(c);
      let j = at.get(key);
      if (j == null) {
        j = sources.length;
        sources.push(c);
        at.set(key, j);
      }
      return j;
    });
    return {
      ...s,
      items: s.items.map((x) => ({
        ...x,
        cov: [...new Set(x.cov.map((i) => local[i] ?? -1).filter((j) => j >= 0))].sort(
          (a, b) => a - b,
        ),
      })),
    };
  });
  return any ? { sources, samples: out } : null;
}

// --- the lines -----------------------------------------------------------------------------

const fmtT = (t: number) => {
  if (t < 60) return `${t.toFixed(2)}s`;
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, "0")}`;
};
const spansText = (sp: readonly Span[]) => sp.map(([a, b]) => `${fmtT(a)}–${fmtT(b)}`).join(", ");
const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const few = (xs: readonly string[], n = 3) =>
  xs.length > n ? `${xs.slice(0, n).join(", ")} and ${xs.length - n} more` : xs.join(", ");

/** probe.md's section; `base` makes the components.json paths relative */
export function formatProvenance(p: FilmProvenance, base?: string): string[] {
  const L: string[] = ["## Where the values on screen come from"];
  const shown = (f: string) => (base ? relative(base, f) || f : f);
  const files = p.components.length
    ? `components.json read: ${p.components.map((c) => `${shown(c.file)} (version ${c.version || "?"}, ${c.parts} parts${c.version >= 2 ? `, ${c.values} values` : ", no values — matched on its labels"})`).join("; ")}`
    : "no components.json read beside the page";
  if (p.how === "not measured")
    L.push(
      `[not measured] the film's own text was not read${p.note ? ` (${p.note})` : " — give the film's page (--page)"}; ${files}.`,
    );
  else
    L.push(
      `[${p.how}] the numbers in the film's own text (outside saved screens and lifted parts, which are the product's page), every ${p.every} s, set beside the sources the page declares (tl.source) and the values the product's parts showed; ${files}. Information only: a value the saved screens did not keep can still be real — a formula, the product's code, a live page.`,
    );
  for (const u of p.unreadComponents) L.push(`- could not read ${shown(u.file)}: ${u.why}`);
  const src = p.sources.list;
  if (!src.length)
    L.push(
      `Declared sources: none${p.sources.from ? ` (from the ${p.sources.from})` : ""} — kit/time.js \`tl.source(label, { ref | url | note })\`; kit/media.js \`readValues(url, { tl })\` declares what it reads.`,
    );
  else {
    L.push(`Declared sources (from the ${p.sources.from ?? "page"}), ${src.length}:`);
    for (const s of src) {
      const where = [
        s.ref ? `${s.ref}${s.field ? ` ${s.field}` : ""}${s.part ? ` (${s.part})` : ""}` : "",
        s.url ? `url ${s.url}` : "",
        s.note ? `note: ${s.note}` : "",
        s.selector ? `covers ${s.selector}` : "",
        s.text?.length ? `text ${s.text.map((x) => `"${clip(x, 40)}"`).join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      const on =
        s.seen == null
          ? ""
          : s.seen.length
            ? ` — on screen ${spansText(s.seen)}`
            : " — not seen in the film's own text";
      L.push(`- "${clip(s.label, 60)}" — ${where}${on}`);
    }
  }
  if (p.how === "not measured") return L;
  if (!p.values.length) L.push("[not detected] no number held in the film's own text");
  else {
    L.push("Numbers held in the film's own text:");
    for (const v of p.values) {
      const why =
        v.how === "declared"
          ? ` (${few((v.sources ?? []).map((x) => `"${clip(x, 40)}"`))})`
          : v.how === "matches a part"
            ? ` (${few(v.parts ?? [])})`
            : "";
      const inText = v.in !== v.text ? ` in "${clip(v.in)}"` : "";
      L.push(`- ${v.how}: ${v.text} ${spansText(v.spans)}${inText}${why}`);
    }
  }
  if (p.strings.length)
    L.push(
      `Text that reads exactly as a part's value: ${p.strings.map((s) => `"${clip(s.text, 40)}" ${spansText(s.spans)} (${few(s.parts)})`).join("; ")}`,
    );
  if (p.between.values)
    L.push(
      `In-between numbers (shown once while their element kept changing — a count, a tween), not listed: ${p.between.values} in ${p.between.elements} element(s).`,
    );
  return L;
}

/** the page's folder: the page itself when it is one, else the folder it is in */
export function pageDirOf(page: string): string {
  const p = resolve(page);
  return isDir(p) ? p : dirname(p);
}
