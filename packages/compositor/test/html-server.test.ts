// The static server a film's page is served from: same-origin files over
// loopback, MIME by extension, byte ranges (a <video> seeks with them), and
// nothing outside the root.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileFor, parseRange, serveDirectory } from "../src/html/server";

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
