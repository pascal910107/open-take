// The Chrome-driving half of the HTML seek renderer: a static server, a
// headless Chrome per worker, `__ready` once, `__seek` + screenshot per frame.
// The page here is the smallest one that honours the contract — its
// background is a grey level derived from `atS` — so every written frame can
// be decoded by ffmpeg and checked for the level `__seek` set, in order.
// The Chrome tests skip when no Chrome for Testing is on this machine
// (OPEN_TAKE_E2E_CHROME, the managed ~/.open-take/browsers, or the legacy
// agent-browser install the runtime's resolver also accepts).

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { resolveFfmpeg } from "../src/ffmpeg";
import {
  defaultHtmlWorkers,
  frameFileName,
  renderHtmlFrames,
  sliceFrames,
} from "../src/html/render";
import { fileFor, parseRange, serveDirectory } from "../src/html/server";
import { findChrome } from "./fixtures/find-chrome";

const exec = promisify(execFile);

// --- a Chrome for Testing, or skip -------------------------------------------

const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";

// --- the page, the levels, the decode ----------------------------------------

/** `__ready` resolves at once; `__seek(atS, frameS)` paints the body the grey
 *  level round(atS·40) and checks frameS is the one the test derives from atS
 *  (frameS = atS / 12), so both arguments are proven to arrive. */
const page = (seekPrologue = "") => `<!doctype html>
<html><head><meta charset="utf-8">
<style>html,body{margin:0;width:100%;height:100%;background:#fff}</style></head>
<body><script>
window.__ready = Promise.resolve();
window.__seek = (atS, frameS) => {
  ${seekPrologue}
  if (Math.abs(frameS - atS / 12) > 1e-9)
    throw new Error("frameS " + frameS + " does not belong to atS " + atS);
  const g = Math.round(atS * 40);
  document.body.style.background = "rgb(" + g + "," + g + "," + g + ")";
  return Promise.resolve();
};
</script></body></html>`;

const times = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ atS: i * 0.5, frameS: i / 24 }));
const level = (atS: number) => Math.round(atS * 40);

/** every pixel of a PNG as 8-bit grey, through the repo's ffmpeg */
async function decodeGray(ffmpeg: string, file: string): Promise<Buffer> {
  const { stdout } = await exec(
    ffmpeg,
    ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
    { encoding: "buffer", maxBuffer: 1 << 26 },
  );
  return stdout;
}

/** pid → command line of every process (Chrome and its helpers alike) running
 *  on one of our throwaway profiles: every one of them carries the profile
 *  path in its arguments */
/** this file's own Chrome profiles: other tests and renders may run Chrome at the same time */
const PREFIX = `open-take-html-test-${process.pid}-`;

async function htmlChromeProcesses(): Promise<Map<number, string>> {
  const procs = new Map<number, string>();
  if (process.platform === "win32") return procs;
  const { stdout } = await exec("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 1 << 24,
  });
  for (const line of stdout.split("\n")) {
    if (!line.includes(PREFIX)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (Number.isFinite(pid)) procs.set(pid, line.trim().slice(0, 160));
  }
  return procs;
}

const htmlProfileDirs = async (): Promise<Set<string>> =>
  new Set((await readdir(tmpdir())).filter((n) => n.startsWith(PREFIX)));

/** nothing this render started survives it: no Chrome (helpers included) and no profile dir */
async function assertNothingLeft(before: { pids: Map<number, string>; dirs: Set<string> }) {
  const deadline = Date.now() + 5000;
  let procs = await htmlChromeProcesses();
  const survivors = () => [...procs].filter(([pid]) => !before.pids.has(pid));
  while (Date.now() < deadline && survivors().length > 0) {
    await new Promise((r) => setTimeout(r, 100));
    procs = await htmlChromeProcesses();
  }
  assert.deepEqual(
    survivors().map(([pid, cmd]) => `${pid} ${cmd}`),
    [],
    "every Chrome the render launched has exited, helpers included",
  );
  const dirs = await htmlProfileDirs();
  assert.deepEqual(
    [...dirs].filter((d) => !before.dirs.has(d)),
    [],
    "every throwaway profile is removed",
  );
}

