// `open-take film look`: a product's look, read off its real interface, with
// where each part was found — for a film page to execute at film scale. No
// named looks and no defaults: the colours, fonts, radii, shadows and motion
// timings are the product's own, each with its source and how much of the
// screen it covers, labelled measured / estimated / not detected.
//
//   colours   every colour the screen paints (backgrounds by sampled area, text
//             by characters and the ground it sits on, borders by edge length,
//             the custom properties that hold it) and an estimate of the roles
//             (bg, surfaces, text, muted, accent, on-accent, border)
//   fonts     each family the visible text is set in — weights, sizes, the
//             text itself — and the actual font files: saved with the screen
//             (`make --states` keeps them) or downloaded from the live page
//   shape     corner radii and shadows, with examples
//   motion    transition / animation durations and easings declared in the
//             product's CSS: one possible source for the film's timing, read
//             as declared, never as what the film should use
//
// It writes look.json, look.png (a swatch and type specimen drawn in the
// product's own fonts with the product's own words, at a 1920×1080 frame) and
// fonts/ beside them. Given the film's text (--text, or --page: the film's
// own page, read statically) it checks every character against the font files
// — CJK included — reports what no file covers, and with --fonts writes the
// files the film needs, cut down to its characters, plus a fonts.css.
//
// The font code reads TrueType/OpenType, WOFF and WOFF2 (Brotli, with the
// transformed glyf/loca/hmtx rebuilt) in plain Node, and cuts a TrueType-
// outline font down by keeping every glyph id and emptying the glyphs no kept
// character reaches (through the cmap, composite glyphs, GSUB and COLR) — the
// tables that index glyphs stay valid untouched. CFF-outline and bitmap fonts
// are copied whole, and say so.

import { brotliDecompressSync, deflateSync, inflateSync } from "node:zlib";

// --- bytes ----------------------------------------------------------------

const u8 = (b: Buffer, o: number) => b.readUInt8(o);
const u16 = (b: Buffer, o: number) => b.readUInt16BE(o);
const i16 = (b: Buffer, o: number) => b.readInt16BE(o);
const u32 = (b: Buffer, o: number) => b.readUInt32BE(o);
const tagAt = (b: Buffer, o: number) => b.toString("latin1", o, o + 4);
const pad4 = (n: number) => (n + 3) & ~3;

/** A reader over one stream of bytes, failing with what it was reading. */
class Stream {
  pos = 0;
  constructor(
    readonly buf: Buffer,
    readonly what: string,
  ) {}
  need(n: number) {
    if (this.pos + n > this.buf.length) throw new Error(`font: ${this.what} ends early`);
  }
  u8() {
    this.need(1);
    return this.buf[this.pos++]!;
  }
  u16() {
    this.need(2);
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  i16() {
    this.need(2);
    const v = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  u32() {
    this.need(4);
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  bytes(n: number) {
    this.need(n);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  /** WOFF2 UIntBase128 */
  base128() {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.u8();
      if (i === 0 && b === 0x80) throw new Error(`font: ${this.what} has a malformed number`);
      if (v & 0xfe000000) throw new Error(`font: ${this.what} has a number out of range`);
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) return v >>> 0;
    }
    throw new Error(`font: ${this.what} has a number out of range`);
  }
  /** WOFF2 255UInt16 */
  u255() {
    const code = this.u8();
    if (code === 253) return this.u16();
    if (code === 255) return this.u8() + 253;
    if (code === 254) return this.u8() + 506;
    return code;
  }
}

// --- fonts: reading the container -----------------------------------------

export type FontFormat = "ttf" | "otf" | "woff" | "woff2";
type Tables = Map<string, Buffer>;
type Sfnt = { format: FontFormat; flavor: number; tables: Tables };

const WOFF2_TAGS = [
  "cmap",
  "head",
  "hhea",
  "hmtx",
  "maxp",
  "name",
  "OS/2",
  "post",
  "cvt ",
  "fpgm",
  "glyf",
  "loca",
  "prep",
  "CFF ",
  "VORG",
  "EBDT",
  "EBLC",
  "gasp",
  "hdmx",
  "kern",
  "LTSH",
  "PCLT",
  "VDMX",
  "vhea",
  "vmtx",
  "BASE",
  "GDEF",
  "GPOS",
  "GSUB",
  "EBSC",
  "JSTF",
  "MATH",
  "CBDT",
  "CBLC",
  "COLR",
  "CPAL",
  "SVG ",
  "sbix",
  "acnt",
  "avar",
  "bdat",
  "bloc",
  "bsln",
  "cvar",
  "fdsc",
  "feat",
  "fmtx",
  "fvar",
  "gvar",
  "hsty",
  "just",
  "lcar",
  "mort",
  "morx",
  "opbd",
  "prop",
  "trak",
  "Zapf",
  "Silf",
  "Glat",
  "Gloc",
  "Feat",
  "Sill",
]; // prettier-ignore

/** The font's tables, whatever it came in: TrueType/OpenType (a collection's
 *  `index`-th face), WOFF or WOFF2. WOFF2's transformed glyf/loca/hmtx come
 *  back as the plain tables (loca long, head saying so). */
export function readSfnt(buf: Buffer, index = 0): Sfnt {
  if (buf.length < 12) throw new Error("font: too short to be a font file");
  const sig = tagAt(buf, 0);
  if (sig === "wOFF") return readWoff(buf);
  if (sig === "wOF2") return readWoff2(buf);
  let base = 0;
  if (sig === "ttcf") {
    const n = u32(buf, 8);
    if (index >= n) throw new Error(`font: the collection has ${n} faces, not ${index + 1}`);
    base = u32(buf, 12 + 4 * index);
  }
  const flavor = u32(buf, base);
  if (flavor !== 0x00010000 && flavor !== 0x4f54544f && flavor !== 0x74727565)
    throw new Error("font: not a TrueType, OpenType, WOFF or WOFF2 file");
  const n = u16(buf, base + 4);
  const tables: Tables = new Map();
  for (let i = 0; i < n; i++) {
    const e = base + 12 + 16 * i;
    const off = u32(buf, e + 8);
    const len = u32(buf, e + 12);
    if (off + len > buf.length) throw new Error(`font: table ${tagAt(buf, e)} runs past the file`);
    tables.set(tagAt(buf, e), buf.subarray(off, off + len));
  }
  return { format: flavor === 0x4f54544f ? "otf" : "ttf", flavor, tables };
}

function readWoff(buf: Buffer): Sfnt {
  const flavor = u32(buf, 4);
  const n = u16(buf, 12);
  const tables: Tables = new Map();
  for (let i = 0; i < n; i++) {
    const e = 44 + 20 * i;
    const tag = tagAt(buf, e);
    const off = u32(buf, e + 4);
    const comp = u32(buf, e + 8);
    const orig = u32(buf, e + 12);
    if (off + comp > buf.length) throw new Error(`font: WOFF table ${tag} runs past the file`);
    const raw = buf.subarray(off, off + comp);
    const data = comp < orig ? inflateSync(raw) : raw;
    if (data.length !== orig) throw new Error(`font: WOFF table ${tag} has the wrong length`);
    tables.set(tag, data);
  }
  return { format: "woff", flavor, tables };
}

function readWoff2(buf: Buffer): Sfnt {
  const flavor = u32(buf, 4);
  if (flavor === 0x74746366) throw new Error("font: WOFF2 collections are not read");
  const n = u16(buf, 12);
  const compressed = u32(buf, 20);
  const dir = new Stream(buf, "WOFF2 table directory");
  dir.pos = 48;
  const entries: { tag: string; orig: number; length: number; transformed: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const flags = dir.u8();
    const tag = (flags & 0x3f) === 63 ? dir.bytes(4).toString("latin1") : WOFF2_TAGS[flags & 0x3f]!;
    const version = flags >> 6;
    const orig = dir.base128();
    // glyf/loca: version 0 is the transform, 3 is none; every other table the reverse
    const transformed = tag === "glyf" || tag === "loca" ? version === 0 : version !== 0;
    const length = transformed ? dir.base128() : orig;
    entries.push({ tag, orig, length, transformed });
  }
  const data = brotliDecompressSync(buf.subarray(dir.pos, dir.pos + compressed));
  const raw: Tables = new Map();
  let at = 0;
  for (const e of entries) {
    if (at + e.length > data.length)
      throw new Error(`font: WOFF2 table ${e.tag} runs past the data`);
    raw.set(e.tag, data.subarray(at, at + e.length));
    at += e.length;
  }
  const tables: Tables = new Map();
  for (const e of entries) if (!e.transformed) tables.set(e.tag, raw.get(e.tag)!);
  const glyfEntry = entries.find((e) => e.tag === "glyf");
  if (glyfEntry?.transformed) {
    const { glyf, loca, xMins } = rebuildGlyf(raw.get("glyf")!);
    tables.set("glyf", glyf);
    tables.set("loca", loca);
    const head = Buffer.from(tables.get("head")!);
    head.writeInt16BE(1, 50); // loca is long now
    tables.set("head", head);
    const hmtxEntry = entries.find((e) => e.tag === "hmtx");
    if (hmtxEntry?.transformed)
      tables.set("hmtx", rebuildHmtx(raw.get("hmtx")!, tables.get("hhea")!, xMins));
  } else if (entries.find((e) => e.tag === "hmtx")?.transformed)
    throw new Error("font: WOFF2 hmtx is transformed but glyf is not");
  return { format: "woff2", flavor, tables };
}

/** The WOFF2 glyf transform undone: every glyph back to TrueType bytes. */
function rebuildGlyf(t: Buffer): { glyf: Buffer; loca: Buffer; xMins: number[] } {
  const h = new Stream(t, "WOFF2 glyf");
  h.u16(); // reserved
  const options = h.u16();
  const numGlyphs = h.u16();
  h.u16(); // indexFormat — the rebuilt loca is long either way
  const sizes = [h.u32(), h.u32(), h.u32(), h.u32(), h.u32(), h.u32(), h.u32()];
  const streams: Stream[] = [];
  let at = h.pos;
  const names = ["contours", "points", "flags", "glyphs", "composites", "bboxes", "instructions"];
  for (let i = 0; i < 7; i++) {
    if (at + sizes[i]! > t.length) throw new Error(`font: WOFF2 glyf ${names[i]} stream runs past`);
    streams.push(new Stream(t.subarray(at, at + sizes[i]!), `WOFF2 glyf ${names[i]}`));
    at += sizes[i]!;
  }
  const [nContour, nPoints, flagS, glyphS, compS, bboxS, instrS] = streams as [
    Stream,
    Stream,
    Stream,
    Stream,
    Stream,
    Stream,
    Stream,
  ]; // prettier-ignore
  const bitmapLen = 4 * Math.floor((numGlyphs + 31) / 32);
  const bboxBitmap = bboxS.bytes(bitmapLen);
  const hasBbox = (i: number) => (bboxBitmap[i >> 3]! & (0x80 >> (i & 7))) !== 0;
  const overlap = options & 1 ? t.subarray(at, at + ((numGlyphs + 7) >> 3)) : null;
  const glyphs: Buffer[] = [];
  const xMins: number[] = [];
  for (let g = 0; g < numGlyphs; g++) {
    const nc = nContour.i16();
    if (nc === 0) {
      if (hasBbox(g)) throw new Error(`font: WOFF2 empty glyph ${g} has a bbox`);
      glyphs.push(Buffer.alloc(0));
      xMins.push(0);
      continue;
    }
    if (nc < 0) {
      // composite: its component records verbatim, the bbox explicit
      if (!hasBbox(g)) throw new Error(`font: WOFF2 composite glyph ${g} has no bbox`);
      const bbox = bboxS.bytes(8);
      const start = compS.pos;
      let flags = 0;
      let instructions = false;
      do {
        flags = compS.u16();
        compS.u16();
        compS.bytes(compositeArgBytes(flags));
        if (flags & 0x0100) instructions = true;
      } while (flags & 0x0020);
      const comps = compS.buf.subarray(start, compS.pos);
      const parts = [Buffer.from([0xff, 0xff]), bbox, comps];
      if (instructions) {
        const n = glyphS.u255();
        const len = Buffer.alloc(2);
        len.writeUInt16BE(n);
        parts.push(len, instrS.bytes(n));
      }
      glyphs.push(Buffer.concat(parts));
      xMins.push(bbox.readInt16BE(0));
      continue;
    }
    const ends: number[] = [];
    let total = 0;
    for (let c = 0; c < nc; c++) {
      total += nPoints.u255();
      ends.push(total - 1);
    }
    const xs: number[] = [];
    const ys: number[] = [];
    const on: boolean[] = [];
    let x = 0;
    let y = 0;
    for (let p = 0; p < total; p++) {
      const flag = flagS.u8();
      const [dx, dy] = triplet(flag & 0x7f, glyphS);
      x += dx;
      y += dy;
      xs.push(x);
      ys.push(y);
      on.push(!(flag & 0x80));
    }
    const nInstr = glyphS.u255();
    const instr = instrS.bytes(nInstr);
    let box: [number, number, number, number];
    if (hasBbox(g)) {
      const b = bboxS.bytes(8);
      box = [b.readInt16BE(0), b.readInt16BE(2), b.readInt16BE(4), b.readInt16BE(6)];
    } else
      box = total
        ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
        : [0, 0, 0, 0];
    const overlapping = overlap ? (overlap[g >> 3]! & (0x80 >> (g & 7))) !== 0 : false;
    glyphs.push(encodeSimpleGlyph(ends, xs, ys, on, instr, box, overlapping));
    xMins.push(box[0]);
  }
  const { glyf, loca } = joinGlyphs(glyphs);
  return { glyf, loca, xMins };
}

/** bytes of a composite component after its flags and glyph index */
function compositeArgBytes(flags: number): number {
  let n = flags & 0x0001 ? 4 : 2;
  if (flags & 0x0008) n += 2;
  else if (flags & 0x0040) n += 4;
  else if (flags & 0x0080) n += 8;
  return n;
}

const withSign = (flag: number, v: number) => (flag & 1 ? v : -v);

/** one WOFF2 coordinate triplet: (dx, dy) from the flag's low 7 bits */
function triplet(f: number, s: Stream): [number, number] {
  if (f < 10) return [0, withSign(f, ((f & 14) << 7) + s.u8())];
  if (f < 20) return [withSign(f, (((f - 10) & 14) << 7) + s.u8()), 0];
  if (f < 84) {
    const b0 = f - 20;
    const b1 = s.u8();
    return [
      withSign(f, 1 + (b0 & 0x30) + (b1 >> 4)),
      withSign(f >> 1, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f)),
    ];
  }
  if (f < 120) {
    const b0 = f - 84;
    const a = s.u8();
    const b = s.u8();
    return [
      withSign(f, 1 + (Math.floor(b0 / 12) << 8) + a),
      withSign(f >> 1, 1 + (((b0 % 12) >> 2) << 8) + b),
    ];
  }
  if (f < 124) {
    const a = s.u8();
    const b = s.u8();
    const c = s.u8();
    return [withSign(f, (a << 4) + (b >> 4)), withSign(f >> 1, ((b & 0x0f) << 8) + c)];
  }
  const a = s.u16();
  const b = s.u16();
  return [withSign(f, a), withSign(f >> 1, b)];
}

function encodeSimpleGlyph(
  ends: number[],
  xs: number[],
  ys: number[],
  on: boolean[],
  instr: Buffer,
  box: [number, number, number, number],
  overlapping: boolean,
): Buffer {
  const head = Buffer.alloc(10 + 2 * ends.length + 2);
  head.writeInt16BE(ends.length, 0);
  for (const [i, v] of box.entries()) head.writeInt16BE(v, 2 + 2 * i);
  for (const [i, v] of ends.entries()) head.writeUInt16BE(v, 10 + 2 * i);
  head.writeUInt16BE(instr.length, 10 + 2 * ends.length);
  const flags: number[] = [];
  const xb: number[] = [];
  const yb: number[] = [];
  let px = 0;
  let py = 0;
  for (let i = 0; i < xs.length; i++) {
    let f = on[i] ? 0x01 : 0;
    if (i === 0 && overlapping) f |= 0x40;
    const dx = xs[i]! - px;
    const dy = ys[i]! - py;
    px = xs[i]!;
    py = ys[i]!;
    if (dx === 0) f |= 0x10;
    else if (Math.abs(dx) < 256) {
      f |= 0x02 | (dx > 0 ? 0x10 : 0);
      xb.push(Math.abs(dx));
    } else xb.push((dx >> 8) & 0xff, dx & 0xff);
    if (dy === 0) f |= 0x20;
    else if (Math.abs(dy) < 256) {
      f |= 0x04 | (dy > 0 ? 0x20 : 0);
      yb.push(Math.abs(dy));
    } else yb.push((dy >> 8) & 0xff, dy & 0xff);
    flags.push(f);
  }
  return Buffer.concat([head, instr, Buffer.from(flags), Buffer.from(xb), Buffer.from(yb)]);
}

/** glyphs → a glyf table (each padded to 4 bytes) and a long loca */
function joinGlyphs(glyphs: Buffer[]): { glyf: Buffer; loca: Buffer } {
  const loca = Buffer.alloc(4 * (glyphs.length + 1));
  const parts: Buffer[] = [];
  let off = 0;
  glyphs.forEach((g, i) => {
    loca.writeUInt32BE(off, 4 * i);
    if (!g.length) return;
    const padded = pad4(g.length);
    parts.push(g, Buffer.alloc(padded - g.length));
    off += padded;
  });
  loca.writeUInt32BE(off, 4 * glyphs.length);
  return { glyf: Buffer.concat(parts), loca };
}

function rebuildHmtx(t: Buffer, hhea: Buffer, xMins: number[]): Buffer {
  const s = new Stream(t, "WOFF2 hmtx");
  const flags = s.u8();
  const numGlyphs = xMins.length;
  const nh = u16(hhea, 34);
  const adv: number[] = [];
  for (let i = 0; i < nh; i++) adv.push(s.u16());
  const lsb: number[] = [];
  for (let i = 0; i < nh; i++) lsb.push(flags & 1 ? xMins[i]! : s.i16());
  for (let i = nh; i < numGlyphs; i++) lsb.push(flags & 2 ? xMins[i]! : s.i16());
  const out = Buffer.alloc(4 * nh + 2 * (numGlyphs - nh));
  for (let i = 0; i < nh; i++) {
    out.writeUInt16BE(adv[i]!, 4 * i);
    out.writeInt16BE(lsb[i]!, 4 * i + 2);
  }
  for (let i = nh; i < numGlyphs; i++) out.writeInt16BE(lsb[i]!, 4 * nh + 2 * (i - nh));
  return out;
}

/** each glyph's bytes from glyf + loca */
function splitGlyphs(tables: Tables): Buffer[] {
  const glyf = tables.get("glyf");
  const loca = tables.get("loca");
  const head = tables.get("head");
  const maxp = tables.get("maxp");
  if (!glyf || !loca || !head || !maxp) return [];
  const n = u16(maxp, 4);
  const long = i16(head, 50) === 1;
  const at = (i: number) => (long ? u32(loca, 4 * i) : 2 * u16(loca, 2 * i));
  const out: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const a = at(i);
    const b = at(i + 1);
    out.push(b > a && b <= glyf.length ? glyf.subarray(a, b) : Buffer.alloc(0));
  }
  return out;
}

