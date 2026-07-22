// edit-server — the local bridge that powers `open-take edit <take>`. It serves
// the built editor SPA AND a tiny JSON/stream API over the take's files, so the
// browser editor can load a take, save edits, and trigger a real (Node-only)
// revideo render with live progress — all on 127.0.0.1, no external services.
//
// Endpoints (all under /api):
//   GET  /api/take                 → { composition, captureLog, source, videoUrl, mp4Url }
//   GET  /api/take/video           → the kept capture mp4 (HTTP Range, for <video> seeking)
//   GET  /api/take/output[?v=tok]  → the latest rendered mp4 (HTTP Range)
//   POST /api/composition          → validate + persist <base>.composition.json (400 + issues on error)
//   POST /api/render               → persist + start a render job → { jobId } (409 if one's running)
//   GET  /api/render/:id/events    → SSE: progress* → done {mp4Url} | error {message}
// Everything else is static from the editor dist (SPA fallback to index.html).

import { spawn } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { appendFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CaptureLog,
  type CompositionIssue,
  type TakeComposition,
  validateComposition,
} from "@open-take/compositor";
import { renderComposition } from "./index";

export type EditServerOpts = {
  /** path to the take: its .mp4 / .composition.json / a dir containing them. */
  takePath: string;
  port?: number;
  /** open the browser at the served URL (default true). */
  open?: boolean;
  chromePath?: string;
};

import { resolveTakePaths } from "./take";

type TakePaths = Awaited<ReturnType<typeof resolveTakePaths>>;

type RenderJob = {
  id: string;
  progress: number;
  status: "running" | "done" | "error";
  error?: string;
  mp4Url?: string;
  clients: Set<ServerResponse>;
};

const CONTENT_TYPE: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
};

/** Locate the built editor SPA: a bundled copy (published package) first, then
 *  the monorepo build. */
function resolveEditorDist(): string | null {
  const here = fileURLToPath(import.meta.url);
  const pkgRoot = resolve(here, "..", ".."); // dist/edit-server.js → packages/runtime
  const candidates = [
    resolve(pkgRoot, "editor-dist"),
    resolve(pkgRoot, "..", "..", "apps", "editor", "dist"),
  ];
  return candidates.find((c) => existsHtml(c)) ?? null;
}
function existsHtml(dir: string): boolean {
  return existsFile(join(dir, "index.html"));
}
function existsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const sendJson = (res: ServerResponse, status: number, obj: unknown) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
};

async function readBody(req: IncomingMessage, capBytes = 32 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > capBytes) throw new Error("request body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Stream a file with HTTP Range support (206) — required for <video> seeking. */
async function serveFile(req: IncomingMessage, res: ServerResponse, filePath: string) {
  const st = await stat(filePath).catch(() => null);
  if (!st?.isFile()) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const type = CONTENT_TYPE[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m?.[1] ? Number(m[1]) : 0;
    const end = m?.[2] ? Number(m[2]) : st.size - 1;
    if (start >= st.size || end >= st.size || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${st.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": type,
    });
    createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": st.size,
      "Accept-Ranges": "bytes",
      "Content-Type": type,
    });
    createReadStream(filePath).pipe(res);
  }
}

function openBrowser(url: string) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    }).unref();
  } catch {
    /* noop */
  }
}

