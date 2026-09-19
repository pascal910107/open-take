// The screencast's JPEG frames reach ffmpeg inside a Matroska stream written
// here, one cluster per frame with an explicit millisecond timecode.
//
// Why not a concat list: the concat demuxer opens each JPEG through image2,
// whose clock ticks at 1/25 s, and it rounds every file's start time onto that
// clock — frames at 0/17/50/62 ms come out 0/0/40/80 ms, i.e. the 25 Hz judder
// 6978155 removed. The `option framerate 1000` directive that lifted the clock
// only exists in FFmpeg ≥ 5.0; the bundled @ffmpeg-installer build (4.4 on
// macOS, 2018/2019 snapshots on Linux and Windows) and Ubuntu 22.04's 4.4.2
// die on it ("unknown keyword 'option'"), so every zero-config install
// rendered nothing. Matroska carries the timestamp on each block, so every
// ffmpeg version reads exactly the timing Chrome reported, and the decoder is
// the same mjpeg decoder image2 would have reached (yuvj420p, full range, 601).
//
// Only what libavformat needs is written: an EBML header, a Segment of unknown
// size (so nothing has to be patched after the fact and the stream can go
// straight down a pipe), Info with a 1 ms timecode scale, one MJPEG track, and
// clusters. No Cues, no SeekHead — the reader only ever plays it forward.

import { readFile } from "node:fs/promises";

/** A frame and the moment (ms from the capture's t0) the video shows it. */
export type TimedFrame = { file: string; tMs: number };

const ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagLacing: 0x9c,
  CodecID: 0x86,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
} as const;

/** Element IDs are written with their length marker bits included, so the
 *  constant's own big-endian bytes are the encoding. */
function idBytes(id: number): Buffer {
  const bytes: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from(bytes);
}

/** EBML variable-size integer: a width-w encoding carries 7w bits and the
 *  all-ones pattern of each width is reserved for "size unknown". */
function sizeBytes(n: number): Buffer {
  for (let width = 1; width <= 8; width++) {
    if (n > 2 ** (7 * width) - 2) continue;
    const out = Buffer.alloc(width);
    let v = BigInt(n) | (1n << BigInt(7 * width));
    for (let i = width - 1; i >= 0; i--) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return out;
  }
  throw new Error(`matroska: element of ${n} bytes exceeds the EBML size range`);
}

const UNKNOWN_SIZE = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

const element = (id: number, payload: Buffer): Buffer =>
  Buffer.concat([idBytes(id), sizeBytes(payload.length), payload]);

function uint(id: number, n: number): Buffer {
  if (!Number.isInteger(n) || n < 0) throw new Error(`matroska: ${n} is not an unsigned integer`);
  const bytes: number[] = [];
  let v = BigInt(n);
  do {
    bytes.unshift(Number(v & 0xffn));
    v >>= 8n;
  } while (v > 0n);
  return element(id, Buffer.from(bytes));
}

const utf8 = (id: number, s: string): Buffer => element(id, Buffer.from(s, "utf8"));

function float64(id: number, x: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(x);
  return element(id, b);
}

/** Pixel size from a JPEG's frame header (any SOF marker: baseline,
 *  progressive, lossless…), read past APPn/COM/DQT segments by their lengths. */
export function jpegDimensions(jpeg: Buffer): { width: number; height: number } {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error("jpegDimensions: not a JPEG (no SOI marker)");
  }
  let i = 2;
  while (i + 4 <= jpeg.length) {
    if (jpeg[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = jpeg[i + 1]!;
    // 0xFF fill bytes, and the markers that carry no length: RSTn, SOI, TEM.
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 > jpeg.length) break;
      return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7) };
    }
    // Scan data or end of image before any frame header: nothing to find.
    if (marker === 0xda || marker === 0xd9) break;
    i += 2 + jpeg.readUInt16BE(i + 2);
  }
  throw new Error("jpegDimensions: no SOF marker before scan data");
}

/** Everything before the first cluster. `durationMs` is advisory (players and
 *  ffprobe report it); the frames themselves carry the timing. */
export function matroskaHead(width: number, height: number, durationMs: number): Buffer {
  const header = element(
    ID.EBML,
    Buffer.concat([
      uint(ID.EBMLVersion, 1),
      uint(ID.EBMLReadVersion, 1),
      uint(ID.EBMLMaxIDLength, 4),
      uint(ID.EBMLMaxSizeLength, 8),
      utf8(ID.DocType, "matroska"),
      uint(ID.DocTypeVersion, 4),
      uint(ID.DocTypeReadVersion, 2),
    ]),
  );
  const info = element(
    ID.Info,
    Buffer.concat([
      uint(ID.TimecodeScale, 1_000_000), // 1 ms, so cluster timecodes are whole milliseconds
      float64(ID.Duration, durationMs),
      utf8(ID.MuxingApp, "open-take"),
      utf8(ID.WritingApp, "open-take"),
    ]),
  );
  const tracks = element(
    ID.Tracks,
    element(
      ID.TrackEntry,
      Buffer.concat([
        uint(ID.TrackNumber, 1),
        uint(ID.TrackUID, 1),
        uint(ID.TrackType, 1),
        uint(ID.FlagLacing, 0),
        utf8(ID.CodecID, "V_MJPEG"),
        element(
          ID.Video,
          Buffer.concat([uint(ID.PixelWidth, width), uint(ID.PixelHeight, height)]),
        ),
      ]),
    ),
  );
  return Buffer.concat([header, idBytes(ID.Segment), UNKNOWN_SIZE, info, tracks]);
}

/** One frame: a cluster stamped with its absolute time holding a single
 *  keyframe SimpleBlock (track 1, relative timecode 0) around the raw JPEG. */
export function matroskaCluster(tMs: number, jpeg: Buffer): Buffer {
  const block = element(
    ID.SimpleBlock,
    Buffer.concat([Buffer.from([0x81, 0x00, 0x00, 0x80]), jpeg]),
  );
  return element(ID.Cluster, Buffer.concat([uint(ID.Timecode, tMs), block]));
}

/** The whole stream, chunk by chunk, so a minute of Retina frames never sits
 *  in memory or on disk twice. Frames must be in non-decreasing tMs order;
 *  a file repeated back to back is read once.
 *
 *  The track's pixel size comes from the first frame whose header parses.
 *  ffmpeg takes the size from each JPEG anyway, so one truncated frame (a
 *  write cut short) must not fail the whole encode here when the decoder
 *  would have skipped it; only a stream with no readable header at all is an
 *  error. */
export async function* mjpegMatroska(frames: TimedFrame[]): AsyncGenerator<Buffer> {
  if (frames.length === 0) throw new Error("mjpegMatroska: no frames");
  const jpegs = new Map<string, Buffer>();
  let size: { width: number; height: number } | undefined;
  for (const { file } of frames) {
    if (jpegs.has(file)) continue;
    const jpeg = await readFile(file);
    jpegs.set(file, jpeg);
    try {
      size = jpegDimensions(jpeg);
      break;
    } catch {
      // keep looking
    }
  }
  if (!size) throw new Error("mjpegMatroska: no frame has a readable JPEG header");
  yield matroskaHead(size.width, size.height, frames[frames.length - 1]!.tMs);
  let file = "";
  let jpeg: Buffer = Buffer.alloc(0);
  for (const frame of frames) {
    if (frame.file !== file) {
      file = frame.file;
      jpeg = jpegs.get(file) ?? (await readFile(file));
      jpegs.delete(file);
    }
    yield matroskaCluster(frame.tMs, jpeg);
  }
}
