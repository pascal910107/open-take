// Static files for one directory, so a film's page and everything it loads —
// fonts, images, clips, saved screens — are same-origin at
// http://127.0.0.1:<port>/… A file:// page would refuse cross-origin fonts and
// fetch() of a sibling file; over loopback every asset is a plain relative URL
// and Chrome caches it for the life of that (throwaway) profile.
//
// No dependencies: node:http on loopback, an ephemeral port, GET and HEAD, the
// MIME types a render page uses, byte ranges (a <video> seeks with them), and
// nothing else: no directory listing, and a path that escapes the root is a
// 404 like any other missing file.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".wasm": "application/wasm",
};

export type StaticServer = {
  /** `http://127.0.0.1:<port>` — no trailing slash */
  url: string;
  /** serve `dir` under the URL path `prefix` (`/a/b/`): what the server
   *  itself made for the page, kept out of the served folder */
  mount(prefix: string, dir: string): void;
  /** stop listening and drop every open connection */
  close(): Promise<void>;
};

/** Serve `root` (a directory) on a loopback ephemeral port until `close()`. */
export async function serveDirectory(
  root: string,
  /** told the path of every request answered 404 (a film's missing font or
   *  image would otherwise just render without it) */
  onMiss?: (urlPath: string) => void,
): Promise<StaticServer> {
  const base = resolve(root);
  const info = await stat(base).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`serveDirectory: ${base} is not a directory`);

  const mounts = new Map<string, string>();
  const server = createServer((req, res) => {
    let url = req.url ?? "/";
    let from = base;
    for (const [prefix, dir] of mounts)
      if (url.startsWith(prefix)) {
        from = dir;
        url = `/${url.slice(prefix.length)}`;
        break;
      }
    serveFile(from, url, req, res, () => onMiss?.((req.url ?? "/").split("?")[0]!)).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail);
      ok();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    mount(prefix, dir) {
      if (!prefix.startsWith("/") || !prefix.endsWith("/"))
        throw new Error(
          `serveDirectory: a mount is a path that starts and ends with "/", not ${prefix}`,
        );
      mounts.set(prefix, resolve(dir));
    },
    close: () =>
      new Promise<void>((ok) => {
        // close() alone waits for keep-alive connections to end on their own;
        // a browser holds them open for a minute, so drop them.
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
}

/** The file a request path names inside `base`, or null when it names none
 *  we would serve (malformed escapes, a NUL, or a path that resolves outside
 *  the root — `..` segments and `%2e%2e` alike, since both are decoded and
 *  normalised before the containment check). */
export function fileFor(base: string, rawUrl: string): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, "http://127.0.0.1").pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;
  const file = resolve(base, `.${pathname}`);
  if (file !== base && !file.startsWith(base + sep)) return null;
  return file;
}

type ByteRange = { start: number; end: number } | "unsatisfiable" | null;

/** One `bytes=` range against a file of `size` bytes; null for no/unsupported
 *  (multi-)range, so the whole file goes out as a 200. */
export function parseRange(header: string | undefined, size: number): ByteRange {
  if (!header || size === 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, from, to] = m;
  if (from === "" && to === "") return null;
  let start: number, end: number;
  if (from === "") {
    // suffix range: the last N bytes
    const n = Number(to);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(from);
    end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

async function serveFile(
  base: string,
  url: string,
  req: IncomingMessage,
  res: ServerResponse,
  missed: () => void = () => {},
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return;
  }
  let file = fileFor(base, url);
  let info = file ? await stat(file).catch(() => null) : null;
  if (file && info?.isDirectory()) {
    // a directory serves its index.html and nothing else — never a listing
    file = join(file, "index.html");
    info = await stat(file).catch(() => null);
  }
  if (!file || !info?.isFile()) {
    missed();
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }

  const headers: Record<string, string> = {
    "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Last-Modified": info.mtime.toUTCString(),
    // a profile lives for one render, so caching only ever spans that render
    "Cache-Control": "max-age=3600",
  };
  const range = parseRange(req.headers.range, info.size);
  if (range === "unsatisfiable") {
    res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
    res.end();
    return;
  }
  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${info.size}`;
    headers["Content-Length"] = String(range.end - range.start + 1);
    res.writeHead(206, headers);
  } else {
    headers["Content-Length"] = String(info.size);
    res.writeHead(200, headers);
  }
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  // pipeline (not pipe) so a client that goes away mid-file destroys the
  // read stream too, instead of leaving its descriptor open
  pipeline(createReadStream(file, range ?? {}), res, () => {});
}
