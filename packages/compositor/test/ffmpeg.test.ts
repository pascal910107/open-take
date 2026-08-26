// parseEncoders/ffmpegHasEncoder — the ffmpeg side of the VP9 retry: the
// decode-guard fallback only runs when the resolved ffmpeg can actually
// encode libvpx-vp9.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ffmpegHasEncoder, parseEncoders } from "../src/ffmpeg.js";

const ENCODERS_EXCERPT = `Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V..... libvpx-vp9           libvpx VP9 (codec vp9)
 A....D aac                  AAC (Advanced Audio Coding)
`;

test("parseEncoders: finds real encoder rows", () => {
  assert.equal(parseEncoders(ENCODERS_EXCERPT, "libx264"), true);
  assert.equal(parseEncoders(ENCODERS_EXCERPT, "libvpx-vp9"), true);
});

test("parseEncoders: absent encoder is false", () => {
  assert.equal(parseEncoders(ENCODERS_EXCERPT, "libx265"), false);
});

test("parseEncoders: a name inside another row's description does not count", () => {
  // "vp9" and "h264" appear in descriptions/names above, but no ROW is named that
  assert.equal(parseEncoders(ENCODERS_EXCERPT, "vp9"), false);
  assert.equal(parseEncoders(ENCODERS_EXCERPT, "h264"), false);
});

// Asserts a property of THIS machine's resolved ffmpeg (system builds can
// lack libx264) — kept because the product's H.264 arm depends on it equally,
// so a red here points at a real environmental gap, not a code bug.
test("ffmpegHasEncoder: the resolved ffmpeg has libx264", async () => {
  assert.equal(await ffmpegHasEncoder("libx264"), true);
});

test("ffmpegHasEncoder: a made-up encoder is false", async () => {
  assert.equal(await ffmpegHasEncoder("definitely-not-an-encoder"), false);
});
