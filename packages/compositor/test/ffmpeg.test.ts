// parseEncoders/ffmpegHasEncoder — the ffmpeg side of the VP9 retry: the
// decode-guard fallback only runs when the resolved ffmpeg can actually
// encode libvpx-vp9.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  FFMPEG_FLOOR,
  ffmpegHasEncoder,
  managedDir,
  managedPlatform,
  meetsFloor,
  parseEncoders,
  parseFfmpegVersion,
  resolveFfmpeg,
  resolveFfprobe,
  resolveManagedFfmpeg,
  resolveManagedFfprobe,
} from "../src/ffmpeg.js";

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

test("parseFfmpegVersion: release numbers from every banner shape; snapshots are unversioned", () => {
  assert.deepEqual(parseFfmpegVersion("ffmpeg version 8.1 Copyright (c) 2000-2026"), [8, 1]);
  assert.deepEqual(parseFfmpegVersion("ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright"), [4, 4]);
  assert.deepEqual(parseFfmpegVersion("ffmpeg version n4.4.1 Copyright"), [4, 4]);
  assert.deepEqual(parseFfmpegVersion("ffprobe version 6.0 Copyright (c) 2007-2023"), [6, 0]);
  assert.deepEqual(
    parseFfmpegVersion("ffmpeg version 6.1.1-essentials_build-www.gyan.dev"),
    [6, 1],
  );
  // the 2018 @ffmpeg-installer linux build, and gyan's git builds
  assert.equal(parseFfmpegVersion("ffmpeg version N-47683-g0e8eb07980 Copyright"), null);
  assert.equal(parseFfmpegVersion("ffmpeg version 2024-05-02-git-71e929c-full_build"), null);
  assert.equal(parseFfmpegVersion("not ffmpeg at all"), null);
});

test("meetsFloor: the managed builds' oldest version is the line", () => {
  assert.equal(meetsFloor([FFMPEG_FLOOR[0], FFMPEG_FLOOR[1]]), true);
  assert.equal(meetsFloor([FFMPEG_FLOOR[0] + 2, 0]), true);
  assert.equal(meetsFloor([FFMPEG_FLOOR[0] - 1, 9]), false, "one major below, any minor");
  assert.equal(meetsFloor([4, 4]), false, "the ffmpeg 0.5.0/0.5.1 shipped is below the line");
  assert.equal(meetsFloor(null), false, "an unversioned snapshot is not trusted");
});

test("managedPlatform: every Node platform/arch pair maps to a published build or to null", () => {
  assert.equal(managedPlatform("darwin", "arm64"), "darwin-arm64");
  assert.equal(managedPlatform("linux", "x64"), "linux-x64");
  assert.equal(managedPlatform("win32", "x64"), "win32-x64");
  assert.equal(
    managedPlatform("win32", "arm64"),
    "win32-x64",
    "Windows on ARM runs x64 under emulation",
  );
  assert.equal(managedPlatform("freebsd", "x64"), null);
  assert.ok(managedPlatform(), "this machine has a build");
});

test("a download whose bytes do not match the pinned sha256 is refused and leaves nothing behind", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ffmpeg-managed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const body = gzipSync(Buffer.from("#!/bin/sh\necho 'ffmpeg version 9.9 not really'\n"));
  const fetchImpl = (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-length": String(body.length) },
    })) as unknown as typeof fetch;
  const lines: string[] = [];
  await assert.rejects(
    resolveManagedFfmpeg({ cacheDir: dir, fetchImpl, log: (l) => lines.push(l) }),
    /sha256 .* is not the pinned/,
  );
  assert.deepEqual(readdirSync(dir), [], "no executable and no .part file remain");
  assert.ok(
    lines[0]?.startsWith("open-take: downloading ffmpeg"),
    "the user was told a download started",
  );
});

test("an HTTP failure is reported as such", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ffmpeg-managed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fetchImpl = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(
    resolveManagedFfmpeg({ cacheDir: dir, fetchImpl, log: () => {} }),
    /HTTP 404/,
  );
});

test("the managed ffmpeg and ffprobe are fetched once into ~/.open-take and run (network)", async () => {
  // The real assets, into the real cache — one download per machine, then
  // reused by every test and every take, exactly like Chrome for Testing.
  const ffmpeg = await resolveManagedFfmpeg();
  const ffprobe = await resolveManagedFfprobe();
  assert.ok(ffmpeg.startsWith(managedDir()) && existsSync(ffmpeg));
  assert.ok(ffprobe.startsWith(managedDir()) && existsSync(ffprobe));
  for (const bin of [ffmpeg, ffprobe]) {
    const r = spawnSync(bin, ["-version"], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.ok(meetsFloor(parseFfmpegVersion(r.stdout)), `${bin}: ${r.stdout.split("\n")[0]}`);
  }
  // the second resolve is instant and identical
  assert.equal(await resolveManagedFfmpeg(), ffmpeg);
});

test("resolveFfmpeg/resolveFfprobe hand back something that runs and clears the floor", async () => {
  for (const bin of [await resolveFfmpeg(), await resolveFfprobe()]) {
    const r = spawnSync(bin, ["-version"], { encoding: "utf8" });
    assert.equal(r.status, 0, bin);
    assert.ok(meetsFloor(parseFfmpegVersion(r.stdout)), `${bin}: ${r.stdout.split("\n")[0]}`);
  }
});