// --- fonts: what is in one --------------------------------------------------

export type FontInfo = {
  format: FontFormat;
  /** "truetype" (glyf) / "cff" / "bitmap" — which outlines it carries */
  outlines: "truetype" | "cff" | "bitmap";
  family: string;
  subfamily: string;
  fullName: string;
  postscriptName: string;
  /** OS/2 usWeightClass (400 regular, 700 bold) */
  weight: number;
  italic: boolean;
  /** variation axes, when it is a variable font */
  axes: { tag: string; min: number; default: number; max: number }[];
  glyphs: number;
  unitsPerEm: number;
  /** in font units: ascender/descender/lineGap (hhea), cap and x height (OS/2, 0 when absent) */
  ascender: number;
  descender: number;
  lineGap: number;
  capHeight: number;
  xHeight: number;
  /** code point → glyph id */
  cmap: Map<number, number>;
  /** advance widths by glyph id (font units) */
  advances: number[];
};

function nameTable(b: Buffer | undefined): Map<number, string> {
  const out = new Map<number, string>();
  if (!b || b.length < 6) return out;
  const count = u16(b, 2);
  const strings = u16(b, 4);
  const best = new Map<number, number>(); // nameID → score of the record kept
  for (let i = 0; i < count; i++) {
    const r = 6 + 12 * i;
    if (r + 12 > b.length) break;
    const platform = u16(b, r);
    const encoding = u16(b, r + 2);
    const lang = u16(b, r + 4);
    const id = u16(b, r + 6);
    const len = u16(b, r + 8);
    const off = strings + u16(b, r + 10);
    if (off + len > b.length) continue;
    const raw = b.subarray(off, off + len);
    let text: string;
    let score: number;
    if (platform === 3 || platform === 0) {
      text = Buffer.from(raw).swap16().toString("utf16le");
      score = platform === 3 && lang === 0x409 ? 3 : platform === 3 ? 2 : 1;
    } else if (platform === 1 && encoding === 0) {
      text = raw.toString("latin1");
      score = 0;
    } else continue;
    if ((best.get(id) ?? -1) < score) {
      best.set(id, score);
      out.set(id, text);
    }
  }
  return out;
}

function parseCmap(b: Buffer | undefined): Map<number, number> {
  const map = new Map<number, number>();
  if (!b) return map;
  const n = u16(b, 2);
  const subs: { off: number; format: number }[] = [];
  for (let i = 0; i < n; i++) {
    const r = 4 + 8 * i;
    const platform = u16(b, r);
    const encoding = u16(b, r + 2);
    const off = u32(b, r + 4);
    const unicode =
      platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10 || encoding === 0));
    if (!unicode || off + 2 > b.length) continue;
    subs.push({ off, format: u16(b, off) });
  }
  // the full-repertoire tables first, so a BMP table never overrides them
  subs.sort((a, c) => (c.format === 12 ? 1 : 0) - (a.format === 12 ? 1 : 0));
  const put = (cp: number, g: number) => {
    if (g && !map.has(cp)) map.set(cp, g);
  };
  for (const { off, format } of subs) {
    if (format === 12) {
      const groups = u32(b, off + 12);
      for (let i = 0; i < groups; i++) {
        const r = off + 16 + 12 * i;
        const start = u32(b, r);
        const end = u32(b, r + 4);
        const g0 = u32(b, r + 8);
        for (let c = start; c <= end && c <= 0x10ffff; c++) put(c, g0 + (c - start));
      }
    } else if (format === 4) {
      const seg = u16(b, off + 6) / 2;
      const ends = off + 14;
      const starts = ends + 2 * seg + 2;
      const deltas = starts + 2 * seg;
      const ranges = deltas + 2 * seg;
      for (let s = 0; s < seg; s++) {
        const end = u16(b, ends + 2 * s);
        const start = u16(b, starts + 2 * s);
        const delta = u16(b, deltas + 2 * s);
        const ro = u16(b, ranges + 2 * s);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          if (ro === 0) put(c, (c + delta) & 0xffff);
          else {
            const a = ranges + 2 * s + ro + 2 * (c - start);
            if (a + 2 > b.length) continue;
            const g = u16(b, a);
            if (g) put(c, (g + delta) & 0xffff);
          }
        }
      }
    } else if (format === 6) {
      const first = u16(b, off + 6);
      const count = u16(b, off + 8);
      for (let i = 0; i < count; i++) put(first + i, u16(b, off + 10 + 2 * i));
    } else if (format === 0) {
      for (let c = 0; c < 256; c++) put(c, u8(b, off + 6 + c));
    }
  }
  return map;
}

/** What a font file is: names, weight, axes, metrics, the characters it maps. */
export function parseFont(buf: Buffer, opts: { index?: number } = {}): FontInfo {
  const sfnt = readSfnt(buf, opts.index ?? 0);
  return fontInfo(sfnt);
}

function fontInfo(sfnt: Sfnt): FontInfo {
  const t = sfnt.tables;
  const head = t.get("head");
  const hhea = t.get("hhea");
  const maxp = t.get("maxp");
  if (!head || !maxp) throw new Error("font: head or maxp table missing");
  const names = nameTable(t.get("name"));
  const os2 = t.get("OS/2");
  const axes: FontInfo["axes"] = [];
  const fvar = t.get("fvar");
  if (fvar && fvar.length >= 16) {
    const axesAt = u16(fvar, 4);
    const count = u16(fvar, 8);
    const size = u16(fvar, 10);
    const fixed = (o: number) => fvar.readInt32BE(o) / 65536;
    for (let i = 0; i < count; i++) {
      const r = axesAt + size * i;
      if (r + 20 > fvar.length) break;
      axes.push({
        tag: tagAt(fvar, r),
        min: fixed(r + 4),
        default: fixed(r + 8),
        max: fixed(r + 12),
      });
    }
  }
  const glyphs = u16(maxp, 4);
  const advances: number[] = [];
  const hmtx = t.get("hmtx");
  if (hhea && hmtx) {
    const nh = u16(hhea, 34);
    for (let i = 0; i < nh && 4 * i + 2 <= hmtx.length; i++) advances.push(u16(hmtx, 4 * i));
  }
  const fsSelection = os2 && os2.length >= 64 ? u16(os2, 62) : 0;
  const os2v = os2 && os2.length >= 2 ? u16(os2, 0) : 0;
  return {
    format: sfnt.format,
    outlines: t.has("glyf") ? "truetype" : t.has("CFF ") || t.has("CFF2") ? "cff" : "bitmap",
    family: names.get(16) ?? names.get(1) ?? "",
    subfamily: names.get(17) ?? names.get(2) ?? "",
    fullName: names.get(4) ?? "",
    postscriptName: names.get(6) ?? "",
    weight: os2 && os2.length >= 6 ? u16(os2, 4) : u16(head, 44) & 1 ? 700 : 400,
    italic: (fsSelection & 1) !== 0 || (u16(head, 44) & 2) !== 0,
    axes,
    glyphs,
    unitsPerEm: u16(head, 18),
    ascender: hhea ? i16(hhea, 4) : 0,
    descender: hhea ? i16(hhea, 6) : 0,
    lineGap: hhea ? i16(hhea, 8) : 0,
    capHeight: os2 && os2v >= 2 && os2.length >= 90 ? i16(os2, 88) : 0,
    xHeight: os2 && os2v >= 2 && os2.length >= 88 ? i16(os2, 86) : 0,
    cmap: parseCmap(t.get("cmap")),
    advances,
  };
}

/** Characters that need no glyph of their own: spaces, controls, joiners,
 *  variation selectors. */
export function needsGlyph(cp: number): boolean {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return false;
  if (cp === 0x20 || cp === 0xa0 || cp === 0x3000 || cp === 0xfeff) return false;
  if ((cp >= 0x2000 && cp <= 0x200f) || (cp >= 0x2028 && cp <= 0x202f)) return false;
  if (cp >= 0x205f && cp <= 0x206f) return false;
  if ((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)) return false;
  return true;
}

/** the distinct characters of `text` that need a glyph, in code point order */
export function glyphChars(text: string): number[] {
  const set = new Set<number>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (needsGlyph(cp)) set.add(cp);
  }
  return [...set].sort((a, b) => a - b);
}

/** Width of `text` set in `font` at `sizePx`, from the advance widths alone —
 *  no kerning, no shaping, the default instance of a variable font: an
 *  estimate, close for most Latin and CJK text. Unmapped characters count as
 *  the font's .notdef. */
export function textWidth(font: FontInfo, text: string, sizePx: number): number {
  const last = font.advances[font.advances.length - 1] ?? 0;
  let units = 0;
  for (const ch of text) {
    const g = font.cmap.get(ch.codePointAt(0)!) ?? 0;
    units += font.advances[g] ?? last;
  }
  return (units * sizePx) / (font.unitsPerEm || 1000);
}

/** The font size (px) at which `font`'s capitals stand `px` tall (its em box
 *  when the font gives no cap height): the way back from a height measured in
 *  a frame to the size Latin text was set at. CJK fonts give a cap height too
 *  (for their Latin); their ideographs stand near the whole em instead, so a
 *  Han character's measured height is close to the size itself. */
export function sizeForCapHeight(font: FontInfo, px: number): number {
  const cap = font.capHeight > 0 ? font.capHeight : font.unitsPerEm;
  return (px * font.unitsPerEm) / cap;
}

export type GlyphCoverage = {
  /** distinct characters checked (those needing a glyph) */
  chars: number;
  /** characters no font covers, with their code points */
  missing: { char: string; code: string }[];
  /** per font: how many of the characters it has, and which it lacks */
  byFont: { name: string; covered: number; lacks: string }[];
};

/** Which of `text`'s characters each font has, and which none of them has. */
export function glyphCoverage(
  fonts: readonly { name: string; font: Pick<FontInfo, "cmap"> }[],
  text: string,
): GlyphCoverage {
  const cps = glyphChars(text);
  const missing = cps
    .filter((cp) => !fonts.some((f) => f.font.cmap.has(cp)))
    .map((cp) => ({ char: String.fromCodePoint(cp), code: codeLabel(cp) }));
  return {
    chars: cps.length,
    missing,
    byFont: fonts.map((f) => {
      const lacks = cps.filter((cp) => !f.font.cmap.has(cp));
      return {
        name: f.name,
        covered: cps.length - lacks.length,
        lacks: lacks.map((cp) => String.fromCodePoint(cp)).join(""),
      };
    }),
  };
}

const codeLabel = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

// --- fonts: cutting one down ----------------------------------------------

type Coverage = [number, number][]; // [glyph, coverage index]

function coverage(b: Buffer, off: number): Coverage {
  const out: Coverage = [];
  if (off + 4 > b.length) return out;
  const format = u16(b, off);
  if (format === 1) {
    const n = u16(b, off + 2);
    for (let i = 0; i < n; i++) out.push([u16(b, off + 4 + 2 * i), i]);
  } else if (format === 2) {
    const n = u16(b, off + 2);
    for (let i = 0; i < n; i++) {
      const r = off + 4 + 6 * i;
      const start = u16(b, r);
      const end = u16(b, r + 2);
      const idx = u16(b, r + 4);
      for (let g = start; g <= end; g++) out.push([g, idx + g - start]);
    }
  }
  return out;
}

/** Every glyph a GSUB lookup could produce from glyphs in `keep` (contexts
 *  ignored — a lookup that could fire is assumed to), added to `keep`.
 *  Returns whether anything was added. */
function gsubClosure(gsub: Buffer, keep: Set<number>): boolean {
  let grew = false;
  const add = (g: number) => {
    if (!keep.has(g)) {
      keep.add(g);
      grew = true;
    }
  };
  const lookups = u16(gsub, 8);
  const count = u16(gsub, lookups);
  for (let l = 0; l < count; l++) {
    const lo = lookups + u16(gsub, lookups + 2 + 2 * l);
    const type = u16(gsub, lo);
    const subCount = u16(gsub, lo + 4);
    for (let s = 0; s < subCount; s++) {
      let st = lo + u16(gsub, lo + 6 + 2 * s);
      let t = type;
      if (t === 7) {
        t = u16(gsub, st + 2);
        st = st + u32(gsub, st + 4);
      }
      if (st + 2 > gsub.length) continue;
      const format = u16(gsub, st);
      const cov = () => coverage(gsub, st + u16(gsub, st + 2));
      if (t === 1) {
        if (format === 1) {
          const delta = u16(gsub, st + 4);
          for (const [g] of cov()) if (keep.has(g)) add((g + delta) & 0xffff);
        } else if (format === 2) {
          for (const [g, i] of cov()) if (keep.has(g)) add(u16(gsub, st + 6 + 2 * i));
        }
      } else if (t === 2 || t === 3) {
        for (const [g, i] of cov()) {
          if (!keep.has(g)) continue;
          const seq = st + u16(gsub, st + 6 + 2 * i);
          const n = u16(gsub, seq);
          for (let k = 0; k < n; k++) add(u16(gsub, seq + 2 + 2 * k));
        }
      } else if (t === 4) {
        for (const [g, i] of cov()) {
          if (!keep.has(g)) continue;
          const set = st + u16(gsub, st + 6 + 2 * i);
          const n = u16(gsub, set);
          for (let k = 0; k < n; k++) {
            const lig = set + u16(gsub, set + 2 + 2 * k);
            const comps = u16(gsub, lig + 2);
            let all = true;
            for (let c = 0; c < comps - 1; c++)
              if (!keep.has(u16(gsub, lig + 4 + 2 * c))) all = false;
            if (all) add(u16(gsub, lig));
          }
        }
      } else if (t === 8) {
        const back = u16(gsub, st + 4);
        const ahead = u16(gsub, st + 6 + 2 * back);
        const subs = st + 10 + 2 * back + 2 * ahead; // after the glyph count
        for (const [g, i] of cov()) if (keep.has(g)) add(u16(gsub, subs + 2 * i));
      }
    }
  }
  return grew;
}

/** the glyphs a composite glyph is built from */
function components(glyph: Buffer): number[] {
  if (glyph.length < 10 || glyph.readInt16BE(0) >= 0) return [];
  const out: number[] = [];
  let at = 10;
  for (;;) {
    if (at + 4 > glyph.length) break;
    const flags = u16(glyph, at);
    out.push(u16(glyph, at + 2));
    at += 4 + compositeArgBytes(flags);
    if (!(flags & 0x0020)) break;
  }
  return out;
}

/** COLR version 0: a base glyph's layers */
function colrClosure(colr: Buffer, keep: Set<number>): boolean {
  if (u16(colr, 0) !== 0) return false;
  let grew = false;
  const nBase = u16(colr, 2);
  const baseAt = u32(colr, 4);
  const layerAt = u32(colr, 8);
  for (let i = 0; i < nBase; i++) {
    const r = baseAt + 6 * i;
    if (!keep.has(u16(colr, r))) continue;
    const first = u16(colr, r + 2);
    const n = u16(colr, r + 4);
    for (let k = 0; k < n; k++) {
      const g = u16(colr, layerAt + 4 * (first + k));
      if (!keep.has(g)) {
        keep.add(g);
        grew = true;
      }
    }
  }
  return grew;
}

function buildCmap(pairs: [number, number][]): Buffer {
  pairs.sort((a, b) => a[0] - b[0]);
  const runs = (list: [number, number][], max: number) => {
    const out: [number, number, number][] = []; // start, end, first glyph
    for (const [cp, g] of list) {
      if (cp > max) break;
      const last = out[out.length - 1];
      if (last && cp === last[1] + 1 && g === last[2] + (cp - last[0])) last[1] = cp;
      else out.push([cp, cp, g]);
    }
    return out;
  };
  const bmp = runs(
    pairs.filter(([cp]) => cp < 0xffff),
    0xfffe,
  );
  bmp.push([0xffff, 0xffff, 0]);
  const seg = bmp.length;
  const f4Len = 16 + 8 * seg;
  const subtables: { platform: number; encoding: number; data: Buffer }[] = [];
  if (f4Len <= 0xffff) {
    const f4 = Buffer.alloc(f4Len);
    const lg = Math.floor(Math.log2(seg));
    f4.writeUInt16BE(4, 0);
    f4.writeUInt16BE(f4Len, 2);
    f4.writeUInt16BE(seg * 2, 6);
    f4.writeUInt16BE(2 * 2 ** lg, 8);
    f4.writeUInt16BE(lg, 10);
    f4.writeUInt16BE(seg * 2 - 2 * 2 ** lg, 12);
    bmp.forEach(([start, end, g], i) => {
      f4.writeUInt16BE(end, 14 + 2 * i);
      f4.writeUInt16BE(start, 16 + 2 * seg + 2 * i);
      f4.writeUInt16BE(end === 0xffff ? 1 : (g - start) & 0xffff, 16 + 4 * seg + 2 * i);
      // idRangeOffset stays 0
    });
    subtables.push({ platform: 3, encoding: 1, data: f4 });
  }
  if (pairs.some(([cp]) => cp > 0xffff) || f4Len > 0xffff) {
    const groups = runs(pairs, 0x10ffff);
    const f12 = Buffer.alloc(16 + 12 * groups.length);
    f12.writeUInt16BE(12, 0);
    f12.writeUInt32BE(f12.length, 4);
    f12.writeUInt32BE(groups.length, 12);
    groups.forEach(([start, end, g], i) => {
      f12.writeUInt32BE(start, 16 + 12 * i);
      f12.writeUInt32BE(end, 20 + 12 * i);
      f12.writeUInt32BE(g, 24 + 12 * i);
    });
    subtables.push({ platform: 3, encoding: 10, data: f12 });
  }
  const header = Buffer.alloc(4 + 8 * subtables.length);
  header.writeUInt16BE(subtables.length, 2);
  let off = header.length;
  subtables.forEach((s, i) => {
    header.writeUInt16BE(s.platform, 4 + 8 * i);
    header.writeUInt16BE(s.encoding, 6 + 8 * i);
    header.writeUInt32BE(off, 8 + 8 * i);
    off += s.data.length;
  });
  return Buffer.concat([header, ...subtables.map((s) => s.data)]);
}