export async function startEditServer(
  opts: EditServerOpts,
): Promise<{ url: string; close: () => Promise<void> }> {
  const take = await resolveTakePaths(opts.takePath);
  // the two essentials must exist; the capture log is optional (skips the lock).
  for (const f of [take.compositionPath, take.capturePath]) {
    if (!(await stat(f).catch(() => null))?.isFile()) throw new Error(`missing take file: ${f}`);
  }
  const dist = resolveEditorDist();
  if (!dist)
    throw new Error("editor build not found — run `pnpm --filter @open-take/editor build` first");

  const loadCaptureLog = async (): Promise<CaptureLog | null> => {
    try {
      return JSON.parse(await readFile(take.captureLogPath, "utf8")) as CaptureLog;
    } catch {
      return null;
    }
  };

  let job: RenderJob | null = null;
  let jobSeq = 0;

  /** Atomic write (tmp + rename) — agents read this file concurrently. */
  const persistComposition = async (comp: TakeComposition): Promise<void> => {
    const tmp = `${take.compositionPath}.tmp`;
    await writeFile(tmp, JSON.stringify(comp, null, 2));
    await rename(tmp, take.compositionPath);
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      // same-origin guard: this is a loopback server, but a hostile web page
      // could still fire cross-site requests at it — refuse foreign Origins
      // and non-JSON bodies on state-changing endpoints.
      if (method === "POST") {
        const host = req.headers.host ?? "";
        const origin = req.headers.origin;
        const sameOrigin = !origin || origin === `http://${host}`;
        const isJson = (req.headers["content-type"] ?? "").includes("application/json");
        if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || !sameOrigin || !isJson) {
          sendJson(res, 403, { error: "forbidden" });
          return;
        }
      }

      // ---- API ----
      if (path === "/api/take" && method === "GET") {
        const composition = JSON.parse(
          await readFile(take.compositionPath, "utf8"),
        ) as TakeComposition;
        const captureLog = await loadCaptureLog();
        sendJson(res, 200, {
          composition,
          captureLog,
          source: { name: take.name },
          videoUrl: "/api/take/video",
          mp4Url: "/api/take/output",
        });
        return;
      }
      if (path === "/api/take/video" && method === "GET") {
        await serveFile(req, res, take.capturePath);
        return;
      }
      if (path === "/api/take/mtime" && method === "GET") {
        const st = await stat(take.compositionPath).catch(() => null);
        sendJson(res, 200, { mtime: st ? st.mtimeMs : 0 });
        return;
      }
      if (path === "/api/notes" && method === "POST") {
        const { text } = JSON.parse(await readBody(req)) as { text?: string };
        if (!text?.trim()) {
          sendJson(res, 400, { error: "empty note" });
          return;
        }
        const line = text.trim().replace(/\s+/g, " ").slice(0, 2000);
        // durable for the agent to pick up later + live on stdout for an agent
        // watching this process
        await appendFile(`${take.base}.notes.md`, `- ${line}\n`);
        process.stdout.write(`NOTE ${JSON.stringify({ take: take.name, text: line })}\n`);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (path === "/api/take/output" && method === "GET") {
        await serveFile(req, res, take.mp4Path);
        return;
      }

      if (path === "/api/composition" && method === "POST") {
        const comp = JSON.parse(await readBody(req)) as TakeComposition;
        const captureLog = await loadCaptureLog();
        const issues = validateComposition(comp, captureLog ? { captureLog } : {});
        const errors = issues.filter((i) => i.severity === "error");
        if (errors.length) {
          sendJson(res, 400, { issues });
          return;
        }
        await persistComposition(comp);
        sendJson(res, 200, { ok: true, issues });
        return;
      }

      if (path === "/api/render" && method === "POST") {
        if (job?.status === "running") {
          sendJson(res, 409, { error: "a render is already in progress" });
          return;
        }
        const comp = JSON.parse(await readBody(req)) as TakeComposition;
        const captureLog = (await loadCaptureLog()) ?? undefined;
        const issues = validateComposition(comp, captureLog ? { captureLog } : {});
        const errors = issues.filter((i: CompositionIssue) => i.severity === "error");
        if (errors.length) {
          sendJson(res, 400, { issues });
          return;
        }
        await persistComposition(comp);
        const id = `${Date.now().toString(36)}-${++jobSeq}`;
        job = { id, progress: 0, status: "running", clients: new Set() };
        sendJson(res, 200, { jobId: id });
        // run the render in the background; stream progress to SSE clients.
        void runRender(job, comp, captureLog);
        return;
      }

      const ev = /^\/api\/render\/([^/]+)\/events$/.exec(path);
      if (ev && method === "GET") {
        const id = ev[1];
        if (!job || job.id !== id) {
          sendJson(res, 404, { error: "unknown job" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        emit(res, "progress", { progress: job.progress });
        if (job.status === "done") {
          emit(res, "done", { mp4Url: job.mp4Url });
          res.end();
          return;
        }
        if (job.status === "error") {
          emit(res, "failed", { message: job.error });
          res.end();
          return;
        }
        job.clients.add(res);
        req.on("close", () => job?.clients.delete(res));
        return;
      }

      if (path.startsWith("/api/")) {
        sendJson(res, 404, { error: "no such endpoint" });
        return;
      }

      // ---- static editor SPA ----
      if (method !== "GET") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      const rel = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, "");
      let filePath = join(dist, rel === "/" ? "index.html" : rel);
      if (!filePath.startsWith(dist)) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }
      const fst = await stat(filePath).catch(() => null);
      if (!fst?.isFile()) filePath = join(dist, "index.html"); // SPA fallback
      await serveFile(req, res, filePath);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  async function runRender(
    j: RenderJob,
    comp: TakeComposition,
    captureLog: CaptureLog | undefined,
  ) {
    try {
      await renderComposition({
        composition: comp,
        capturePath: take.capturePath,
        outPath: take.mp4Path,
        captureLog,
        chromePath: opts.chromePath,
        onProgress: (p) => {
          j.progress = p;
          for (const c of j.clients) emit(c, "progress", { progress: p });
        },
      });
      j.status = "done";
      j.progress = 1;
      j.mp4Url = `/api/take/output?v=${Date.now().toString(36)}`;
      for (const c of j.clients) {
        emit(c, "done", { mp4Url: j.mp4Url });
        c.end();
      }
    } catch (err) {
      j.status = "error";
      j.error = err instanceof Error ? err.message : String(err);
      for (const c of j.clients) {
        emit(c, "failed", { message: j.error });
        c.end();
      }
    } finally {
      j.clients.clear();
    }
  }

  const port = await listen(server, opts.port ?? 4178);
  const url = `http://127.0.0.1:${port}/`;
  process.stdout.write(
    `open-take editor → ${url}\n(serving take "${take.name}"; Ctrl-C to stop)\n`,
  );
  if (opts.open !== false) openBrowser(url);

  return {
    url,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function emit(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Bind to 127.0.0.1 only; if the port is taken, try the next few. */
function listen(server: ReturnType<typeof createServer>, startPort: number): Promise<number> {
  return new Promise((res, rej) => {
    let port = startPort;
    const tryOne = () => {
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && port < startPort + 20) {
          port++;
          tryOne();
        } else rej(e);
      });
      server.listen(port, "127.0.0.1", () => res(port));
    };
    tryOne();
  });
}