const snapshot = async () => ({
  pids: await htmlChromeProcesses(),
  dirs: await htmlProfileDirs(),
});

// --- the renderer -----------------------------------------------------------------

test("12 frames over 2 workers land in order, each at the grey level __seek set", {
  skip,
  timeout: 120_000,
}, async () => {
  const before = await snapshot();
  const dir = await mkdtemp(join(tmpdir(), "html-render-test-"));
  try {
    await writeFile(join(dir, "index.html"), page());
    const srv = await serveDirectory(dir);
    try {
      const outDir = join(dir, "frames");
      const frames = times(12);
      const progress: number[] = [];
      const stats = await renderHtmlFrames({
        profilePrefix: PREFIX,
        url: `${srv.url}/index.html`,
        chromePath: chrome!,
        width: 64,
        height: 36,
        times: frames,
        outDir,
        workers: 2,
        onProgress: (done, total) => {
          assert.equal(total, 12);
          progress.push(done);
        },
      });
      assert.equal(stats.frames, 12);
      assert.equal(stats.workers, 2);
      assert.ok(stats.wallMs > 0 && stats.msPerShot === stats.wallMs / 12);
      assert.deepEqual(
        [...progress].sort((a, b) => a - b),
        frames.map((_, i) => i + 1),
        "progress reports every frame once",
      );

      const files = (await readdir(outDir)).sort();
      assert.deepEqual(
        files,
        frames.map((_, i) => frameFileName(i)),
        "one %07d.png per frame, numbered by position",
      );
      const ffmpeg = await resolveFfmpeg();
      for (const [i, t] of frames.entries()) {
        const file = join(outDir, files[i]!);
        const png = await readFile(file);
        assert.equal(png.readUInt32BE(16), 64, `${files[i]} is 64 wide`);
        assert.equal(png.readUInt32BE(20), 36, `${files[i]} is 36 high`);
        const gray = await decodeGray(ffmpeg, file);
        assert.equal(gray.length, 64 * 36, `${files[i]} decodes to 64×36 grey`);
        const expected = level(t.atS);
        for (const px of [0, (gray.length >> 1) + 32, gray.length - 1])
          assert.ok(
            Math.abs(gray[px]! - expected) <= 1,
            `${files[i]} pixel ${px}: level ${gray[px]} for atS ${t.atS} (expected ${expected})`,
          );
      }
    } finally {
      await srv.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await assertNothingLeft(before);
});

test("a __seek that throws fails the render naming the frame, and no Chrome survives it", {
  skip,
  timeout: 120_000,
}, async () => {
  const before = await snapshot();
  const dir = await mkdtemp(join(tmpdir(), "html-render-test-"));
  try {
    // frame 5 (atS 2.5) is in the first worker's slice [0, 6)
    await writeFile(
      join(dir, "index.html"),
      page(`if (atS === 2.5) throw new Error("boom at " + atS);`),
    );
    const srv = await serveDirectory(dir);
    try {
      await assert.rejects(
        renderHtmlFrames({
          profilePrefix: PREFIX,
          url: `${srv.url}/index.html`,
          chromePath: chrome!,
          width: 64,
          height: 36,
          times: times(12),
          outDir: join(dir, "frames"),
          workers: 2,
        }),
        (e: Error) => {
          assert.match(e.message, /frame 5 \(atS 2\.5/, e.message);
          assert.match(e.message, /boom at 2\.5/, e.message);
          return true;
        },
      );
    } finally {
      await srv.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await assertNothingLeft(before);
});

test("a __seek that never settles times out, naming the frame", {
  skip,
  timeout: 120_000,
}, async () => {
  const before = await snapshot();
  const dir = await mkdtemp(join(tmpdir(), "html-render-test-"));
  try {
    await writeFile(
      join(dir, "index.html"),
      page(`if (atS === 1.5) return new Promise(() => {});`),
    );
    const srv = await serveDirectory(dir);
    try {
      const t0 = Date.now();
      await assert.rejects(
        renderHtmlFrames({
          profilePrefix: PREFIX,
          url: `${srv.url}/index.html`,
          chromePath: chrome!,
          width: 64,
          height: 36,
          times: times(4),
          outDir: join(dir, "frames"),
          workers: 1,
          timeoutMs: 1500,
        }),
        (e: Error) => {
          assert.match(e.message, /frame 3 \(atS 1\.5/, e.message);
          assert.match(e.message, /timed out after 1500 ms/, e.message);
          return true;
        },
      );
      assert.ok(Date.now() - t0 < 30_000, "the hang is cut at the timeout, not the test's");
    } finally {
      await srv.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await assertNothingLeft(before);
});

test("a page without the contract (the wrong URL) fails by name, not per frame", {
  skip,
  timeout: 120_000,
}, async () => {
  const before = await snapshot();
  const dir = await mkdtemp(join(tmpdir(), "html-render-test-"));
  try {
    const srv = await serveDirectory(dir);
    try {
      await assert.rejects(
        renderHtmlFrames({
          profilePrefix: PREFIX,
          url: `${srv.url}/missing.html`, // a 404 page: no __ready, no __seek
          chromePath: chrome!,
          width: 64,
          height: 36,
          times: times(2),
          outDir: join(dir, "frames"),
          workers: 1,
        }),
        (e: Error) => {
          assert.match(e.message, /did not become ready/, e.message);
          assert.match(e.message, /window\.__ready is missing/, e.message);
          assert.match(e.message, /missing\.html/, e.message);
          return true;
        },
      );
    } finally {
      await srv.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await assertNothingLeft(before);
});

// --- slicing --------------------------------------------------------------------

test("frames are cut into contiguous, balanced slices; workers never exceed frames", () => {
  assert.deepEqual(sliceFrames(12, 2), [
    [0, 6],
    [6, 12],
  ]);
  assert.deepEqual(sliceFrames(10, 4), [
    [0, 3],
    [3, 6],
    [6, 8],
    [8, 10],
  ]);
  assert.deepEqual(sliceFrames(3, 4), [
    [0, 1],
    [1, 2],
    [2, 3],
  ]);
  assert.deepEqual(sliceFrames(0, 4), []);
  // every frame exactly once, in order
  for (const [total, workers] of [
    [601, 4],
    [7, 3],
    [1, 1],
  ] as const) {
    const slices = sliceFrames(total, workers);
    assert.equal(slices.length, Math.min(total, workers));
    assert.equal(slices[0]![0], 0);
    assert.equal(slices.at(-1)![1], total);
    for (let i = 1; i < slices.length; i++) assert.equal(slices[i]![0], slices[i - 1]![1]);
  }
  assert.equal(defaultHtmlWorkers(600, 10), 4);
  assert.equal(defaultHtmlWorkers(600, 4), 2);
  assert.equal(defaultHtmlWorkers(600, 1), 1);
  assert.equal(defaultHtmlWorkers(3, 10), 3);
  assert.equal(defaultHtmlWorkers(0, 10), 0);
  assert.equal(frameFileName(7), "0000007.png");
  assert.equal(frameFileName(1234567, "jpeg"), "1234567.jpg");
});

// --- the static server ----------------------------------------------------------

/** a raw request, so `/../` reaches the server un-normalised (fetch would fold it away) */
function raw(
  url: string,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

test("the static server: MIME by extension, ranges, index.html, and nothing outside the root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "html-server-test-"));
  try {
    await writeFile(join(dir, "index.html"), "<p>hi</p>");
    await writeFile(join(dir, "app.mjs"), "export const x = 1;");
    await writeFile(join(dir, "font.woff2"), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    await writeFile(join(dir, "clip.mp4"), Buffer.from("0123456789"));
    await writeFile(join(dir, "thing.xyz"), "?");
    const srv = await serveDirectory(dir);
    try {
      assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+$/);

      const html = await raw(srv.url, "/index.html");
      assert.equal(html.status, 200);
      assert.equal(html.headers["content-type"], "text/html; charset=utf-8");
      assert.equal(html.body.toString(), "<p>hi</p>");
      assert.equal(
        (await raw(srv.url, "/")).body.toString(),
        "<p>hi</p>",
        "a directory serves its index.html",
      );

      assert.equal(
        (await raw(srv.url, "/app.mjs")).headers["content-type"],
        "text/javascript; charset=utf-8",
      );
      assert.equal((await raw(srv.url, "/font.woff2")).headers["content-type"], "font/woff2");
      assert.equal((await raw(srv.url, "/clip.mp4")).headers["content-type"], "video/mp4");
      assert.equal(
        (await raw(srv.url, "/thing.xyz")).headers["content-type"],
        "application/octet-stream",
      );
      assert.equal(
        (await raw(srv.url, "/index.html?v=2")).status,
        200,
        "a query string is not part of the path",
      );

      const head = await raw(srv.url, "/clip.mp4", {}, "HEAD");
      assert.equal(head.status, 200);
      assert.equal(head.headers["content-length"], "10");
      assert.equal(head.body.length, 0);

      const range = await raw(srv.url, "/clip.mp4", { range: "bytes=2-4" });
      assert.equal(range.status, 206);
      assert.equal(range.headers["content-range"], "bytes 2-4/10");
      assert.equal(range.body.toString(), "234");
      assert.equal((await raw(srv.url, "/clip.mp4", { range: "bytes=7-" })).body.toString(), "789");
      assert.equal((await raw(srv.url, "/clip.mp4", { range: "bytes=-3" })).body.toString(), "789");
      assert.equal((await raw(srv.url, "/clip.mp4", { range: "bytes=20-" })).status, 416);

      assert.equal((await raw(srv.url, "/nope.html")).status, 404);
      // dot segments fold away at the URL level (`/../` IS the root); an encoded
      // slash survives that and decodes to a path outside — containment catches it
      assert.equal((await raw(srv.url, "/../")).body.toString(), "<p>hi</p>");
      assert.equal((await raw(srv.url, "/../../../../etc/passwd")).status, 404);
      assert.equal((await raw(srv.url, "/%2e%2e/%2e%2e/etc/passwd")).status, 404);
      assert.equal((await raw(srv.url, "/..%2F..%2F..%2F..%2Fetc%2Fpasswd")).status, 404);
      assert.equal((await raw(srv.url, "/index.html%00.txt")).status, 404);
      assert.equal((await raw(srv.url, "/index.html", {}, "POST")).status, 405);
    } finally {
      await srv.close();
    }
    await assert.rejects(raw(srv.url, "/index.html"), "closed means closed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("path containment and range parsing, on their own", () => {
  const base = process.platform === "win32" ? "C:\\srv\\root" : "/srv/root";
  const sep = process.platform === "win32" ? "\\" : "/";
  assert.equal(fileFor(base, "/a/b.png"), `${base}${sep}a${sep}b.png`);
  assert.equal(fileFor(base, "/"), base);
  assert.equal(fileFor(base, "/a/../b.png"), `${base}${sep}b.png`, "dots inside the root are fine");
  // the URL parser folds dot segments before anything else: never above the root
  assert.equal(fileFor(base, "/../x"), `${base}${sep}x`);
  assert.equal(fileFor(base, "/a/../../x"), `${base}${sep}x`);
  assert.equal(fileFor(base, "/%2e%2e/x"), `${base}${sep}x`);
  // an encoded slash is decoded AFTER that folding, so it can point outside: contained
  assert.equal(fileFor(base, "/..%2F..%2Fx"), null);
  assert.equal(fileFor(base, "/a%2F..%2F..%2Fx"), null);
  assert.equal(fileFor(base, "/a%00.png"), null);
  assert.equal(fileFor(base, "/%zz"), null, "a malformed escape names nothing");
  assert.equal(fileFor(base, "/sp%20ace.png"), `${base}${sep}sp ace.png`);

  assert.deepEqual(parseRange("bytes=2-4", 10), { start: 2, end: 4 });
  assert.deepEqual(parseRange("bytes=7-", 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(
    parseRange("bytes=0-99", 10),
    { start: 0, end: 9 },
    "an end past the file is clamped",
  );
  assert.equal(parseRange("bytes=20-", 10), "unsatisfiable");
  assert.equal(parseRange("bytes=5-2", 10), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 10), "unsatisfiable");
  assert.equal(parseRange("bytes=0-1,3-4", 10), null, "multi-range: the whole file instead");
  assert.equal(parseRange("items=0-1", 10), null);
  assert.equal(parseRange(undefined, 10), null);
  assert.equal(parseRange("bytes=0-", 0), null, "an empty file has no ranges");
});