/** gvar with the variation data of every glyph not kept dropped */
function subsetGvar(gvar: Buffer, keep: Set<number>): Buffer {
  const axisCount = u16(gvar, 4);
  const sharedCount = u16(gvar, 6);
  const sharedAt = u32(gvar, 8);
  const n = u16(gvar, 12);
  const long = (u16(gvar, 14) & 1) === 1;
  const dataAt = u32(gvar, 16);
  const at = (i: number) => dataAt + (long ? u32(gvar, 20 + 4 * i) : 2 * u16(gvar, 20 + 2 * i));
  const shared = gvar.subarray(sharedAt, sharedAt + 2 * axisCount * sharedCount);
  const header = Buffer.alloc(20 + 4 * (n + 1));
  gvar.copy(header, 0, 0, 8);
  header.writeUInt16BE(n, 12);
  header.writeUInt16BE(u16(gvar, 14) | 1, 14);
  const newShared = header.length;
  const newData = newShared + shared.length;
  header.writeUInt32BE(newShared, 8);
  header.writeUInt32BE(newData, 16);
  const parts: Buffer[] = [];
  let off = 0;
  for (let i = 0; i < n; i++) {
    header.writeUInt32BE(off, 20 + 4 * i);
    if (!keep.has(i)) continue;
    const d = gvar.subarray(at(i), at(i + 1));
    parts.push(d);
    off += d.length;
  }
  header.writeUInt32BE(off, 20 + 4 * n);
  return Buffer.concat([header, shared, ...parts]);
}

function checksum(b: Buffer): number {
  let sum = 0;
  const n = b.length & ~3;
  for (let i = 0; i < n; i += 4) sum = (sum + b.readUInt32BE(i)) >>> 0;
  if (n < b.length) {
    const tail = Buffer.alloc(4);
    b.copy(tail, 0, n);
    sum = (sum + tail.readUInt32BE(0)) >>> 0;
  }
  return sum;
}

/** tables → a TrueType file, head's checkSumAdjustment set */
function writeSfnt(flavor: number, tables: Tables): Buffer {
  const tags = [...tables.keys()].sort();
  const n = tags.length;
  const lg = Math.floor(Math.log2(n));
  const header = Buffer.alloc(12 + 16 * n);
  header.writeUInt32BE(flavor, 0);
  header.writeUInt16BE(n, 4);
  header.writeUInt16BE(16 * 2 ** lg, 6);
  header.writeUInt16BE(lg, 8);
  header.writeUInt16BE(16 * n - 16 * 2 ** lg, 10);
  const head = tables.get("head");
  if (head) {
    const h = Buffer.from(head);
    h.writeUInt32BE(0, 8);
    tables.set("head", h);
  }
  const parts: Buffer[] = [header];
  let off = header.length;
  tags.forEach((tag, i) => {
    const data = tables.get(tag)!;
    const e = 12 + 16 * i;
    header.write(tag, e, "latin1");
    header.writeUInt32BE(checksum(data), e + 4);
    header.writeUInt32BE(off, e + 8);
    header.writeUInt32BE(data.length, e + 12);
    parts.push(data, Buffer.alloc(pad4(data.length) - data.length));
    off += pad4(data.length);
  });
  const font = Buffer.concat(parts);
  if (head) {
    const headOff = header.readUInt32BE(12 + 16 * tags.indexOf("head") + 8);
    font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headOff + 8);
  }
  return font;
}

/** a TrueType file → WOFF 1.0 (each table zlib'd when that is smaller) */
function toWoff(ttf: Buffer): Buffer {
  const sfnt = readSfnt(ttf);
  const tags = [...sfnt.tables.keys()].sort();
  const header = Buffer.alloc(44 + 20 * tags.length);
  header.write("wOFF", 0, "latin1");
  header.writeUInt32BE(sfnt.flavor, 4);
  header.writeUInt16BE(tags.length, 12);
  header.writeUInt32BE(ttf.length, 16);
  header.writeUInt16BE(1, 20);
  const parts: Buffer[] = [header];
  let off = header.length;
  tags.forEach((tag, i) => {
    const data = sfnt.tables.get(tag)!;
    const z = deflateSync(data);
    const stored = z.length < data.length ? z : data;
    const e = 44 + 20 * i;
    header.write(tag, e, "latin1");
    header.writeUInt32BE(off, e + 4);
    header.writeUInt32BE(stored.length, e + 8);
    header.writeUInt32BE(data.length, e + 12);
    header.writeUInt32BE(ttf.readUInt32BE(12 + 16 * i + 4), e + 16); // the sfnt's own checksum
    parts.push(stored, Buffer.alloc(pad4(stored.length) - stored.length));
    off += pad4(stored.length);
  });
  header.writeUInt32BE(off, 8);
  return Buffer.concat(parts);
}

export type FontSubset = {
  /** the cut-down font (WOFF unless `format: "ttf"`), or the original bytes when copied */
  data: Buffer;
  how: "subset" | "copied";
  /** why it was copied whole */
  why?: string;
  /** the requested characters the font has (the ones it keeps) */
  kept: number;
  /** glyphs left with outlines, of all */
  glyphs: { kept: number; of: number };
};

/** The font cut down to `chars` (a string, or code points): every glyph id
 *  kept, the glyphs no kept character can reach emptied, the cmap holding
 *  only the kept characters. TrueType outlines only — CFF and bitmap fonts
 *  come back whole, saying so. */
export function subsetFont(
  buf: Buffer,
  chars: string | Iterable<number>,
  opts: { format?: "woff" | "ttf"; index?: number } = {},
): FontSubset {
  const sfnt = readSfnt(buf, opts.index ?? 0);
  const info = fontInfo(sfnt);
  const cps = typeof chars === "string" ? [...chars].map((c) => c.codePointAt(0)!) : [...chars];
  const pairs: [number, number][] = [];
  const seen = new Set<number>();
  for (const cp of cps) {
    const g = info.cmap.get(cp);
    if (g === undefined || seen.has(cp)) continue;
    seen.add(cp);
    pairs.push([cp, g]);
  }
  const copied = (why: string): FontSubset => ({
    data: buf,
    how: "copied",
    why,
    kept: pairs.length,
    glyphs: { kept: info.glyphs, of: info.glyphs },
  });
  if (info.outlines !== "truetype")
    return copied(`${info.outlines} outlines are not cut down here — the whole file is kept`);
  const colr = sfnt.tables.get("COLR");
  if (colr && u16(colr, 0) !== 0)
    return copied("COLR version 1 colour glyphs — the whole file is kept");
  const glyphs = splitGlyphs(sfnt.tables);
  const keep = new Set<number>([0, ...pairs.map(([, g]) => g)]);
  const gsub = sfnt.tables.get("GSUB");
  for (let round = 0; round < 16; round++) {
    let grew = false;
    if (gsub && gsub.length >= 10) grew = gsubClosure(gsub, keep) || grew;
    if (colr) grew = colrClosure(colr, keep) || grew;
    for (const g of [...keep])
      for (const c of components(glyphs[g] ?? Buffer.alloc(0)))
        if (!keep.has(c) && c < glyphs.length) {
          keep.add(c);
          grew = true;
        }
    if (!grew) break;
  }
  const { glyf, loca } = joinGlyphs(glyphs.map((g, i) => (keep.has(i) ? g : Buffer.alloc(0))));
  const tables: Tables = new Map(sfnt.tables);
  tables.delete("DSIG");
  tables.set("glyf", glyf);
  tables.set("loca", loca);
  const head = Buffer.from(tables.get("head")!);
  head.writeInt16BE(1, 50);
  tables.set("head", head);
  tables.set("cmap", buildCmap(pairs));
  const gvar = tables.get("gvar");
  if (gvar) tables.set("gvar", subsetGvar(gvar, keep));
  const ttf = writeSfnt(sfnt.flavor === 0x74727565 ? 0x00010000 : sfnt.flavor, tables);
  return {
    data: opts.format === "ttf" ? ttf : toWoff(ttf),
    how: "subset",
    kept: pairs.length,
    glyphs: {
      kept: [...keep].filter((g) => g < glyphs.length && glyphs[g]!.length).length,
      of: glyphs.length,
    },
  };
}

// --- colour -----------------------------------------------------------------

/** sRGB 0..255 channels, alpha 0..1 */
export type Rgba = { r: number; g: number; b: number; a: number };

const NAMED: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  yellow: "#ffff00",
  orange: "#ffa500",
  purple: "#800080",
  navy: "#000080",
  teal: "#008080",
};

/** A CSS colour in hex, rgb()/rgba() (comma or space syntax), hsl()/hsla(),
 *  `transparent` or a few common names; null for anything else. */
export function parseCssColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (NAMED[s]) return parseCssColor(NAMED[s]!);
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s);
  if (!fn) return null;
  const parts = fn[2]!
    .replace(/\s*\/\s*/, " / ")
    .split(/[\s,]+/)
    .filter((p) => p && p !== "/");
  if (parts.length < 3) return null;
  const num = (p: string, scale: number) =>
    p.endsWith("%") ? (Number.parseFloat(p) / 100) * scale : Number.parseFloat(p);
  const alpha = parts[3] != null ? num(parts[3], 1) : 1;
  if (fn[1]!.startsWith("rgb")) {
    const [r, g, b] = parts.slice(0, 3).map((p) => num(p, 255)) as [number, number, number];
    if (![r, g, b, alpha].every(Number.isFinite)) return null;
    const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    return { r: c(r), g: c(g), b: c(b), a: Math.max(0, Math.min(1, alpha)) };
  }
  const h = (((Number.parseFloat(parts[0]!) % 360) + 360) % 360) / 360;
  const sat = Number.parseFloat(parts[1]!) / 100;
  const l = Number.parseFloat(parts[2]!) / 100;
  if (![h, sat, l, alpha].every(Number.isFinite)) return null;
  const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
  const p = 2 * l - q;
  const ch = (t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    const v =
      u < 1 / 6
        ? p + (q - p) * 6 * u
        : u < 1 / 2
          ? q
          : u < 2 / 3
            ? p + (q - p) * (2 / 3 - u) * 6
            : p;
    return Math.round(v * 255);
  };
  return { r: ch(h + 1 / 3), g: ch(h), b: ch(h - 1 / 3), a: Math.max(0, Math.min(1, alpha)) };
}

const hex2 = (v: number) => Math.round(v).toString(16).padStart(2, "0");
/** #rrggbb, or #rrggbbaa when not opaque */
export const toHex = (c: Rgba): string =>
  `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${c.a < 1 ? hex2(c.a * 255) : ""}`;

/** `fg` laid over `bg` (alpha compositing; bg taken as opaque) */
export function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance, 0 (black) .. 1 (white) */
export const relativeLuminance = (c: Rgba): number =>
  0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);

/** WCAG contrast ratio of `fg` on `bg` (1..21); a translucent fg is laid over bg first */
export function contrastRatio(fg: Rgba | string, bg: Rgba | string): number {
  const b = typeof bg === "string" ? parseCssColor(bg) : bg;
  const f = typeof fg === "string" ? parseCssColor(fg) : fg;
  if (!b || !f) return Number.NaN;
  const bb = b.a < 1 ? over(b, { r: 255, g: 255, b: 255, a: 1 }) : b;
  const l1 = relativeLuminance(over(f, bb));
  const l2 = relativeLuminance(bb);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** OKLCH: lightness 0..1, chroma (≈0..0.37), hue in degrees */
export function oklch(c: Rgba): [number, number, number] {
  const r = lin(c.r);
  const g = lin(c.g);
  const b = lin(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(A, B);
  const H = C < 1e-4 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return [L, C, H];
}

/** distance in OKLab (0 same .. ~1 black–white) */
function okDistance(a: Rgba, b: Rgba): number {
  const [l1, c1, h1] = oklch(a);
  const [l2, c2, h2] = oklch(b);
  const x1 = c1 * Math.cos((h1 * Math.PI) / 180);
  const y1 = c1 * Math.sin((h1 * Math.PI) / 180);
  const x2 = c2 * Math.cos((h2 * Math.PI) / 180);
  const y2 = c2 * Math.sin((h2 * Math.PI) / 180);
  return Math.hypot(l1 - l2, x1 - x2, y1 - y2);
}

// --- text at film scale -------------------------------------------------------

export type ScreenSize = { name: string; widthPx: number; mmPerPx?: number };

/** Where a film is watched, as the CSS px width the frame is shown across.
 *  The phone's millimetres assume a 6.1-inch phone (393 px across 65 mm). */
export const SCREENS: readonly ScreenSize[] = [
  { name: "phone, upright, film across the screen", widthPx: 393, mmPerPx: 65.1 / 393 },
  { name: "phone, sideways, full screen", widthPx: 852, mmPerPx: 141.2 / 852 },
  { name: "desktop timeline (about 600 px wide)", widthPx: 600 },
  { name: "laptop, full screen", widthPx: 1440 },
];

export type Readable = {
  filmPx: number;
  filmWidth: number;
  on: { screen: string; px: number; mm?: number }[];
  /** what those sizes compare with: Apple's default text sizes (px = pt) */
  reference: string;
};

/** How big text set at `sizePx` in a `filmWidth`-wide film shows on the
 *  screens it is watched on — information, not a rule. */
export function readableSize(
  sizePx: number,
  opts: { filmWidth?: number; screens?: readonly ScreenSize[] } = {},
): Readable {
  const filmWidth = opts.filmWidth ?? 1920;
  return {
    filmPx: sizePx,
    filmWidth,
    on: (opts.screens ?? SCREENS).map((s) => {
      const px = Math.round(((sizePx * s.widthPx) / filmWidth) * 10) / 10;
      return {
        screen: s.name,
        px,
        ...(s.mmPerPx ? { mm: Math.round(px * s.mmPerPx * 10) / 10 } : {}),
      };
    }),
    reference: "iOS default text: body 17 px, footnote 13 px, caption 12 px, the smallest 11 px",
  };
}

// --- CSS ------------------------------------------------------------------------

export type CssDecl = {
  selector: string;
  property: string;
  value: string;
  /** which block it sits in: declarations of one rule share it */
  block: number;
};

/** Every declaration in a stylesheet with the selector (or at-rule) it sits
 *  under — nested blocks flattened, comments dropped. Tolerant: it never
 *  throws on broken CSS, it just reads what it can. */
export function cssDeclarations(css: string): CssDecl[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: CssDecl[] = [];
  const stack: { selector: string; block: number }[] = [];
  let blocks = 0;
  let buf = "";
  let quote = "";
  let paren = 0;
  const flush = () => {
    const d = buf.trim();
    buf = "";
    const colon = d.indexOf(":");
    const top = stack[stack.length - 1];
    if (colon <= 0 || !top) return;
    const property = d.slice(0, colon).trim();
    if (!/^(--)?[a-zA-Z-][\w-]*$/.test(property)) return;
    out.push({
      selector: top.selector,
      property: property.startsWith("--") ? property : property.toLowerCase(),
      value: d.slice(colon + 1).trim(),
      block: top.block,
    });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      buf += ch;
      if (ch === "\\") buf += text[++i] ?? "";
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === "(") {
      paren++;
      buf += ch;
    } else if (ch === ")") {
      paren = Math.max(0, paren - 1);
      buf += ch;
    } else if (paren) buf += ch;
    else if (ch === "{") {
      stack.push({ selector: buf.trim().replace(/\s+/g, " "), block: blocks++ });
      buf = "";
    } else if (ch === "}") {
      flush();
      stack.pop();
    } else if (ch === ";") flush();
    else buf += ch;
  }
  return out;
}

/** "U+0-7F, U+4??, U+20AC" → [start, end] ranges */
export function parseUnicodeRange(s: string): [number, number][] {
  const out: [number, number][] = [];
  for (const part of s.split(",")) {
    const m = /^\s*u\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?\s*$/i.exec(part);
    if (!m) continue;
    if (m[1]!.includes("?"))
      out.push([parseInt(m[1]!.replace(/\?/g, "0"), 16), parseInt(m[1]!.replace(/\?/g, "f"), 16)]);
    else out.push([parseInt(m[1]!, 16), parseInt(m[2] ?? m[1]!, 16)]);
  }
  return out;
}

/** code points → the shortest "U+…" list */
export function unicodeRangeOf(cps: Iterable<number>): string {
  const sorted = [...new Set(cps)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    const a = sorted[i]!.toString(16).toUpperCase();
    parts.push(i === j ? `U+${a}` : `U+${a}-${sorted[j]!.toString(16).toUpperCase()}`);
    i = j + 1;
  }
  return parts.join(", ");
}

const inRanges = (cp: number, ranges: readonly [number, number][]) =>
  !ranges.length || ranges.some(([a, b]) => cp >= a && cp <= b);

export type CssFontFace = {
  family: string;
  /** as declared: "400", "100 900" */
  weight: string;
  style: string;
  unicodeRange: string;
  /** the first url() source, resolved against the stylesheet; null when none
   *  (local() only) — "about:blank" is a source a saved screen never loaded */
  src: string | null;
  format: string | null;
};

const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, "$2");

/** The @font-face rules of a stylesheet, their url()s resolved against `base`. */
export function parseFontFaces(css: string, base?: string): CssFontFace[] {
  const blocks = new Map<number, Record<string, string>>();
  for (const d of cssDeclarations(css)) {
    if (d.selector.toLowerCase() !== "@font-face") continue;
    const b = blocks.get(d.block) ?? {};
    b[d.property] = d.value;
    blocks.set(d.block, b);
  }
  const faces: CssFontFace[] = [];
  for (const cur of blocks.values()) {
    if (!cur["font-family"]) continue;
    const m = /url\(\s*(['"]?)([^'")]+)\1\s*\)(?:\s*format\(\s*['"]?([^'")]+)['"]?\s*\))?/.exec(
      cur.src ?? "",
    );
    let url: string | null = null;
    if (m) {
      try {
        url = base ? new URL(m[2]!, base).href : m[2]!;
      } catch {
        url = m[2]!;
      }
    }
    faces.push({
      family: unquote(cur["font-family"]),
      weight: (cur["font-weight"] ?? "400").replace(/\s+/g, " "),
      style: cur["font-style"] ?? "normal",
      unicodeRange: cur["unicode-range"] ?? "",
      src: url,
      format: m?.[3] ?? null,
    });
  }
  return faces;
}

const DURATION = /(-?\d*\.?\d+)(ms|s)\b/g;
const EASING =
  /cubic-bezier\([^)]*\)|steps\([^)]*\)|linear\([^)]*\)|\b(?:ease-in-out|ease-in|ease-out|ease|linear|step-start|step-end)\b/g;

export type CssMotion = {
  durations: { ms: number; count: number; where: string[] }[];
  easings: { value: string; count: number; where: string[] }[];
  keyframes: string[];
};

/** Transition and animation timings declared in stylesheets. Declared is not
 *  played: a utility class can sit in the CSS unused. */
