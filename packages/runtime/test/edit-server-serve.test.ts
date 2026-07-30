// How the bridge SERVES the take's two big files. Both are videos, and both used
// to leave the Content-Type map empty-handed and go out as
// application/octet-stream: the kept capture.mp4 that the editor's <video>
// decodes, and the rendered .mp4 behind Download. Chrome sniffs and plays one
// anyway — which is exactly why this survived unnoticed — but `open-take edit`
// opens the user's DEFAULT browser, and a stricter one is entitled to refuse a
// media type it was told is a byte blob.
//
// HEAD is here for the same reason: the two media routes matched `method ===
// "GET"` only, so a HEAD probe fell through to the /api/ catch-all and got a
// 404 for a file that plainly exists.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { planComposition } from "@open-take/compositor";
import { startEditServer } from "../src/edit-server.js";
import { resolveTakePaths } from "../src/take.js";

const log = {
  video: { width: 1280, height: 720 },
  viewport: { w: 1280, h: 720 },
  events: [{ tMs: 800, kind: "click", point: { x: 300, y: 240 }, label: "a" }],
  tEndMs: 2400,
} as Parameters<typeof planComposition>[0];

let dir: string;
let server: Awaited<ReturnType<typeof startEditServer>>;
let url: string;

// Distinct sizes so a wrong route cannot pass by accident.
const CAPTURE_BYTES = "capture-bytes-0123456789";
const OUTPUT_BYTES = "rendered-output-bytes";

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-serve-"));
  const take = await resolveTakePaths(join(dir, "demo.mp4"));
  await mkdir(take.dir, { recursive: true });
  await writeFile(take.compositionPath, JSON.stringify(planComposition(log), null, 2));
  await writeFile(take.captureLogPath, JSON.stringify(log));
  await writeFile(take.capturePath, CAPTURE_BYTES);
  await writeFile(take.mp4Path, OUTPUT_BYTES);
  server = await startEditServer({ takePath: take.mp4Path, port: 0, open: false });
  url = server.url;
});

after(async () => {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

test("the kept capture is served as video/mp4, not octet-stream", async () => {
  const res = await fetch(`${url}api/take/video`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "video/mp4");
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  assert.equal(await res.text(), CAPTURE_BYTES);
});

test("the rendered mp4 is served as video/mp4 too", async () => {
  const res = await fetch(`${url}api/take/output`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "video/mp4");
  assert.equal(await res.text(), OUTPUT_BYTES);
});

test("HEAD on a media route answers 200 with the headers and no body", async () => {
  for (const path of ["api/take/video", "api/take/output"]) {
    const res = await fetch(`${url}${path}`, { method: "HEAD" });
    assert.equal(res.status, 200, `${path} should not 404 a HEAD`);
    assert.equal(res.headers.get("content-type"), "video/mp4", path);
    assert.equal(res.headers.get("accept-ranges"), "bytes", path);
    assert.ok(Number(res.headers.get("content-length")) > 0, path);
    assert.equal(await res.text(), "", `${path} HEAD must carry no body`);
  }
});

test("range requests still work, and still carry the media type", async () => {
  const res = await fetch(`${url}api/take/video`, { headers: { Range: "bytes=0-5" } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-type"), "video/mp4");
  assert.equal(res.headers.get("content-range"), `bytes 0-5/${CAPTURE_BYTES.length}`);
  assert.equal(await res.text(), CAPTURE_BYTES.slice(0, 6));
});

test("an unsatisfiable range is still a 416", async () => {
  const res = await fetch(`${url}api/take/video`, { headers: { Range: "bytes=9999-" } });
  assert.equal(res.status, 416);
});