export function cssMotion(sheets: readonly string[]): CssMotion {
  const durations = new Map<number, { count: number; where: Set<string> }>();
  const easings = new Map<string, { count: number; where: Set<string> }>();
  const keyframes = new Set<string>();
  const note = <K>(m: Map<K, { count: number; where: Set<string> }>, k: K, where: string) => {
    const e = m.get(k) ?? { count: 0, where: new Set<string>() };
    e.count++;
    if (e.where.size < 4) e.where.add(where);
    m.set(k, e);
  };
  for (const css of sheets) {
    for (const m of css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .matchAll(/@(?:-webkit-)?keyframes\s+([\w-]+)/g))
      keyframes.add(m[1]!);
    for (const d of cssDeclarations(css)) {
      if (!/^(-webkit-)?(transition|animation)(-duration|-timing-function)?$/.test(d.property))
        continue;
      if (/^(none|initial|inherit|unset)$/.test(d.value)) continue;
      const where = `${d.selector.slice(0, 60)} { ${d.property} }`;
      if (!d.property.endsWith("timing-function"))
        for (const m of d.value.replace(EASING, " ").matchAll(DURATION)) {
          const ms = Math.round(Number.parseFloat(m[1]!) * (m[2] === "s" ? 1000 : 1));
          // a transition's second time is its delay; both are listed as found
          if (ms > 0) note(durations, ms, where);
        }
      if (!d.property.endsWith("-duration"))
        for (const m of d.value.matchAll(EASING)) note(easings, m[0]!.replace(/\s+/g, ""), where);
    }
  }
  const list = <K>(m: Map<K, { count: number; where: Set<string> }>) =>
    [...m]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([k, v]) => ({ k, count: v.count, where: [...v.where] }));
  return {
    durations: list(durations).map(({ k, ...r }) => ({ ms: k, ...r })),
    easings: list(easings).map(({ k, ...r }) => ({ value: k, ...r })),
    keyframes: [...keyframes],
  };
}

// --- the film's own words ---------------------------------------------------------

/** String literals in a script — template literal text included, `${…}`
 *  read for the strings inside it; comments and regular expressions skipped. */
export function scriptStrings(js: string): string[] {
  const out: string[] = [];
  let i = 0;
  let last = ""; // the last significant character outside strings and comments
  const regexCanStart = () => !last || /[(,=:[!&|?{};+\-*%<>~^]/.test(last);
  const walk = (stopAtBrace: boolean): void => {
    let depth = 0;
    while (i < js.length) {
      const ch = js[i]!;
      const next = js[i + 1];
      if (ch === "/" && next === "/") {
        while (i < js.length && js[i] !== "\n") i++;
        continue;
      }
      if (ch === "/" && next === "*") {
        const e = js.indexOf("*/", i + 2);
        i = e < 0 ? js.length : e + 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        let s = "";
        i++;
        while (i < js.length && js[i] !== ch && js[i] !== "\n") {
          if (js[i] === "\\") {
            s += unescapeJs(js, i);
            i += escapeLength(js, i);
          } else s += js[i++];
        }
        i++;
        out.push(s);
        last = "a";
        continue;
      }
      if (ch === "`") {
        i++;
        let s = "";
        while (i < js.length && js[i] !== "`") {
          if (js[i] === "\\") {
            s += unescapeJs(js, i);
            i += escapeLength(js, i);
          } else if (js[i] === "$" && js[i + 1] === "{") {
            out.push(s);
            s = "";
            i += 2;
            walk(true);
          } else s += js[i++];
        }
        i++;
        out.push(s);
        last = "a";
        continue;
      }
      if (ch === "/" && regexCanStart()) {
        // a regular expression literal: skip to its unescaped closing slash
        i++;
        let cls = false;
        while (i < js.length && js[i] !== "\n") {
          if (js[i] === "\\") i += 2;
          else if (js[i] === "[") {
            cls = true;
            i++;
          } else if (js[i] === "]") {
            cls = false;
            i++;
          } else if (js[i] === "/" && !cls) break;
          else i++;
        }
        i++;
        last = "a";
        continue;
      }
      if (stopAtBrace) {
        if (ch === "{") depth++;
        if (ch === "}") {
          if (depth === 0) {
            i++;
            return;
          }
          depth--;
        }
      }
      if (!/\s/.test(ch)) {
        // a keyword before a slash still starts a regex
        if (/[\w$]/.test(ch)) {
          let w = "";
          while (i < js.length && /[\w$]/.test(js[i]!)) w += js[i++];
          last = /^(return|typeof|case|do|else|in|of|void|yield|await)$/.test(w) ? "(" : "a";
          continue;
        }
        last = ch;
      }
      i++;
    }
  };
  walk(false);
  return out.filter((s) => s.trim());
}

function escapeLength(js: string, i: number): number {
  const c = js[i + 1];
  if (c === "u") return js[i + 2] === "{" ? js.indexOf("}", i) - i + 1 : 6;
  if (c === "x") return 4;
  return 2;
}

function unescapeJs(js: string, i: number): string {
  const c = js[i + 1] ?? "";
  if (c === "u") {
    const code = js[i + 2] === "{" ? js.slice(i + 3, js.indexOf("}", i)) : js.slice(i + 2, i + 6);
    const n = parseInt(code, 16);
    return Number.isFinite(n) ? String.fromCodePoint(n) : "";
  }
  if (c === "x") return String.fromCharCode(parseInt(js.slice(i + 2, i + 4), 16) || 0);
  return (
    ({ n: "\n", t: "\t", r: "", b: "", f: "", v: "", "0": "" } as Record<string, string>)[c] ?? c
  );
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
const decodeHtml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** markup and CSS-looking strings dropped from a string literal, what a viewer could read kept */
function readableText(s: string): string {
  const t = s.replace(/<[^>]*>/g, " ");
  return decodeHtml(t);
}

const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
  "-apple-system",
  "blinkmacsystemfont",
]); // prettier-ignore

/** The words a film page could show, read statically: its markup's text and
 *  every string literal in its own scripts (inline, and the .js/.mjs/.json
 *  files it loads from its folder — kit/ left out), markup inside strings
 *  stripped. An estimate: text a page builds or fetches at run time is not
 *  seen, and a string that never reaches the screen is counted. */
export async function filmText(page: string): Promise<{ text: string; files: string[] }> {
  const { existsSync, statSync } = await import("node:fs");
  const { readFile } = await import("node:fs/promises");
  const { dirname, join, resolve, relative, sep } = await import("node:path");
  let file = resolve(page);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) throw new Error(`film look: no film page at ${page}`);
  const root = dirname(file);
  const parts: string[] = [];
  const files: string[] = [];
  const seen = new Set<string>();
  const local = (from: string, spec: string): string | null => {
    if (/^[a-z]+:|^\/\//i.test(spec) || spec.startsWith("data:")) return null;
    const p = resolve(dirname(from), spec.split(/[?#]/)[0]!);
    const rel = relative(root, p);
    if (rel.startsWith("..") || rel.split(sep)[0] === "kit" || rel.includes("node_modules"))
      return null;
    return existsSync(p) && statSync(p).isFile() ? p : null;
  };
  const readScript = async (path: string): Promise<void> => {
    if (seen.has(path)) return;
    seen.add(path);
    files.push(path);
    const src = await readFile(path, "utf8");
    if (path.endsWith(".json")) {
      const walk = (v: unknown) => {
        if (typeof v === "string") parts.push(readableText(v));
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") Object.values(v).forEach(walk);
      };
      try {
        walk(JSON.parse(src));
      } catch {
        /* not JSON after all */
      }
      return;
    }
    await readJs(path, src);
  };
  const readJs = async (from: string, src: string): Promise<void> => {
    for (const s of scriptStrings(src)) parts.push(readableText(s));
    const specs = [
      ...src.matchAll(/\bimport\s*(?:[\w*{}\s,$]+from\s*)?["']([^"']+)["']/g),
      ...src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
      ...src.matchAll(/\bfetch\(\s*["']([^"']+\.json)["']/g),
    ].map((m) => m[1]!);
    for (const spec of specs) {
      const p = local(from, spec);
      if (p && /\.(m?js|json)$/.test(p)) await readScript(p);
    }
  };
  const html = await readFile(file, "utf8");
  files.push(file);
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[1]!)?.[1];
    if (src) {
      const p = local(file, src);
      if (p) await readScript(p);
    } else await readJs(file, m[2]!);
  }
  const body = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  parts.push(decodeHtml(body.replace(/<[^>]*>/g, " ")));
  for (const m of body.matchAll(/\b(?:alt|title|aria-label|placeholder|value)\s*=\s*"([^"]*)"/gi))
    parts.push(decodeHtml(m[1]!));
  return { text: parts.join("\n"), files };
}

// --- reading a page -----------------------------------------------------------

/** What the page reader returns for one screen (all px are CSS px). */
type PageRead = {
  url: string;
  title: string;
  ua: string;
  width: number;
  height: number;
  frozen: boolean;
  samples: number;
  images: number;
  backgrounds: { hex: string; n: number; interactive: number; where: [string, number][] }[];
  gradients: { value: string; n: number; where: [string, number][] }[];
  texts: {
    hex: string;
    chars: number;
    area: number;
    interactive: number;
    grounds: [string, number][];
    where: [string, number][];
  }[];
  borders: { hex: string; length: number; where: [string, number][] }[];
  fills: { hex: string; area: number; where: [string, number][] }[];
  families: {
    family: string;
    webfont: boolean;
    chars: number;
    weights: [string, number][];
    sizes: [number, number][];
    stacks: string[];
  }[];
  type: {
    family: string;
    weight: string;
    size: number;
    chars: number;
    sample: string;
    where: string;
  }[];
  samples_: {
    text: string;
    family: string;
    weight: string;
    size: number;
    area: number;
    hex: string;
  }[];
  radii: { value: string; px: number; n: number; where: [string, number][] }[];
  shadows: { value: string; n: number; where: [string, number][] }[];
  transitions: { value: string; n: number; where: [string, number][] }[];
  faces: { family: string; weight: string; style: string; unicodeRange: string; status: string }[];
  sheets: { href?: string; text?: string }[];
};

// The reader runs inside the page. Backgrounds are sampled on a grid with
// elementsFromPoint, compositing translucent layers down to the first opaque
// one (white under all); text is read node by node with its rendered boxes,
// each character attributed to the first family in its stack whose declared
// faces cover it; borders, SVG fills, radii and shadows come from every
// element on screen. Colours are normalised by painting one canvas pixel.
const PAGE_READ_JS = String.raw`async () => {
  try { await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 8000))]); } catch (e) {}
  const W = innerWidth, H = innerHeight;
  const cv = document.createElement("canvas"); cv.width = cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  const colours = new Map();
  const rgba = (s) => {
    if (!s || s === "none") return null;
    if (colours.has(s)) return colours.get(s);
    let v = null;
    const m = /^rgba?\(([^)]+)\)$/.exec(s);
    if (m) {
      const p = m[1].split(/[\s,\/]+/).filter(Boolean).map((x) => x.endsWith("%") ? parseFloat(x) / 100 : Number(x));
      v = [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    } else {
      cx.clearRect(0, 0, 1, 1); cx.fillStyle = "rgba(0,0,0,0)"; cx.fillStyle = s; cx.fillRect(0, 0, 1, 1);
      const d = cx.getImageData(0, 0, 1, 1).data; v = [d[0], d[1], d[2], d[3] / 255];
    }
    colours.set(s, v);
    return v;
  };
  const h2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  const hex = (c) => "#" + h2(c[0]) + h2(c[1]) + h2(c[2]) + (c[3] < 0.995 ? h2(c[3] * 255) : "");
  const styles = new Map();
  const cs = (el) => { let s = styles.get(el); if (!s) { s = getComputedStyle(el); styles.set(el, s); } return s; };
  const descs = new Map();
  const desc = (el) => {
    if (!el) return "page";
    if (descs.has(el)) return descs.get(el);
    let d = el.tagName.toLowerCase();
    if (el.id && el.id.length < 24 && !/\d{4}/.test(el.id)) d += "#" + el.id;
    else {
      const c = (el.getAttribute("class") || "").split(/\s+/).find((c) => c && c.length < 28 && !c.includes(":") && !/[0-9a-f]{5,}|__|--[a-z0-9]{5}/i.test(c));
      if (c) d += "." + c;
    }
    const r = el.getBoundingClientRect();
    if (r.width * r.height < W * H * 0.2) {
      const t = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("alt") || "").trim().replace(/\s+/g, " ").slice(0, 24);
      if (t) d += ' "' + t + '"';
    }
    descs.set(el, d);
    return d;
  };
  const INTERACTIVE = "a,button,[role=button],[role=link],[role=tab],input,select,textarea,summary";
  const interactive = (el) => !!(el && el.closest && el.closest(INTERACTIVE));
  const bump = (map, key, el, add, inter) => {
    let e = map.get(key);
    if (!e) { e = { n: 0, interactive: 0, where: new Map() }; map.set(key, e); }
    e.n += add;
    if (inter) e.interactive += add;
    const d = desc(el);
    e.where.set(d, (e.where.get(d) || 0) + add);
    return e;
  };
  const top3 = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => [k, Math.round(v * 100) / 100]);
  const IMAGE = new Set(["IMG", "VIDEO", "CANVAS", "PICTURE", "IFRAME", "OBJECT", "EMBED"]);
  // the canvas under everything: the root's background, or the body's when
  // the root has none (CSS propagates it, and the body then paints none)
  const html = document.documentElement, body = document.body;
  const rootBg = rgba(cs(html).backgroundColor);
  const fromBody = !(rootBg && rootBg[3] > 0) && cs(html).backgroundImage === "none" && body;
  const canvasBg = (() => {
    const c = fromBody ? rgba(cs(body).backgroundColor) : rootBg;
    if (!c || c[3] === 0) return [255, 255, 255];
    const k = 1 - c[3];
    return [c[0] * c[3] + 255 * k, c[1] * c[3] + 255 * k, c[2] * c[3] + 255 * k];
  })();
  const canvasEl = fromBody ? body : html;
  const ground = (x, y) => {
    let r = 0, g = 0, b = 0, a = 0, top = null;
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === html || (fromBody && el === body)) break;
      if (IMAGE.has(el.tagName) || el.tagName.toLowerCase() === "svg") {
        if (el.tagName.toLowerCase() === "svg") continue;
        return { kind: "image", top: top || el };
      }
      if (el instanceof SVGElement) continue;
      const s = cs(el);
      const bi = s.backgroundImage;
      if (bi && bi !== "none" && a < 0.5) return { kind: bi.includes("url(") ? "image" : "gradient", value: bi, top: top || el };
      const c = rgba(s.backgroundColor);
      if (c && c[3] > 0) {
        const k = (1 - a) * c[3];
        r += k * c[0]; g += k * c[1]; b += k * c[2]; a += k;
        if (!top) top = el;
      }
      if (a >= 0.995) break;
    }
    const k = 1 - a;
    return { kind: "colour", colour: [r + k * canvasBg[0], g + k * canvasBg[1], b + k * canvasBg[2], 1], top: top || canvasEl };
  };
  const step = Math.max(8, Math.round(Math.max(W, H) / 160));
  const bgs = new Map(), grads = new Map();
  let samples = 0, images = 0;
  for (let y = step / 2; y < H; y += step)
    for (let x = step / 2; x < W; x += step) {
      samples++;
      const p = ground(x, y);
      if (p.kind === "image") images++;
      else if (p.kind === "gradient") bump(grads, p.value.slice(0, 300), p.top, 1, false);
      else bump(bgs, hex(p.colour), p.top, 1, interactive(p.top));
    }
  // faces, by family, for attributing characters
  const faces = [...document.fonts].map((f) => ({ family: f.family.replace(/^["']|["']$/g, ""), weight: String(f.weight), style: f.style, unicodeRange: f.unicodeRange, status: f.status }));
  const parseRange = (s) => (s || "").split(",").map((p) => {
    const m = /u\+([0-9a-f?]+)(?:-([0-9a-f]+))?/i.exec(p.trim());
    if (!m) return null;
    if (m[1].includes("?")) return [parseInt(m[1].replace(/\?/g, "0"), 16), parseInt(m[1].replace(/\?/g, "f"), 16)];
    return [parseInt(m[1], 16), parseInt(m[2] || m[1], 16)];
  }).filter(Boolean);
  const byFamily = new Map();
  for (const f of faces) {
    const k = f.family.toLowerCase();
    if (!byFamily.has(k)) byFamily.set(k, []);
    byFamily.get(k).push(parseRange(f.unicodeRange));
  }
  const covers = (k, cp) => byFamily.get(k).some((rs) => !rs.length || rs.some((r) => cp >= r[0] && cp <= r[1]));
  // families whose every readable @font-face is local() only (a metric
  // fallback like "X Fallback": src: local(Arial)) are checked glyph by glyph,
  // like fonts of the machine, instead of by their (absent) unicode-range
  const localOnly = new Map();
  const scanRules = (rules) => {
    for (const r of rules) {
      if (r instanceof CSSFontFaceRule) {
        const fam = (r.style.getPropertyValue("font-family") || "").trim().replace(/^["']|["']$/g, "").toLowerCase();
        const url = /url\(/.test(r.style.getPropertyValue("src") || "");
        localOnly.set(fam, (localOnly.has(fam) ? localOnly.get(fam) : true) && !url);
      } else if (r.cssRules) scanRules(r.cssRules);
    }
  };
  for (const ss of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) { try { scanRules(ss.cssRules); } catch (e) {} }
  const glyphs_ = new Map();
  const hasGlyph = (fam, weight, ch) => {
    const k = fam + "|" + weight + "|" + ch;
    if (glyphs_.has(k)) return glyphs_.get(k);
    const width = (f) => { cx.font = weight + " 64px " + f; return cx.measureText(ch).width; };
    const q = JSON.stringify(fam);
    const v = width(q + ",monospace") !== width("monospace") || width(q + ",serif") !== width("serif");
    glyphs_.set(k, v);
    return v;
  };
  const stacks = new Map();
  const stackOf = (s) => {
    if (!stacks.has(s)) stacks.set(s, s.split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
    return stacks.get(s);
  };
  const familyFor = (stack, cp, weight, ch) => {
    for (const fam of stack) {
      const k = fam.toLowerCase();
      if (byFamily.has(k) && !localOnly.get(k)) { if (covers(k, cp)) return [fam, true]; continue; }
      if (GENERIC.has(k)) return [fam, false];
      if (hasGlyph(fam, weight, ch)) return [fam, false];
    }
    return ["(browser default)", false];
  };
  const GENERIC = new Set(${JSON.stringify([...GENERIC_FAMILIES])});
  const opacities = new Map();
  const opacity = (el) => {
    if (!el || el.nodeType !== 1) return 1;
    if (opacities.has(el)) return opacities.get(el);
    const v = parseFloat(cs(el).opacity || "1") * opacity(el.parentElement);
    opacities.set(el, v);
    return v;
  };
  const texts = new Map(), fams = new Map(), type = new Map(), said = [];
  const range = document.createRange();
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TITLE", "OPTION"]);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const raw = node.nodeValue;
    if (!raw || !raw.trim()) continue;
    const el = node.parentElement;
    if (!el || SKIP.has(el.tagName)) continue;
    const s = cs(el);
    if (s.visibility !== "visible" || opacity(el) < 0.05) continue;
    range.selectNodeContents(node);
    let area = 0, all = 0, first = null;
    for (const rc of range.getClientRects()) {
      all += rc.width * rc.height;
      const w = Math.min(rc.right, W) - Math.max(rc.left, 0), h = Math.min(rc.bottom, H) - Math.max(rc.top, 0);
      if (w > 0 && h > 0) { area += w * h; if (!first) first = rc; }
    }
    if (!area) continue;
    const frac = all ? area / all : 1;
    let text = raw.replace(/\s+/g, " ").trim();
    if (s.textTransform === "uppercase") text = text.toUpperCase();
    else if (s.textTransform === "lowercase") text = text.toLowerCase();
    const glyphs = [...text.replace(/\s/g, "")];
    const chars = glyphs.length * frac;
    let fill = rgba(s.webkitTextFillColor) || rgba(s.color);
    const clipText = (s.webkitBackgroundClip || s.backgroundClip) === "text";
    const fg = clipText && fill && fill[3] === 0 ? "gradient text" : fill ? hex([fill[0], fill[1], fill[2], fill[3] * opacity(el)]) : "unknown";
    const gx = Math.max(0, Math.min(W - 1, first.left + first.width / 2)), gy = Math.max(0, Math.min(H - 1, first.top + first.height / 2));
    const gp = ground(gx, gy);
    const g = gp.kind === "colour" ? hex(gp.colour) : gp.kind;
    const e = bump(texts, fg, el, chars, interactive(el));
    e.area = (e.area || 0) + area;
    e.grounds = e.grounds || new Map();
    e.grounds.set(g, (e.grounds.get(g) || 0) + chars);
    const stack = stackOf(s.fontFamily);
    const size = Math.round(parseFloat(s.fontSize) * 10) / 10;
    const weight = s.fontWeight;
    const count = new Map();
    for (const ch of glyphs) {
      const [fam, web] = familyFor(stack, ch.codePointAt(0), weight, ch);
      let f = fams.get(fam);
      if (!f) { f = { family: fam, webfont: web, chars: 0, weights: new Map(), sizes: new Map(), stacks: new Set() }; fams.set(fam, f); }
      f.chars += frac; f.weights.set(weight, (f.weights.get(weight) || 0) + frac); f.sizes.set(size, (f.sizes.get(size) || 0) + frac); f.stacks.add(s.fontFamily);
      count.set(fam, (count.get(fam) || 0) + 1);
    }
    const main = [...count].sort((a, b) => b[1] - a[1])[0];
    if (!main) continue;
    const tk = main[0] + "|" + weight + "|" + size;
    let t = type.get(tk);
    if (!t) { t = { family: main[0], weight, size, chars: 0, sample: text.slice(0, 60), where: desc(el) }; type.set(tk, t); }
    t.chars += chars;
    said.push({ text: text.slice(0, 120), family: main[0], weight, size, area, hex: fg });
  }
  const borders = new Map(), fills = new Map(), radii = new Map(), shadows = new Map(), trans = new Map();
  const px = (v, base) => v.endsWith("%") ? parseFloat(v) / 100 * base : parseFloat(v) || 0;
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.right <= 0 || r.bottom <= 0 || r.left >= W || r.top >= H) continue;
    const s = cs(el);
    if (s.visibility !== "visible" || opacity(el) < 0.05) continue;
    const cw = Math.min(r.right, W) - Math.max(r.left, 0), ch = Math.min(r.bottom, H) - Math.max(r.top, 0);
    if (el instanceof SVGElement) {
      const tag = el.tagName.toLowerCase();
      if (tag === "svg" || tag === "g" || tag === "defs" || tag === "symbol") continue;
      const f = rgba(s.fill);
      if (f && f[3] > 0.05 && s.fill !== "none") bump(fills, hex(f), el.closest("svg") || el, cw * ch / (W * H), false);
      const st = rgba(s.stroke);
      if (st && st[3] > 0.05 && s.stroke !== "none") bump(fills, hex(st), el.closest("svg") || el, (cw + ch) * 2 * (parseFloat(s.strokeWidth) || 1) / (W * H), false);
      continue;
    }
    let bordered = false;
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      const w = parseFloat(s["border" + side + "Width"]);
      const style = s["border" + side + "Style"];
      if (!(w > 0) || style === "none" || style === "hidden") continue;
      const c = rgba(s["border" + side + "Color"]);
      if (!c || c[3] < 0.05) continue;
      bordered = true;
      bump(borders, hex(c), el, side === "Top" || side === "Bottom" ? cw : ch, false);
    }
    const bg = rgba(s.backgroundColor);
    const visual = (bg && bg[3] > 0.05) || bordered || s.boxShadow !== "none" || s.backgroundImage !== "none" || IMAGE.has(el.tagName);
    if (visual) {
      const rad = Math.max(px(s.borderTopLeftRadius, r.width), px(s.borderTopRightRadius, r.width), px(s.borderBottomLeftRadius, r.width), px(s.borderBottomRightRadius, r.width));
      if (rad >= 0.5) {
        const pill = rad >= Math.min(r.width, r.height) / 2 - 0.5;
        const key = pill ? (Math.abs(r.width - r.height) < 2 ? "circle" : "pill") : Math.round(rad) + "px";
        const e = bump(radii, key, el, 1, false);
        e.px = pill ? Math.min(r.width, r.height) / 2 : Math.round(rad);
      }
    }
    if (s.boxShadow && s.boxShadow !== "none") {
      // the layers that draw something (a utility framework stacks empty ones)
      const layers = s.boxShadow.split(/,(?![^(]*\))/).map((x) => x.trim()).filter((x) => {
        const c = /rgba?\([^)]*\)|#[0-9a-f]+|[a-z]+\([^)]*\)/i.exec(x);
        const col = c ? rgba(c[0]) : [0, 0, 0, 1];
        const nums = x.replace(c ? c[0] : "", "").match(/-?[\d.]+px/g) || [];
        return col && col[3] > 0.01 && nums.some((n) => parseFloat(n) !== 0);
      });
      if (layers.length) bump(shadows, layers.join(", "), el, 1, false);
    }
    if (s.transitionDuration && s.transitionDuration.split(",").some((d) => parseFloat(d) > 0))
      bump(trans, s.transitionProperty + " " + s.transitionDuration + " " + s.transitionTimingFunction, el, 1, false);
    if (s.animationName && s.animationName !== "none")
      bump(trans, "animation " + s.animationName + " " + s.animationDuration + " " + s.animationTimingFunction, el, 1, false);
  }
  const sheets = [];
  for (const ss of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) {
    if (ss.href) { sheets.push({ href: ss.href }); continue; }
    let text = ss.ownerNode && ss.ownerNode.textContent;
    if (!text) { try { text = [...ss.cssRules].map((r) => r.cssText).join("\n"); } catch (e) {} }
    if (text) sheets.push({ text });
  }
  const list = (m, f) => [...m].map(([k, e]) => f(k, e));
  return {
    url: location.href, title: document.title, ua: navigator.userAgent, width: W, height: H,
    frozen: !!document.querySelector("style[data-ot-freeze]"), samples, images,
    backgrounds: list(bgs, (k, e) => ({ hex: k, n: e.n, interactive: e.interactive, where: top3(e.where) })),
    gradients: list(grads, (k, e) => ({ value: k, n: e.n, where: top3(e.where) })),
    texts: list(texts, (k, e) => ({ hex: k, chars: e.n, area: e.area, interactive: e.interactive, grounds: top3(e.grounds), where: top3(e.where) })),
    borders: list(borders, (k, e) => ({ hex: k, length: e.n, where: top3(e.where) })),
    fills: list(fills, (k, e) => ({ hex: k, area: e.n, where: top3(e.where) })),
    families: [...fams.values()].map((f) => ({ family: f.family, webfont: f.webfont, chars: f.chars, weights: [...f.weights], sizes: [...f.sizes], stacks: [...f.stacks].slice(0, 4) })),
    type: [...type.values()],
    samples_: said.sort((a, b) => b.size - a.size || b.area - a.area).slice(0, 80),
    radii: list(radii, (k, e) => ({ value: k, px: e.px, n: e.n, where: top3(e.where) })),
    shadows: list(shadows, (k, e) => ({ value: k, n: e.n, where: top3(e.where) })),
    transitions: list(trans, (k, e) => ({ value: k, n: e.n, where: top3(e.where) })),
    faces, sheets,
  };
}`;

/** resolves custom properties (names found in the CSS) at the root, colours normalised */
const VARS_JS = `(names) => {
  const root = getComputedStyle(document.documentElement);
  const body = document.body ? getComputedStyle(document.body) : root;
  const cv = document.createElement("canvas"); cv.width = cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  const h2 = (n) => Math.round(n).toString(16).padStart(2, "0");
  return names.map((n) => {
    const v = (root.getPropertyValue(n) || body.getPropertyValue(n) || "").trim();
    if (!v || !CSS.supports("color", v) || /^(inherit|initial|unset|currentcolor)$/i.test(v)) return [n, v, null];
    cx.clearRect(0, 0, 1, 1); cx.fillStyle = "rgba(0,0,0,0)"; cx.fillStyle = v; cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return [n, v, "#" + h2(d[0]) + h2(d[1]) + h2(d[2]) + (d[3] < 254 ? h2(d[3]) : "")];
  });
}`;

/** Cancels the page's uncaught errors and rejections, so a live site's own
 *  failures (an analytics script, a blocked request) leave the read alone. */
const QUIET_ERRORS_JS =
  "addEventListener('error',function(e){e.preventDefault()},true);addEventListener('unhandledrejection',function(e){e.preventDefault()},true);";

// --- the look -----------------------------------------------------------------

export type How = "measured" | "estimated" | "not detected";

export type LookColour = {
  hex: string;
  /** share of the sampled screen it paints as a background (0..1) */
  background: number;
  /** characters set in it */
  text: number;
  /** px of border edge drawn in it */
  border: number;
  /** share of the screen its SVG fills and strokes cover */
  fill: number;
  /** share of its background and text use that is on links, buttons, inputs */
  interactive: number;
  /** the grounds its text sits on, with the contrast ratio there */
  on: { ground: string; chars: number; contrast: number | null }[];
  /** elements it was found on, most first */
  where: string[];
  /** custom properties that resolve to it */
  vars: string[];
  /** OKLCH lightness, chroma, hue */
  oklch: [number, number, number];
};

export type LookRole = {
  hex: string | null;
  how: How;
  why: string;
  where: string[];
  vars: string[];
  /** the next candidates, for a different reading */
  alternatives?: { hex: string; why: string }[];
};

export type RoleName = "bg" | "surface" | "text" | "muted" | "accent" | "onAccent" | "border";

export type LookFontFile = {
  /** relative to look.json, when the file is in fonts/ */
  file: string | null;
  /** where it came from (the product's URL, or the saved screen's asset) */
  source: string | null;
  weight: string;
  style: string;
  unicodeRange: string;
  status: "saved" | "downloaded" | "not saved" | "not downloaded" | string;
  bytes?: number;
  /** from the file itself */
  name?: string;
  glyphs?: number;
  chars?: number;
  outlines?: FontInfo["outlines"];
  axes?: FontInfo["axes"];
  /** font units per em, cap and x height — for sizing type by its letters */
  metrics?: {
    unitsPerEm: number;
    capHeight: number;
    xHeight: number;
    ascender: number;
    descender: number;
  };
};

export type LookFont = {
  family: string;
  /** a web font the page loads (else a font of the machine that read it, or generic) */
  webfont: boolean;
  chars: number;
  share: number;
  weights: { weight: string; chars: number }[];
  sizes: { px: number; chars: number }[];
  stacks: string[];
  /** the product's own words in it, biggest first */
  samples: string[];
  files: LookFontFile[];
  /** @font-face rules declaring the family, and how many have no file here */
  declared: number;
  missingFiles: number;
};

export type LookGlyphs = {
  how: How;
  /** what was checked: "--text", the page's files */
  source: string[];
  chars: number;
  missing: { char: string; code: string }[];
  /** per face: family, weight and style (a weight lacking a character falls
   *  back to the next family, whatever another weight has) */
  byFamily: { family: string; weight: string; style: string; covered: number; lacks: string }[];
  /** faces the product declares for missing characters that are not here —
   *  missing from every file, or from the files of that face's weight */
  declaredElsewhere: {
    family: string;
    weight: string;
    style: string;
    src: string | null;
    chars: string;
  }[];
};

export type LookPackage = {
  dir: string;
  css: string;
  files: {
    file: string;
    family: string;
    weight: string;
    style: string;
    /** the film's characters it serves (the spaces it keeps besides are not counted) */
    chars: number;
    bytes: number;
    from: string;
    fromBytes: number;
    how: FontSubset["how"];
    why?: string;
  }[];
};

export type FilmLook = {
  version: 1;
  source: {
    kind: "take" | "states" | "state" | "url" | "look";
    input: string;
    url: string | null;
    title: string | null;
    /** the saved screens read (ids), or the page */
    screens: string[];
    skipped: string[];
    viewport: { width: number; height: number } | null;
  };
  roles: Record<RoleName, LookRole>;
  colours: LookColour[];
  gradients: { value: string; share: number; where: string[] }[];
  /** share of the sampled screen that is an image, video or canvas */
  imageShare: number;
  vars: { name: string; value: string; hex: string | null }[];
  fonts: LookFont[];
  /** families with @font-face rules that no visible text is set in */
  declaredFamilies: string[];
  type: {
    family: string;
    weight: string;
    sizePx: number;
    chars: number;
    sample: string;
    where: string;
  }[];
  radii: { value: string; px: number; count: number; where: string[] }[];
  shadows: { value: string; count: number; where: string[] }[];
  motion: {
    declared: CssMotion;
    used: { value: string; count: number; where: string[] }[];
    usedHow: How;
  };
  glyphs?: LookGlyphs;
  packaged?: LookPackage;
  labels: Record<string, How>;
  notes: string[];
};

export type FilmLookOptions = {
  /** a take (…/x.take, or a folder holding states/), a states/ folder, one
   *  saved screen (its folder or state.html), an http(s) URL, or a look.json
   *  written before (then only the font work is done) */
  source: string;
  /** the folder look.json, look.png and fonts/ go in (default ./look; for a
   *  look.json source, its own folder) */
  out?: string;
  /** needed unless the source is a look.json */
  chromePath?: string;
  /** only these saved screens (ids: s0, s3) */
  states?: string[];
  /** the film's words, checked against the fonts */
  text?: string;
  /** the film's page (or folder): its words read statically */
  page?: string;
  /** write the fonts the film's words need here, cut down, with fonts.css */
  fonts?: string;
  /** more font files the film uses (checked and packaged with the product's) */
  fontFiles?: string[];
  /** the page's CSS px for a URL (default 1920×1080) */
  width?: number;
  height?: number;
  /** skip look.png */
  noPicture?: boolean;
  onConsole?: (level: string, text: string) => void;
};

export type FilmLookResult = {
  look: FilmLook;
  json: string;
  png: string | null;
  css: string | null;
};

type Screen = { id: string; rel: string };
type Source =
  | { kind: "take" | "states" | "state"; root: string; screens: Screen[]; skipped: string[] }
  | { kind: "url"; url: string }
  | { kind: "look"; file: string };

const MAX_SCREENS = 12;

async function resolveSource(input: string, only?: string[]): Promise<Source> {
  const { existsSync, statSync, readdirSync, readFileSync } = await import("node:fs");
  const { basename, dirname, join, resolve } = await import("node:path");
  if (/^https?:\/\//i.test(input)) return { kind: "url", url: input };
  let p = resolve(input);
  if (!existsSync(p)) throw new Error(`film look: nothing at ${input}`);
  if (statSync(p).isFile()) {
    if (p.endsWith(".json")) return { kind: "look", file: p };
    if (/\.(mp4|mov|webm)$/i.test(p)) p = p.replace(/\.[^./]+$/, ".take");
    else if (basename(p) === "state.html") p = dirname(p);
    else throw new Error(`film look: ${input} is not a take, a saved screen, a URL or a look.json`);
  }
  if (
    existsSync(join(p, "look.json")) &&
    !existsSync(join(p, "states")) &&
    !existsSync(join(p, "state.html"))
  )
    return { kind: "look", file: join(p, "look.json") };
  const isScreen = (d: string) =>
    existsSync(join(d, "index.json")) && existsSync(join(d, "state.html"));
  if (isScreen(p))
    return {
      kind: "state",
      root: dirname(p),
      screens: [{ id: basename(p), rel: `${basename(p)}/state.html` }],
      skipped: [],
    };
  const kind = existsSync(join(p, "states")) ? "take" : "states";
  const statesDir = kind === "take" ? join(p, "states") : p;
  const found: { id: string; tMs: number; ok: boolean }[] = [];
  for (const id of existsSync(statesDir) ? readdirSync(statesDir) : []) {
    const d = join(statesDir, id);
    if (!isScreen(d)) continue;
    let tMs = 0;
    let ok = true;
    try {
      const index = JSON.parse(readFileSync(join(d, "index.json"), "utf8"));
      tMs = Number(index.tMs) || 0;
      ok = index.fidelity?.ok !== false;
    } catch {
      /* unreadable index: read it anyway */
    }
    found.push({ id, tMs, ok });
  }
  if (!found.length)
    throw new Error(
      `film look: no saved screens in ${input} (record the take with --states, or give a URL)`,
    );
  found.sort((a, b) => a.tMs - b.tMs);
  const skipped: string[] = [];
  let use = found.filter((f) => {
    if (only?.length) return only.includes(f.id);
    if (!f.ok) skipped.push(`${f.id} (its saved screen did not match the recording)`);
    return f.ok;
  });
  if (only?.length) {
    const missing = only.filter((id) => !found.some((f) => f.id === id));
    if (missing.length)
      throw new Error(`film look: no saved screen ${missing.join(", ")} in ${input}`);
  }
  if (use.length > MAX_SCREENS) {
    const step = use.length / MAX_SCREENS;
    const keep = new Set(
      Array.from({ length: MAX_SCREENS }, (_, i) => use[Math.floor(i * step)]!.id),
    );
    for (const f of use)
      if (!keep.has(f.id))
        skipped.push(`${f.id} (${MAX_SCREENS} screens are read at most, spread over the take)`);
    use = use.filter((f) => keep.has(f.id));
  }
  if (!use.length)
    throw new Error(`film look: every saved screen in ${input} was skipped: ${skipped.join("; ")}`);
  return {
    kind,
    root: statesDir,
    screens: use.map((f) => ({ id: f.id, rel: `${f.id}/state.html` })),
    skipped,
  };
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** go to `url` in the page and wait for it (and a saved screen's restore) to finish */
async function navigate(browser: import("../html/cdp").HtmlBrowser, url: string): Promise<void> {
  await browser.evaluate(`setTimeout(() => { location.href = ${JSON.stringify(url)} }, 0), true`);
  const deadline = Date.now() + 30_000;
  for (;;) {
    await sleepMs(100);
    try {
      const done = await browser.evaluate<boolean>(
        `location.href === ${JSON.stringify(url)} && document.readyState === "complete"`,
        { timeoutMs: 5000 },
      );
      if (done) return;
    } catch (e) {
      if (!/context|navigat|destroyed|Cannot find/i.test((e as Error).message)) throw e;
    }
    if (Date.now() > deadline) throw new Error(`film look: ${url} never finished loading`);
  }
}

const STATE_READY_JS = `new Promise((ok) => {
  const t0 = Date.now();
  const tick = () => document.documentElement.dataset.otReady === "1" || Date.now() - t0 > 10000 ? setTimeout(ok, 80) : setTimeout(tick, 50);
  tick();
})`;

type Fetched = { bytes: Buffer; type: string };

async function fetchBytes(url: string, ua: string): Promise<Fetched | string> {
  try {
    const r = await fetch(url, {
      headers: { "user-agent": ua },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return `HTTP ${r.status}`;
    return { bytes: Buffer.from(await r.arrayBuffer()), type: r.headers.get("content-type") ?? "" };
  } catch (e) {
    return (e as Error).message;
  }
}

/** the families a page's text is set in, and its stylesheets, read in Chrome */
async function readSource(
  src: Exclude<Source, { kind: "look" }>,
  opts: FilmLookOptions,
): Promise<{
  reads: PageRead[];
  sheets: { text: string; base: string }[];
  vars: FilmLook["vars"];
  fetch: (url: string) => Promise<Fetched | string>;
}> {
  if (!opts.chromePath) throw new Error("film look: a Chrome is needed to read the page");
  const { launchHtmlBrowser } = await import("../html/cdp");
  const { serveDirectory } = await import("../html/server");
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  let width = opts.width ?? 1920;
  let height = opts.height ?? 1080;
  let server: Awaited<ReturnType<typeof serveDirectory>> | null = null;
  const urls: string[] = [];
  if (src.kind === "url") urls.push(src.url);
  else {
    server = await serveDirectory(src.root);
    for (const s of src.screens)
      urls.push(`${server.url}/${s.rel.split("/").map(encodeURIComponent).join("/")}`);
    try {
      const index = JSON.parse(
        await readFile(join(src.root, src.screens[0]!.id, "index.json"), "utf8"),
      );
      if (index?.viewport?.w && index?.viewport?.h) ({ w: width, h: height } = index.viewport);
    } catch {
      /* a screen without an index reads at the default size */
    }
  }
  let browser: import("../html/cdp").HtmlBrowser | null = null;
  try {
    browser = await launchHtmlBrowser({
      chromePath: opts.chromePath,
      url: urls[0]!,
      width: Math.round(width),
      height: Math.round(height),
      profilePrefix: "open-take-look-",
      ...(src.kind === "url" ? { initScript: QUIET_ERRORS_JS } : {}),
      onConsole: opts.onConsole,
    });
    const reads: PageRead[] = [];
    for (let i = 0; i < urls.length; i++) {
      if (i > 0) await navigate(browser, urls[i]!);
      await browser.evaluate(
        src.kind === "url" ? "new Promise((ok) => setTimeout(ok, 1500))" : STATE_READY_JS,
        {
          timeoutMs: 20_000,
        },
      );
      reads.push(await browser.evaluate<PageRead>(`(${PAGE_READ_JS})()`, { timeoutMs: 180_000 }));
    }
    const ua = reads[0]?.ua ?? "Mozilla/5.0";
    const fetchUrl = (url: string) => fetchBytes(url, ua);
    const sheets: { text: string; base: string }[] = [];
    const seen = new Set<string>();
    for (const r of reads)
      for (const s of r.sheets) {
        if (s.text != null) {
          if (!seen.has(s.text)) sheets.push({ text: s.text, base: r.url });
          seen.add(s.text);
        } else if (s.href && !seen.has(s.href) && /^https?:/.test(s.href)) {
          seen.add(s.href);
          const got = await fetchUrl(s.href);
          if (typeof got !== "string")
            sheets.push({ text: got.bytes.toString("utf8"), base: s.href });
        }
      }
    const names = new Set<string>();
    for (const s of sheets)
      for (const d of cssDeclarations(s.text))
        if (d.property.startsWith("--") && names.size < 600) names.add(d.property);
    const resolved = names.size
      ? await browser.evaluate<[string, string, string | null][]>(
          `(${VARS_JS})(${JSON.stringify([...names])})`,
        )
      : [];
    const vars = resolved.filter(([, v]) => v).map(([name, value, hex]) => ({ name, value, hex }));
    // a saved screen's fonts are fetched while its server still runs
    const cache = new Map<string, Fetched | string>();
    const all = sheets.flatMap((s) => parseFontFaces(s.text, s.base));
    if (server)
      for (const f of all)
        if (f.src?.startsWith(server.url) && !cache.has(f.src))
          cache.set(f.src, await fetchUrl(f.src));
    return {
      reads,
      sheets,
      vars,
      fetch: async (url) => {
        if (!cache.has(url))
          cache.set(url, /^https?:/.test(url) && !server ? await fetchUrl(url) : "not saved");
        return cache.get(url)!;
      },
    };
  } finally {
    await browser?.close();
    await server?.close();
  }
}

type Where = [string, number][];
const mergeWhere = (into: Map<string, number>, w: Where) => {
  for (const [k, n] of w) into.set(k, (into.get(k) ?? 0) + n);
};
const topWhere = (m: Map<string, number>, n = 4) =>
  [...m]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
const pctText = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)} %`;
const sameHex = (a: string, b: string) =>
  a.toLowerCase().replace(/^(#[0-9a-f]{6})ff$/, "$1") ===
  b.toLowerCase().replace(/^(#[0-9a-f]{6})ff$/, "$1");

/** Everything the reads saw, merged over the screens, as colours with uses. */
function mergeReads(reads: PageRead[], vars: FilmLook["vars"]) {
  const samples = reads.reduce((s, r) => s + r.samples, 0) || 1;
  type Acc = {
    bg: number;
    bgInter: number;
    text: number;
    textInter: number;
    border: number;
    fill: number;
    grounds: Map<string, number>;
    where: Map<string, number>;
  };
  const acc = new Map<string, Acc>();
  const get = (hex: string): Acc => {
    let a = acc.get(hex);
    if (!a) {
      a = {
        bg: 0,
        bgInter: 0,
        text: 0,
        textInter: 0,
        border: 0,
        fill: 0,
        grounds: new Map(),
        where: new Map(),
      };
      acc.set(hex, a);
    }
    return a;
  };
  const gradients = new Map<string, { n: number; where: Map<string, number> }>();
  let images = 0;
  let gradientText = 0;
  for (const r of reads) {
    images += r.images;
    for (const b of r.backgrounds) {
      const a = get(b.hex);
      a.bg += b.n;
      a.bgInter += b.interactive;
      mergeWhere(a.where, b.where);
    }
    for (const t of r.texts) {
      if (!t.hex.startsWith("#")) {
        gradientText += t.chars;
        continue;
      }
      const a = get(t.hex);
      a.text += t.chars;
      a.textInter += t.interactive;
      mergeWhere(a.grounds, t.grounds);
      mergeWhere(a.where, t.where);
    }
    for (const b of r.borders) {
      const a = get(b.hex);
      a.border += b.length;
      mergeWhere(a.where, b.where);
    }
    for (const f of r.fills) {
      const a = get(f.hex);
      a.fill += f.area / reads.length;
      mergeWhere(a.where, f.where);
    }
    for (const g of r.gradients) {
      const e = gradients.get(g.value) ?? { n: 0, where: new Map() };
      e.n += g.n;
      mergeWhere(e.where, g.where);
      gradients.set(g.value, e);
    }
  }
  const totalChars = [...acc.values()].reduce((s, a) => s + a.text, 0) || 1;
  const colours: LookColour[] = [];
  for (const [hex, a] of acc) {
    const c = parseCssColor(hex)!;
    const uses = a.bg + a.text;
    colours.push({
      hex,
      background: round(a.bg / samples, 4),
      text: Math.round(a.text),
      border: Math.round(a.border),
      fill: round(a.fill, 4),
      interactive: uses ? round((a.bgInter + a.textInter) / uses, 2) : 0,
      on: [...a.grounds]
        .sort((x, y) => y[1] - x[1])
        .slice(0, 4)
        .map(([ground, chars]) => ({
          ground,
          chars: Math.round(chars),
          contrast: ground.startsWith("#") ? round(contrastRatio(hex, ground), 2) : null,
        })),
      where: topWhere(a.where),
      // a framework's internal variables after the product's own names
      vars: vars
        .filter((v) => v.hex && sameHex(v.hex, hex))
        .map((v) => v.name)
        .sort(
          (a, b) =>
            Number(a.startsWith("--tw-")) - Number(b.startsWith("--tw-")) || a.length - b.length,
        )
        .slice(0, 6),
      oklch: oklch(c).map((v, i) => round(v, i === 2 ? 1 : 3)) as [number, number, number],
    });
  }
  const weightOf = (c: LookColour) =>
    c.background * 100 + (c.text / totalChars) * 30 + c.border / 2000 + c.fill * 100;
  colours.sort((a, b) => weightOf(b) - weightOf(a));
  return {
    colours,
    totalChars,
    gradientText,
    imageShare: round(images / samples, 4),
    gradients: [...gradients]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 8)
      .map(([value, e]) => ({ value, share: round(e.n / samples, 4), where: topWhere(e.where) })),
  };
}

/** An estimate of which colour plays which part, from where and how much each is used. */
export function estimateRoles(
  colours: readonly LookColour[],
  totalChars: number,
): Record<RoleName, LookRole> {
  const none = (why: string): LookRole => ({
    hex: null,
    how: "not detected",
    why,
    where: [],
    vars: [],
  });
  const role = (c: LookColour, why: string, alternatives?: LookRole["alternatives"]): LookRole => ({
    hex: c.hex,
    how: "estimated",
    why,
    where: c.where,
    vars: c.vars,
    ...(alternatives?.length ? { alternatives } : {}),
  });
  const rgb = (c: LookColour) => parseCssColor(c.hex)!;
  const far = (a: LookColour, b: LookColour | undefined) => !b || okDistance(rgb(a), rgb(b)) > 0.02;
  const byBg = colours.filter((c) => c.background > 0).sort((a, b) => b.background - a.background);
  const bg = byBg[0];
  const surfaces = byBg.filter((c) => c !== bg && c.background >= 0.01 && far(c, bg));
  const byText = colours.filter((c) => c.text > 0).sort((a, b) => b.text - a.text);
  const contrastOf = (c: LookColour) => c.on[0]?.contrast ?? 0;
  // of the colours most text is set in (at least half the most-used one's
  // characters), the one standing out most from its ground
  const text = byText
    .filter((c) => c.text >= 0.5 * (byText[0]?.text ?? 0))
    .sort((a, b) => contrastOf(b) - contrastOf(a))[0];
  const mainGround = text?.on[0]?.ground;
  const textContrast = text ? contrastOf(text) : 21;
  const muted = byText.find(
    (c) =>
      c !== text &&
      c.text >= 0.02 * totalChars &&
      c.oklch[1] < 0.06 &&
      c.on[0]?.ground === mainGround &&
      contrastOf(c) < textContrast &&
      far(c, text),
  );
  const accentScore = (c: LookColour) => {
    const chroma = c.oklch[1];
    if (chroma < 0.06) return 0;
    const use =
      c.background * 1000 + c.fill * 1000 + (c.text / (totalChars || 1)) * 100 + c.border / 500;
    return chroma * chroma * (1 + 4 * c.interactive) * Math.log1p(use);
  };
  const accents = colours
    .filter((c) => c !== bg && accentScore(c) > 0)
    .sort((a, b) => accentScore(b) - accentScore(a));
  const accent = accents[0];
  const onAccent =
    accent &&
    colours
      .filter((c) => c.on.some((o) => o.ground === accent.hex))
      .sort(
        (a, b) =>
          (b.on.find((o) => o.ground === accent.hex)?.chars ?? 0) -
          (a.on.find((o) => o.ground === accent.hex)?.chars ?? 0),
      )[0];
  const border = colours.filter((c) => c.border > 0).sort((a, b) => b.border - a.border)[0];
  const useText = (c: LookColour) => {
    const parts: string[] = [];
    if (c.background) parts.push(`background on ${pctText(c.background)} of the screen`);
    if (c.text) parts.push(`${c.text} characters`);
    if (c.fill) parts.push(`icons/shapes on ${pctText(c.fill)}`);
    if (c.border) parts.push(`${c.border} px of border`);
    if (c.interactive) parts.push(`${pctText(c.interactive)} of it on links/buttons/inputs`);
    return parts.join(", ");
  };
  return {
    bg: bg
      ? role(bg, `the background covering the most sampled area (${pctText(bg.background)})`)
      : none("no painted background found"),
    surface: surfaces[0]
      ? role(
          surfaces[0],
          `the next background by area (${pctText(surfaces[0].background)}), unlike bg`,
          surfaces.slice(1, 4).map((c) => ({ hex: c.hex, why: useText(c) })),
        )
      : none("no second background covering ≥ 1 % of the screen"),
    text: text
      ? role(
          text,
          `of the colours most text is set in, the one with the most contrast on its ground (${text.text} of ${Math.round(totalChars)} characters, ${textContrast}:1 on ${mainGround})`,
        )
      : none("no visible text"),
    muted: muted
      ? role(
          muted,
          `a near-neutral text colour on the same ground with less contrast (${contrastOf(muted)}:1), ${muted.text} characters`,
        )
      : none("no second near-neutral text colour on the main text's ground with less contrast"),
    accent: accent
      ? role(
          accent,
          `the most chromatic colour weighed by use, links and buttons counting more: ${useText(accent)}`,
          accents.slice(1, 4).map((c) => ({ hex: c.hex, why: useText(c) })),
        )
      : none("no chromatic colour (OKLCH chroma ≥ 0.06) in use"),
    onAccent:
      accent && onAccent
        ? role(
            onAccent,
            `the text set most on the accent (${onAccent.on.find((o) => o.ground === accent.hex)?.chars} characters)`,
          )
        : none(accent ? "no text sits on the accent" : "no accent"),
    border: border
      ? role(border, `the border colour drawn longest (${border.border} px)`)
      : none("no visible borders"),
  };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "font";

function sniffExt(bytes: Buffer, fallback: string | null): string {
  const sig = bytes.toString("latin1", 0, 4);
  if (sig === "wOF2") return "woff2";
  if (sig === "wOFF") return "woff";
  if (sig === "OTTO") return "otf";
  if (sig === "ttcf") return "ttc";
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x00010000) return "ttf";
  return fallback ?? "bin";
}

/** one face as the CSS declares it and as document.fonts reports it: the
 *  same key (weights by number, the whole of Unicode when no range is given) */
const facesKey = (f: { family: string; weight: string; style: string; unicodeRange: string }) => {
  const weight = normWeight(f.weight);
  const ranges = parseUnicodeRange(f.unicodeRange || "U+0-10FFFF");
  const cps = ranges.flatMap(([a, b]) =>
    b - a > 4096 ? [a, b] : Array.from({ length: b - a + 1 }, (_, i) => a + i),
  );
  return `${f.family.toLowerCase()}|${weight}|${f.style.trim() || "normal"}|${unicodeRangeOf(cps)}`;
};

const normWeight = (w: string) =>
  w
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\bnormal\b/g, "400")
    .replace(/\bbold\b/g, "700");
/** one face of a family as a key: its files together serve its characters */
const faceGroup = (family: string, weight: string, style: string) =>
  `${family.toLowerCase()}|${normWeight(weight)}|${style.trim() || "normal"}`;

/** cps the face is used for: its file's cmap within its unicode-range */
function faceChars(info: FontInfo, unicodeRange: string): Set<number> {
  const ranges = parseUnicodeRange(unicodeRange);
  const out = new Set<number>();
  for (const cp of info.cmap.keys()) if (inRanges(cp, ranges)) out.add(cp);
  return out;
}

export async function filmLook(opts: FilmLookOptions): Promise<FilmLookResult> {
  const { mkdir, readFile, writeFile, rm } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { basename, dirname, join, relative, resolve } = await import("node:path");
  const src = await resolveSource(opts.source, opts.states);
  const outDir = resolve(opts.out ?? (src.kind === "look" ? dirname(src.file) : "look"));
  await mkdir(join(outDir, "fonts"), { recursive: true });
  const notes: string[] = [];
  let look: FilmLook;
  /** every font file in reach, by family: parsed, with the face it serves */
  const files: {
    family: string;
    face: LookFontFile;
    info: FontInfo | null;
    path: string | null;
  }[] = [];
  /** declared faces with no file here (for missing characters) */
  let unfetched: (CssFontFace & { fetchable: boolean })[] = [];
  let fetchFont: ((url: string) => Promise<Fetched | string>) | null = null;

  const savedAs = new Map<string, string>(); // content hash → file name: one copy of a file serving several faces
  const keepFile = async (
    family: string,
    face: LookFontFile,
    bytes: Buffer,
    ext: string | null,
  ) => {
    const sha = createHash("sha1").update(bytes).digest("hex").slice(0, 8);
    const name =
      savedAs.get(sha) ??
      `${slug(family)}-${slug(face.weight)}${face.style !== "normal" ? `-${slug(face.style)}` : ""}-${sha}.${sniffExt(bytes, ext)}`;
    savedAs.set(sha, name);
    const path = join(outDir, "fonts", name);
    if (!existsSync(path)) await writeFile(path, bytes);
    face.file = `fonts/${name}`;
    face.bytes = bytes.length;
    let info: FontInfo | null = null;
    try {
      info = parseFont(bytes);
      face.name = info.fullName || info.family;
      face.glyphs = info.glyphs;
      face.chars = faceChars(info, face.unicodeRange).size;
      face.outlines = info.outlines;
      if (info.axes.length) face.axes = info.axes;
      face.metrics = {
        unitsPerEm: info.unitsPerEm,
        capHeight: info.capHeight,
        xHeight: info.xHeight,
        ascender: info.ascender,
        descender: info.descender,
      };
    } catch (e) {
      face.status = `unreadable: ${(e as Error).message}`;
    }
    files.push({ family, face, info, path });
  };

  if (src.kind === "look") {
    look = JSON.parse(await readFile(src.file, "utf8")) as FilmLook;
    if (look?.version !== 1) throw new Error(`film look: ${src.file} is not a look.json`);
    for (const f of look.fonts)
      for (const face of f.files) {
        if (!face.file) continue;
        const path = join(dirname(src.file), face.file);
        if (!existsSync(path)) continue;
        let info: FontInfo | null = null;
        try {
          info = parseFont(await readFile(path));
        } catch {
          /* listed but unreadable: left out of the check */
        }
        files.push({ family: f.family, face, info, path });
      }
  } else {
    const read = await readSource(src, opts);
    fetchFont = read.fetch;
    const { reads, sheets, vars } = read;
    const merged = mergeReads(reads, vars);
    const first = reads[0]!;
    // fonts: the families text is set in, merged over the screens
    type FamAcc = {
      webfont: boolean;
      chars: number;
      weights: Map<string, number>;
      sizes: Map<number, number>;
      stacks: Set<string>;
    };
    const fams = new Map<string, FamAcc>();
    for (const r of reads)
      for (const f of r.families) {
        const a = fams.get(f.family) ?? {
          webfont: f.webfont,
          chars: 0,
          weights: new Map(),
          sizes: new Map(),
          stacks: new Set(),
        };
        a.chars += f.chars;
        for (const [w, n] of f.weights) a.weights.set(w, (a.weights.get(w) ?? 0) + n);
        for (const [s, n] of f.sizes) a.sizes.set(s, (a.sizes.get(s) ?? 0) + n);
        for (const s of f.stacks) a.stacks.add(s);
        fams.set(f.family, a);
      }
    const totalFamChars = [...fams.values()].reduce((s, a) => s + a.chars, 0) || 1;
    const cssFaces = sheets.flatMap((s) => parseFontFaces(s.text, s.base));
    const loaded = new Set(
      reads.flatMap((r) => r.faces.filter((f) => f.status === "loaded").map(facesKey)),
    );
    const samples = reads.flatMap((r) => r.samples_);
    const fonts: LookFont[] = [];
    for (const [family, a] of [...fams].sort((x, y) => y[1].chars - x[1].chars)) {
      const declared = cssFaces.filter((f) => f.family.toLowerCase() === family.toLowerCase());
      const lf: LookFont = {
        family,
        webfont: a.webfont,
        chars: Math.round(a.chars),
        share: round(a.chars / totalFamChars, 3),
        weights: [...a.weights]
          .sort((x, y) => y[1] - x[1])
          .map(([weight, n]) => ({ weight, chars: Math.round(n) })),
        sizes: [...a.sizes]
          .sort((x, y) => y[1] - x[1])
          .slice(0, 12)
          .map(([px, n]) => ({ px, chars: Math.round(n) })),
        stacks: [...a.stacks].slice(0, 4),
        samples: [...new Set(samples.filter((s) => s.family === family).map((s) => s.text))].slice(
          0,
          8,
        ),
        files: [],
        declared: declared.length,
        missingFiles: 0,
      };
      const seenFace = new Set<string>();
      for (const f of declared) {
        const key = facesKey(f);
        if (seenFace.has(key)) continue;
        seenFace.add(key);
        const face: LookFontFile = {
          file: null,
          source: f.src,
          weight: f.weight,
          style: f.style,
          unicodeRange: f.unicodeRange,
          status: "not saved",
        };
        const want = src.kind === "url" ? loaded.has(key) : !!f.src && f.src !== "about:blank";
        if (want && f.src && f.src !== "about:blank") {
          const got = await read.fetch(f.src);
          if (typeof got !== "string") {
            face.status = src.kind === "url" ? "downloaded" : "saved";
            await keepFile(
              family,
              face,
              got.bytes,
              f.format?.replace(/^truetype$/, "ttf").replace(/^opentype$/, "otf") ?? null,
            );
            lf.files.push(face);
            continue;
          }
          face.status = `${src.kind === "url" ? "not downloaded" : "not saved"}: ${got}`;
        } else if (src.kind === "url") face.status = "not downloaded";
        unfetched.push({
          ...f,
          fetchable: src.kind === "url" && !!f.src && /^https?:/.test(f.src),
        });
        lf.missingFiles++;
      }
      fonts.push(lf);
    }
    const usedFamilies = new Set(fonts.map((f) => f.family.toLowerCase()));
    const declaredFamilies = [...new Set(cssFaces.map((f) => f.family))].filter(
      (f) => !usedFamilies.has(f.toLowerCase()),
    );
    // type scale
    const type = new Map<string, FilmLook["type"][number]>();
    for (const r of reads)
      for (const t of r.type) {
        const k = `${t.family}|${t.weight}|${t.size}`;
        const e = type.get(k) ?? {
          family: t.family,
          weight: t.weight,
          sizePx: t.size,
          chars: 0,
          sample: t.sample,
          where: t.where,
        };
        e.chars += t.chars;
        type.set(k, e);
      }
    const radii = new Map<string, { px: number; count: number; where: Map<string, number> }>();
    const shadows = new Map<string, { count: number; where: Map<string, number> }>();
    const used = new Map<string, { count: number; where: Map<string, number> }>();
    for (const r of reads) {
      for (const x of r.radii) {
        const e = radii.get(x.value) ?? { px: x.px, count: 0, where: new Map() };
        e.count += x.n;
        mergeWhere(e.where, x.where);
        radii.set(x.value, e);
      }
      for (const [list, map] of [
        [r.shadows, shadows],
        [r.transitions, used],
      ] as const)
        for (const x of list) {
          const e = map.get(x.value) ?? { count: 0, where: new Map() };
          e.count += x.n;
          mergeWhere(e.where, x.where);
          map.set(x.value, e);
        }
    }
    const frozen = reads.every((r) => r.frozen);
    const roles = estimateRoles(merged.colours, merged.totalChars);
    if (merged.gradientText)
      notes.push(
        `${Math.round(merged.gradientText)} characters are set in gradient-filled text (background-clip: text) — see gradients`,
      );
    if (merged.imageShare > 0.25)
      notes.push(
        `${pctText(merged.imageShare)} of the sampled screen is images, video or canvas — their colours are not read`,
      );
    const declared = cssMotion(sheets.map((s) => s.text));
    look = {
      version: 1,
      source: {
        kind: src.kind,
        input: opts.source,
        url:
          src.kind === "url"
            ? src.url
            : ((await readIndexUrl(src.root, src.screens[0]!.id)) ?? null),
        title: first.title || null,
        screens: src.kind === "url" ? [src.url] : src.screens.map((s) => s.id),
        skipped: src.kind === "url" ? [] : src.skipped,
        viewport: { width: first.width, height: first.height },
      },
      roles,
      colours: merged.colours.slice(0, 48),
      gradients: merged.gradients,
      imageShare: merged.imageShare,
      vars: vars.slice(0, 200),
      fonts,
      declaredFamilies,
      type: [...type.values()]
        .map((t) => ({ ...t, chars: Math.round(t.chars) }))
        .sort((a, b) => b.sizePx - a.sizePx || b.chars - a.chars)
        .slice(0, 24),
      radii: [...radii]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 12)
        .map(([value, e]) => ({
          value,
          px: round(e.px, 1),
          count: e.count,
          where: topWhere(e.where, 3),
        })),
      shadows: [...shadows]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 8)
        .map(([value, e]) => ({ value, count: e.count, where: topWhere(e.where, 3) })),
      motion: {
        declared: {
          durations: declared.durations.slice(0, 16),
          easings: declared.easings.slice(0, 12),
          keyframes: declared.keyframes.slice(0, 24),
        },
        used: frozen
          ? []
          : [...used]
              .sort((a, b) => b[1].count - a[1].count)
              .slice(0, 16)
              .map(([value, e]) => ({ value, count: e.count, where: topWhere(e.where, 3) })),
        usedHow: frozen ? "not detected" : used.size ? "measured" : "not detected",
      },
      labels: {
        colours: merged.colours.length ? "measured" : "not detected",
        roles: "estimated",
        fonts: fonts.length ? "measured" : "not detected",
        type: type.size ? "measured" : "not detected",
        radii: radii.size ? "measured" : "not detected",
        shadows: shadows.size ? "measured" : "not detected",
        motion: declared.durations.length || declared.easings.length ? "measured" : "not detected",
      },
      notes,
    };
    if (frozen)
      notes.push(
        "a saved screen holds its motion still, so no transition is read as playing on it — motion.declared is what the CSS says; read a URL for what plays",
      );
    notes.push(
      "motion timings are the product interface's own, as its CSS declares them: one possible source for the film's motion, nothing more",
    );
  }

  // --- the film's words against the fonts ---
  const extra: string[] = [];
  for (const f of opts.fontFiles ?? []) {
    const path = resolve(f);
    const bytes = await readFile(path).catch(() => null);
    if (!bytes) throw new Error(`film look: no font file at ${f}`);
    let info: FontInfo;
    try {
      info = parseFont(bytes);
    } catch (e) {
      throw new Error(`film look: ${f}: ${(e as Error).message}`);
    }
    // a variable font serves its whole weight axis, under its family name
    // without the default instance's weight ("Noto Sans TC Thin" when the
    // file gives no typographic family)
    const wght = info.axes.find((a) => a.tag === "wght");
    const family = (wght ? info.family.replace(WEIGHT_WORD, "") : info.family) || basename(path);
    files.push({
      family,
      face: {
        file: null,
        source: path,
        weight: wght ? `${wght.min} ${wght.max}` : String(info.weight),
        style: info.italic ? "italic" : "normal",
        unicodeRange: "",
        status: "given",
      },
      info,
      path,
    });
    extra.push(family);
  }
  let filmWords = opts.text ?? "";
  const sourcesChecked: string[] = [];
  if (opts.text) sourcesChecked.push("--text");
  if (opts.page) {
    const t = await filmText(opts.page);
    filmWords += `\n${t.text}`;
    sourcesChecked.push(
      ...t.files.map((f) => {
        const rel = relative(process.cwd(), f);
        return rel && !rel.startsWith("..") ? rel : f;
      }),
    );
  }
  if (opts.fonts && !filmWords.trim())
    throw new Error(
      "film look: --fonts packs the fonts for the film's words — give --text or --page",
    );
  let css: string | null = null;
  if (filmWords.trim()) {
    const cps = glyphChars(filmWords);
    // coverage per face (family, weight, style): a browser setting a weight
    // whose files lack a character falls back to the next family in the
    // stack, not to another weight of the same family that has it
    const coverageOf = () => {
      const byFace = new Map<
        string,
        { family: string; weight: string; style: string; set: Set<number> }
      >();
      for (const f of files) {
        if (!f.info) continue;
        const k = faceGroup(f.family, f.face.weight, f.face.style);
        const e = byFace.get(k) ?? {
          family: f.family,
          weight: normWeight(f.face.weight),
          style: f.face.style.trim() || "normal",
          set: new Set<number>(),
        };
        for (const cp of faceChars(f.info, f.face.unicodeRange)) e.set.add(cp);
        byFace.set(k, e);
      }
      return byFace;
    };
    let byFace = coverageOf();
    const covered = (cp: number) => [...byFace.values()].some((e) => e.set.has(cp));
    /** the film's characters a declared face would serve that no file here does —
     *  none at all, or not at the weight and style of a face that has files */
    const gapsOf = (f: CssFontFace) => {
      const ranges = parseUnicodeRange(f.unicodeRange);
      const own = byFace.get(faceGroup(f.family, f.weight, f.style))?.set;
      return cps.filter((cp) => inRanges(cp, ranges) && (!covered(cp) || (own && !own.has(cp))));
    };
    // a live product's faces for the missing characters are fetched now —
    // again while a face fetched gives its weight characters to check
    for (let pass = 0; pass < 4 && fetchFont; pass++) {
      let added = false;
      for (const f of unfetched) {
        if (!f.fetchable || !f.src) continue;
        if (!gapsOf(f).length) continue;
        f.fetchable = false;
        const got = await fetchFont(f.src);
        if (typeof got === "string") continue;
        const lf = look.fonts.find((x) => x.family.toLowerCase() === f.family.toLowerCase());
        if (!lf) continue;
        const face: LookFontFile = {
          file: null,
          source: f.src,
          weight: f.weight,
          style: f.style,
          unicodeRange: f.unicodeRange,
          status: "downloaded (for the film's words)",
        };
        await keepFile(lf.family, face, got.bytes, null);
        lf.files.push(face);
        lf.missingFiles = Math.max(0, lf.missingFiles - 1);
        byFace = coverageOf();
        added = true;
      }
      if (!added) break;
    }
    unfetched = unfetched.filter(
      (f) => f.fetchable || !f.src || !files.some((x) => x.face.source === f.src),
    );
    const missing = cps.filter((cp) => !covered(cp));
    const elsewhere = new Map<
      string,
      { family: string; weight: string; style: string; src: string | null; chars: Set<number> }
    >();
    for (const f of unfetched) {
      const hit = gapsOf(f);
      if (!hit.length) continue;
      const k = `${f.family}|${f.weight}|${f.style}`;
      const e = elsewhere.get(k) ?? {
        family: f.family,
        weight: f.weight,
        style: f.style,
        src: f.src,
        chars: new Set<number>(),
      };
      for (const cp of hit) e.chars.add(cp);
      elsewhere.set(k, e);
    }
    look.glyphs = {
      how: "measured",
      source: sourcesChecked,
      chars: cps.length,
      missing: missing.map((cp) => ({ char: String.fromCodePoint(cp), code: codeLabel(cp) })),
      byFamily: [...byFace.values()].map(({ family, weight, style, set }) => {
        const lacks = cps.filter((cp) => !set.has(cp));
        return {
          family,
          weight,
          style,
          covered: cps.length - lacks.length,
          lacks: lacks.map((cp) => String.fromCodePoint(cp)).join(""),
        };
      }),
      declaredElsewhere: [...elsewhere.values()].map((e) => ({
        family: e.family,
        weight: e.weight,
        style: e.style,
        src: e.src,
        chars: [...e.chars].map((cp) => String.fromCodePoint(cp)).join(""),
      })),
    };
    look.labels.glyphs = "measured";
    if (opts.fonts) {
      const pack = await packageFonts({
        dir: resolve(opts.fonts),
        chars: cps,
        files: files
          .filter((f) => f.info && f.path)
          .map((f) => ({
            family: f.family,
            weight: f.face.weight,
            style: f.face.style,
            unicodeRange: f.face.unicodeRange,
            path: f.path!,
          })),
      });
      look.packaged = pack;
      css = pack.css;
    }
  }

  const json = join(outDir, "look.json");
  await writeFile(json, `${JSON.stringify(look, null, 2)}\n`);
  await writeFile(join(outDir, "look.css"), lookCss(look));
  let png: string | null = null;
  if (!opts.noPicture && opts.chromePath) {
    png = join(outDir, "look.png");
    await drawSpecimen(look, outDir, png, opts.chromePath, filmWords);
  }
  if (src.kind !== "look" && !look.fonts.some((f) => f.files.length))
    await rm(join(outDir, "fonts"), { recursive: true, force: true }).catch(() => {});
  return { look, json, png, css };
}

const WEIGHT_WORD =
  /\s+(?:Thin|Hairline|(?:Extra|Ultra)[ -]?Light|Light|Regular|Book|Medium|(?:Semi|Demi)[ -]?Bold|(?:Extra|Ultra)[ -]?Bold|Bold|Black|Heavy)$/i;

async function readIndexUrl(root: string, id: string): Promise<string | null> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  try {
    return (JSON.parse(await readFile(join(root, id, "index.json"), "utf8")).url as string) ?? null;
  } catch {
    return null;
  }
}

const SPACES = [0x20, 0xa0, 0x2002, 0x2003, 0x2009, 0x200a, 0x202f, 0x3000];

/** Font files cut down to the characters each serves of `chars`, written to
 *  `dir` with a fonts.css of @font-face rules (each unicode-range the
 *  characters the file kept). A file serving none of them is left out. */
export async function packageFonts(opts: {
  dir: string;
  chars: Iterable<number>;
  files: { family: string; weight: string; style: string; unicodeRange?: string; path: string }[];
}): Promise<LookPackage> {
  const { mkdir, readFile, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  await mkdir(opts.dir, { recursive: true });
  const want = new Set(opts.chars);
  const rules: string[] = [];
  const out: LookPackage["files"] = [];
  // a file serving several faces (a variable font declared per weight) is cut once
  const written = new Map<string, string>();
  for (const f of opts.files) {
    const bytes = await readFile(f.path);
    const info = parseFont(bytes);
    const served = faceChars(info, f.unicodeRange ?? "");
    const cps = [...served].filter((cp) => want.has(cp));
    if (!cps.length) continue;
    const asked = cps.length;
    // the spaces it has go along: a space from another font would set the
    // words at another width
    for (const sp of SPACES) if (served.has(sp) && !want.has(sp)) cps.push(sp);
    const sub = subsetFont(bytes, cps);
    const ext = sub.how === "subset" ? "woff" : sniffExt(bytes, "bin");
    const sha = createHash("sha1").update(sub.data).digest("hex").slice(0, 8);
    const name =
      written.get(sha) ??
      `${slug(f.family)}-${slug(f.weight)}${f.style !== "normal" ? `-${slug(f.style)}` : ""}-${sha}.${ext}`;
    if (!written.has(sha)) await writeFile(join(opts.dir, name), sub.data);
    written.set(sha, name);
    const format = { woff: "woff", woff2: "woff2", ttf: "truetype", otf: "opentype" }[ext] ?? ext;
    rules.push(
      `@font-face {\n  font-family: ${JSON.stringify(f.family)};\n  font-weight: ${f.weight};\n  font-style: ${f.style};\n  font-display: block;\n  src: url(${JSON.stringify(name)}) format(${JSON.stringify(format)});\n  unicode-range: ${unicodeRangeOf(cps)};\n}`,
    );
    out.push({
      file: name,
      family: f.family,
      weight: f.weight,
      style: f.style,
      chars: asked,
      bytes: sub.data.length,
      from: f.path,
      fromBytes: bytes.length,
      how: sub.how,
      ...(sub.why ? { why: sub.why } : {}),
    });
  }
  const css = join(opts.dir, "fonts.css");
  await writeFile(
    css,
    `/* the film's fonts, cut down to its words by \`open-take film look\` — link this file and use the families by name */\n${rules.join("\n")}\n`,
  );
  return { dir: opts.dir, css, files: out };
}

/** @font-face rules for every font file in the look, and the roles as custom properties */
function lookCss(look: FilmLook): string {
  const L: string[] = [
    "/* the product's look, read by `open-take film look` — its own fonts and colours; use any of it or none */",
  ];
  for (const f of look.fonts)
    for (const face of f.files) {
      if (!face.file) continue;
      const ext = face.file.split(".").pop()!;
      const format = { woff: "woff", woff2: "woff2", ttf: "truetype", otf: "opentype" }[ext] ?? ext;
      L.push(
        `@font-face { font-family: ${JSON.stringify(f.family)}; font-weight: ${face.weight}; font-style: ${face.style}; src: url(${JSON.stringify(face.file)}) format(${JSON.stringify(format)});${face.unicodeRange ? ` unicode-range: ${face.unicodeRange};` : ""} }`,
      );
    }
  L.push(":root {");
  for (const [name, r] of Object.entries(look.roles))
    if (r.hex)
      L.push(
        `  --look-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${r.hex}; /* ${r.how}: ${r.why.replace(/\*\//g, "")} */`,
      );
  const fam = (f: LookFont) => `${JSON.stringify(f.family)}`;
  const webfonts = look.fonts.filter((f) => f.webfont);
  if (webfonts.length) L.push(`  --look-font: ${webfonts.map(fam).join(", ")};`);
  L.push("}");
  return `${L.join("\n")}\n`;
}

// --- the specimen -------------------------------------------------------------

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** black or white, whichever reads better on `hex` */
const inkOn = (hex: string) =>
  contrastRatio("#000000", hex) >= contrastRatio("#ffffff", hex) ? "#000" : "#fff";

/** the film's own lines worth trying in the product's fonts: distinct, longest first */
function filmLines(words: string): string[] {
  const lines = words
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(
      (l) =>
        l.length >= 2 &&
        l.length <= 48 &&
        /[\p{L}\p{N}]/u.test(l) &&
        !/^[\w.-]+\.(js|css|png|mp4|wav|json|html)$/i.test(l),
    );
  return [...new Set(lines)].sort((a, b) => b.length - a.length).slice(0, 3);
}

/** look.png: the colours as swatches, each family set at film sizes with the
 *  product's own words (and the film's, when given), radii, shadows, easings —
 *  on a 1920×1080 frame, in the product's own font files. */
async function drawSpecimen(
  look: FilmLook,
  outDir: string,
  png: string,
  chromePath: string,
  words: string,
) {
  const { writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { launchHtmlBrowser } = await import("../html/cdp");
  const { serveDirectory } = await import("../html/server");
  const bg = look.roles.bg.hex ?? "#ffffff";
  const ink = look.roles.text.hex ?? inkOn(bg);
  const note = look.roles.muted.hex ?? ink;
  const faces = look.fonts
    .flatMap((f) =>
      f.files
        .filter((x) => x.file)
        .map(
          (x) =>
            `@font-face{font-family:${JSON.stringify(f.family)};font-weight:${x.weight};font-style:${x.style};src:url(${JSON.stringify(x.file)});${x.unicodeRange ? `unicode-range:${x.unicodeRange};` : ""}}`,
        ),
    )
    .join("\n");
  const roleTiles = (Object.entries(look.roles) as [RoleName, LookRole][])
    .map(([name, r]) =>
      r.hex
        ? `<div class="tile" style="background:${r.hex};color:${inkOn(r.hex)}"><b>${name}</b> ${esc(r.hex)}<small>${esc(r.vars[0] ?? r.where[0] ?? "")}</small></div>`
        : `<div class="tile none"><b>${name}</b> not detected</div>`,
    )
    .join("");
  const chips = look.colours
    .slice(0, 24)
    .map((c) => `<span class="chip" style="background:${c.hex}" title="${esc(c.hex)}"></span>`)
    .join("");
  const fams = look.fonts.filter((f) => f.files.length || !f.webfont).slice(0, 3);
  const lines = filmLines(words);
  const typeRows = fams
    .map((f, i) => {
      const heavy = f.weights.map((w) => Number(w.weight)).filter(Number.isFinite);
      const big = look.type.find((t) => t.family === f.family);
      const sample = esc((big?.sample ?? f.samples[0] ?? f.family).slice(0, 28));
      const second = esc((f.samples.find((s) => s !== big?.sample) ?? "").slice(0, 40));
      const sizes = f.sizes.map((s) => s.px);
      const meta = `${esc(f.family)} · ${f.chars} chars (${pctText(f.share)}) · weights ${[...new Set(heavy)].sort((a, b) => a - b).join(" ")} · ${sizes.length ? `${Math.min(...sizes)}–${Math.max(...sizes)} px on the page` : ""} · ${f.webfont ? `${new Set(f.files.map((x) => x.file)).size} file(s) here${f.missingFiles ? `, ${f.missingFiles} declared face(s) without a file` : ""}` : "not a web font"}`;
      const fam = `${JSON.stringify(f.family).replace(/"/g, "&quot;")}, sans-serif`;
      return `<div class="fam"><div class="meta">${meta}</div>
<div style="font-family:${fam};font-weight:${big?.weight ?? 700};font-size:${i === 0 ? 92 : 64}px;line-height:1.15" class="line">${sample}</div>
${second ? `<div style="font-family:${fam};font-weight:${f.weights[0]?.weight ?? 400};font-size:36px" class="line">${second}</div>` : ""}
${i === 0 && lines.length ? `<div class="meta">the film's words</div>${lines.map((l) => `<div style="font-family:${fam};font-weight:${big?.weight ?? 700};font-size:56px" class="line">${esc(l)}</div>`).join("")}` : ""}</div>`;
    })
    .join("");
  const surface = look.roles.surface.hex ?? look.roles.accent.hex ?? "#888";
  const border = look.roles.border.hex ?? "transparent";
  const radii = look.radii
    .slice(0, 6)
    .map(
      (r) =>
        `<div class="rad"><div style="background:${surface};border:1px solid ${border};border-radius:${r.value === "circle" ? "50%" : r.value === "pill" ? "999px" : r.value};${r.value === "circle" ? "width:72px;" : ""}"></div><small>${esc(r.value)} ×${r.count}</small></div>`,
    )
    .join("");
  const shadows = look.shadows
    .slice(0, 4)
    .map(
      (s) =>
        `<div class="shadow" style="box-shadow:${esc(s.value)};background:${bg}"><small>×${s.count}</small></div>`,
    )
    .join("");
  const curves = look.motion.declared.easings
    .filter((e) => /^cubic-bezier|^ease|^linear$/.test(e.value))
    .slice(0, 4)
    .map((e) => {
      const named: Record<string, number[]> = {
        ease: [0.25, 0.1, 0.25, 1],
        "ease-in": [0.42, 0, 1, 1],
        "ease-out": [0, 0, 0.58, 1],
        "ease-in-out": [0.42, 0, 0.58, 1],
        linear: [0, 0, 1, 1],
      };
      const p =
        named[e.value] ??
        (/cubic-bezier\(([^)]*)\)/.exec(e.value)?.[1] ?? "").split(",").map(Number);
      if (p.length !== 4 || !p.every(Number.isFinite)) return "";
      const [x1, y1, x2, y2] = p as [number, number, number, number];
      return `<div class="ease"><svg viewBox="-0.1 -0.4 1.2 1.8" width="64" height="80"><path d="M0 1 C${x1} ${1 - y1} ${x2} ${1 - y2} 1 0" fill="none" stroke="${look.roles.accent.hex ?? ink}" stroke-width="0.04"/><rect x="0" y="0" width="1" height="1" fill="none" stroke="${note}" stroke-width="0.01"/></svg><small>${esc(e.value)} ×${e.count}</small></div>`;
    })
    .join("");
  const durs = look.motion.declared.durations
    .slice(0, 6)
    .map((d) => `${d.ms} ms ×${d.count}`)
    .join(" · ");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${faces}
html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:${bg};color:${ink}}
body{font:15px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;grid-template-columns:760px minmax(0,1fr);gap:40px;padding:44px 56px;box-sizing:border-box}
body>div{min-width:0}
h2{font:600 13px system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:${note};margin:0 0 12px}
.tiles{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.tile{height:74px;border-radius:10px;padding:10px 14px;box-sizing:border-box;font:16px system-ui,sans-serif;box-shadow:inset 0 0 0 1px rgba(127,127,127,.25)}
.tile b{display:block;font-size:13px;letter-spacing:.06em;text-transform:uppercase;opacity:.8}
.tile small{display:block;opacity:.7;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile.none{border:1px dashed ${note};box-shadow:none;color:${note}}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 22px}.chip{width:36px;height:36px;border-radius:6px;box-shadow:inset 0 0 0 1px rgba(127,127,127,.3)}
.row{display:flex;gap:16px;align-items:flex-end;margin-bottom:20px;flex-wrap:nowrap;overflow:hidden}
.rad div{width:96px;height:56px}.rad small,.ease small,.shadow small{display:block;margin-top:6px;color:${note};font-size:12px;max-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.shadow{width:130px;height:64px;border-radius:10px;padding:8px;box-sizing:border-box;margin:0 6px}
.fam{margin-bottom:26px}.meta{color:${note};font-size:14px;margin:6px 0}.line{white-space:nowrap;overflow:hidden;text-overflow:clip}
.src{position:absolute;right:56px;bottom:16px;color:${note};font-size:12px;max-width:1000px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style></head><body>
<div><h2>colour roles (estimated)</h2><div class="tiles">${roleTiles}</div>
<h2 style="margin-top:18px">every colour, most used first</h2><div class="chips">${chips}</div>
${radii ? `<h2>radii, most used first</h2><div class="row">${radii}</div>` : ""}
${shadows ? `<h2>shadows</h2><div class="row" style="overflow:visible">${shadows}</div>` : ""}
${curves || durs ? `<h2>motion declared in its CSS</h2><div class="row">${curves}</div><div class="meta">${esc(durs)}</div>` : ""}
</div>
<div><h2>type — the product's own words in its own files, at film size</h2>${typeRows || '<div class="meta">no text read</div>'}</div>
<script>for (const el of document.querySelectorAll(".line")) { let s = parseFloat(getComputedStyle(el).fontSize); while (el.scrollWidth > el.clientWidth + 1 && s > 16) { s -= 2; el.style.fontSize = s + "px"; } }</script>
<div class="src">${esc(look.source.title ?? "")} — ${esc(look.source.url ?? look.source.input)} · ${esc(look.source.screens.join(" "))}</div>
</body></html>`;
  const page = join(outDir, `.look-specimen-${process.pid}.html`);
  await writeFile(page, html);
  const server = await serveDirectory(outDir);
  let browser: import("../html/cdp").HtmlBrowser | null = null;
  try {
    browser = await launchHtmlBrowser({
      chromePath,
      url: `${server.url}/${encodeURIComponent(`.look-specimen-${process.pid}.html`)}`,
      width: 1920,
      height: 1080,
      profilePrefix: "open-take-look-",
    });
    // the lines are fitted once the fonts are in, then drawn
    await browser.evaluate(
      `document.fonts.ready.then(() => { for (const el of document.querySelectorAll(".line")) { let s = parseFloat(getComputedStyle(el).fontSize); while (el.scrollWidth > el.clientWidth + 1 && s > 16) { s -= 2; el.style.fontSize = s + "px"; } } return new Promise((ok) => setTimeout(ok, 100)); })`,
    );
    await writeFile(png, await browser.screenshot());
  } finally {
    await browser?.close();
    await server.close();
    await rm(page, { force: true });
  }
}

// --- the report -----------------------------------------------------------------

export function formatFilmLook(look: FilmLook): string {
  const L: string[] = [];
  const s = look.source;
  L.push(`# film look — ${s.title ?? s.input}`);
  L.push("");
  L.push(
    `${s.url ?? s.input}; ${s.screens.length} screen(s) read${s.viewport ? ` at ${s.viewport.width}×${s.viewport.height}` : ""}${s.skipped.length ? `; skipped ${s.skipped.join(", ")}` : ""}. Each line says how it was found: measured, estimated, not detected. These are the product's own values — what to use is the film's choice.`,
  );
  L.push("");
  L.push("## Colour roles");
  L.push("[estimated] from where and how much each colour is used:");
  for (const [name, r] of Object.entries(look.roles) as [RoleName, LookRole][]) {
    L.push(
      r.hex
        ? `  ${name.padEnd(9)} ${r.hex.padEnd(10)} ${r.why}${r.vars.length ? `; var ${r.vars.join(", ")}` : ""}${r.where.length ? `; on ${r.where.slice(0, 2).join(", ")}` : ""}`
        : `  ${name.padEnd(9)} [not detected] ${r.why}`,
    );
    for (const a of r.alternatives ?? []) L.push(`  ${"".padEnd(9)} or ${a.hex}: ${a.why}`);
  }
  L.push("");
  L.push(`## Colours (${look.colours.length})`);
  if (!look.colours.length) L.push("[not detected] no painted colour");
  else
    L.push(
      "[measured] background = share of the sampled screen; text = characters (on ground, contrast); border = px of edge",
    );
  for (const c of look.colours.slice(0, 14)) {
    const parts: string[] = [];
    if (c.background) parts.push(`background ${pctText(c.background)}`);
    if (c.text)
      parts.push(
        `text ${c.text}${c.on[0] ? ` (on ${c.on[0].ground}${c.on[0].contrast != null ? `, ${c.on[0].contrast}:1` : ""})` : ""}`,
      );
    if (c.fill) parts.push(`icons ${pctText(c.fill)}`);
    if (c.border) parts.push(`border ${c.border} px`);
    L.push(
      `  ${c.hex.padEnd(10)} ${parts.join(", ")}${c.vars.length ? ` — ${c.vars.slice(0, 2).join(", ")}` : ""} — ${c.where.slice(0, 2).join(", ")}`,
    );
  }
  if (look.gradients.length)
    L.push(
      `[measured] gradients: ${look.gradients
        .slice(0, 3)
        .map((g) => `${pctText(g.share)} ${g.value.slice(0, 80)}`)
        .join(" | ")}`,
    );
  if (look.imageShare)
    L.push(
      `[measured] images, video, canvas: ${pctText(look.imageShare)} of the sampled screen (not read for colour)`,
    );
  L.push("");
  L.push("## Fonts");
  if (!look.fonts.length) L.push("[not detected] no visible text");
  for (const f of look.fonts) {
    L.push(
      `[measured] ${f.family}${f.webfont ? "" : " (not a web font: the reading machine's own, or generic)"} — ${f.chars} chars (${pctText(f.share)}), weights ${f.weights.map((w) => `${w.weight}×${w.chars}`).join(" ")}, sizes ${f.sizes
        .slice(0, 6)
        .map((z) => `${z.px}px`)
        .join(" ")}`,
    );
    if (f.webfont) {
      // one line per file, however many faces it serves
      const files = [
        ...new Map(
          f.files.map((x) => [
            x.file,
            `${x.file}${x.axes?.length ? ` ${x.axes.map((a) => `${a.tag} ${a.min}–${a.max}`).join(" ")}` : ""}`,
          ]),
        ).values(),
      ];
      const none = f.missingFiles
        ? `; ${f.missingFiles} declared face(s) have no file (${look.source.kind === "url" ? "not loaded by the page" : "the screen never loaded them"})`
        : "";
      L.push(
        `           files: ${files.length} here (${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""})${none}`,
      );
    }
  }
  if (look.declaredFamilies.length)
    L.push(`declared but not seen on screen: ${look.declaredFamilies.join(", ")}`);
  if (look.type.length) {
    L.push("[measured] type on the page (family weight size: characters — sample):");
    for (const t of look.type.slice(0, 8))
      L.push(`  ${t.family} ${t.weight} ${t.sizePx}px: ${t.chars} — ${t.sample.slice(0, 40)}`);
  }
  L.push("");
  L.push("## Shape");
  L.push(
    look.radii.length
      ? `[measured] radii: ${look.radii.map((r) => `${r.value}×${r.count}`).join(" ")}`
      : "[not detected] no rounded corners",
  );
  L.push(
    look.shadows.length
      ? `[measured] shadows: ${look.shadows
          .slice(0, 3)
          .map((x) => `${x.value} ×${x.count}`)
          .join(" | ")}`
      : "[not detected] no shadows",
  );
  L.push("");
  L.push("## Motion in its CSS");
  const m = look.motion;
  L.push(
    m.declared.durations.length || m.declared.easings.length
      ? `[measured] declared (not necessarily played): durations ${m.declared.durations
          .slice(0, 8)
          .map((d) => `${d.ms}ms×${d.count}`)
          .join(" ")}; easings ${m.declared.easings
          .slice(0, 5)
          .map((e) => `${e.value}×${e.count}`)
          .join(
            " ",
          )}${m.declared.keyframes.length ? `; keyframes ${m.declared.keyframes.slice(0, 6).join(" ")}` : ""}`
      : "[not detected] no transition or animation timing in its CSS",
  );
  L.push(
    m.used.length
      ? `[measured] on elements on screen: ${m.used
          .slice(0, 4)
          .map((u) => `${u.value} ×${u.count}`)
          .join(" | ")}`
      : `[not detected] no transition set on an element on screen${look.source.kind === "url" ? "" : " (a saved screen holds motion still)"}`,
  );
  if (look.glyphs) {
    const g = look.glyphs;
    L.push("");
    L.push("## The film's words in these fonts");
    L.push(
      `[measured] ${g.chars} distinct characters from ${g.source.slice(0, 4).join(", ")}${g.source.length > 4 ? ", …" : ""}`,
    );
    L.push(
      g.missing.length
        ? `[measured] in no font file here (${g.missing.length}): ${g.missing
            .slice(0, 60)
            .map((x) => x.char)
            .join(
              "",
            )}${g.missing.length > 60 ? "…" : ""} — they would fall back to whatever font the rendering machine has`
        : "[measured] every character is in a font file here",
    );
    // a family's weight named when it has several: each weight is checked on its own
    const faces = new Map<string, number>();
    for (const f of g.byFamily) faces.set(f.family, (faces.get(f.family) ?? 0) + 1);
    // weights of a family lacking the same characters share a line
    const same = new Map<string, { f: (typeof g.byFamily)[number]; weights: string[] }>();
    for (const f of g.byFamily) {
      const k = `${f.family}|${f.lacks}`;
      const e = same.get(k) ?? { f, weights: [] };
      e.weights.push(`${f.weight}${f.style !== "normal" ? ` ${f.style}` : ""}`);
      same.set(k, e);
    }
    for (const { f, weights } of same.values())
      L.push(
        `  ${f.family}${(faces.get(f.family) ?? 0) > 1 ? ` ${weights.join(", ")}` : ""}: ${f.covered}/${g.chars}${f.lacks ? ` — lacks ${[...f.lacks].slice(0, 40).join("")}${[...f.lacks].length > 40 ? "…" : ""}` : ""}`,
      );
    const thin = g.byFamily.filter(
      (f) =>
        (faces.get(f.family) ?? 0) > 1 &&
        g.byFamily.some(
          (o) => o !== f && o.family === f.family && [...f.lacks].some((c) => !o.lacks.includes(c)),
        ),
    );
    if (thin.length)
      L.push(
        `  (set at a weight whose files lack a character, the browser falls back to the next family in the stack — another weight of ${[...new Set(thin.map((f) => f.family))].join(", ")} having it does not help)`,
      );
    // one line per family and characters, its weights together
    const grouped = new Map<
      string,
      { family: string; chars: string; weights: string[]; online: boolean }
    >();
    for (const e of g.declaredElsewhere) {
      const k = `${e.family}|${e.chars}`;
      const x = grouped.get(k) ?? { family: e.family, chars: e.chars, weights: [], online: false };
      x.weights.push(`${e.weight}${e.style !== "normal" ? ` ${e.style}` : ""}`);
      x.online ||= !!e.src && /^https?:/.test(e.src);
      grouped.set(k, x);
    }
    for (const e of grouped.values())
      L.push(
        `  the product declares ${e.family} (${e.weights.join(", ")}) for ${[...e.chars].slice(0, 30).join("")} — ${e.online ? "its file was not fetched" : "in a file not saved with the screen; reading the product's URL fetches it"}`,
      );
  }
  if (look.packaged) {
    L.push("");
    L.push(`## Packed for the film: ${look.packaged.css}`);
    for (const f of look.packaged.files)
      L.push(
        `  ${f.file}: ${f.family} ${f.weight}, ${f.chars} chars, ${f.bytes} bytes (from ${f.fromBytes})${f.how === "copied" ? ` — ${f.why}` : ""}`,
      );
  }
  if (look.notes.length) {
    L.push("");
    for (const n of look.notes) L.push(`note: ${n}`);
  }
  return L.join("\n");
}
