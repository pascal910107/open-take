// edit-server — the local bridge that powers `open-take edit <take>`. It serves
// the built editor SPA AND a tiny JSON/stream API over the take's files, so the
// browser editor can load a take, save edits, and trigger a real (Node-only)
// revideo render with live progress — all on 127.0.0.1, no external services.
//
// Endpoints (all under /api):
//   GET  /api/take                 → { composition, captureLog, source, videoUrl, mp4Url, mtime }
//   GET  /api/take/video           → the kept capture mp4 (HTTP Range, for <video> seeking)
//   GET  /api/take/output[?v=tok]  → the latest rendered mp4 (HTTP Range)
//   POST /api/composition          → guarded validate + persist (428 without base, 400 invalid)
//   POST /api/render               → guarded persist + start → { jobId, mtime } (409 conflict/busy)
//   GET  /api/render/:id/events    → SSE: progress* → done {mp4Url} | failed {message}
// Everything else is static from the editor dist (SPA fallback to index.html).
//
// Two writers share composition.json: this editor and the agent (the Dailies
// loop re-writes it between renders). Writes here are optimistically
// concurrency-controlled — the client echoes back the mtime it last saw and a
// write over a file that moved since is REFUSED with 409, rather than silently
// winning. See persistGuarded.

import { createReadStream, statSync } from "node:fs";
import { appendFile, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
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
import { openWithOs } from "./review";

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

type EditServerDeps = {
  /** Test seam for the long-running renderer. Production uses the real one. */
  renderComposition?: typeof renderComposition;
  /** Test seam immediately after the temp composition is written. */
  beforeCompositionCommit?: () => Promise<void>;
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

/** Locate the built editor SPA: prefer the live monorepo build during
 *  development, then fall back to the bundled copy used by the published
 *  package. */
function resolveEditorDist(): string | null {
  const here = fileURLToPath(import.meta.url);
  const pkgRoot = resolve(here, "..", ".."); // dist/edit-server.js → packages/runtime
  // In the monorepo the live editor build wins: editor-dist/ is a prepack COPY
  // and goes stale the moment you rebuild the editor, which silently serves old
  // JS to anyone testing a change. Published, that path doesn't exist (it would
  // resolve under node_modules/apps/editor/…), so the copy is the only candidate.
  const candidates = [
    resolve(pkgRoot, "..", "..", "apps", "editor", "dist"),
    resolve(pkgRoot, "editor-dist"),
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

/** Open the editor in the default browser. Shares the OS-opener with review.ts
 *  — a private copy here is how the Windows `start`-eats-the-first-quoted-arg
 *  bug survived in one place after being noticed in the other. */
function openBrowser(url: string) {
  openWithOs(url, `open: ${url}\n`);
}

export async function startEditServer(
  opts: EditServerOpts,
  deps: EditServerDeps = {},
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
  // Set synchronously before the render endpoint's first await. Without this,
  // two simultaneous POSTs can both observe `job === null`, persist, and
  // replace each other's job before either request reaches the assignment.
  let renderStarting = false;

  const compositionMtime = async (): Promise<number> =>
    (await stat(take.compositionPath).catch(() => null))?.mtimeMs ?? 0;

  // Every write runs alone: check-then-write is only meaningful if nothing
  // interleaves between the two, and this server can have an autosave and an
  // export in flight at once.
  let writeLock: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = writeLock.then(fn, fn);
    writeLock = run.catch(() => {});
    return run;
  };

  /** Persist unless someone else wrote first. `baseMtime` is the mtime the
   *  client last read. Every API write must provide it; 保留我的 re-bases to
   *  the 409's mtime and remains guarded against an even newer write.
   *
   *  We check once before writing the temp file and again immediately before
   *  rename, so an agent write during serialization/I/O is refused too. No
   *  portable filesystem API provides compare-and-swap by mtime: a different
   *  process writing in the final stat→rename window can still be overwritten
   *  unless every writer honors the same lock. */
  const persistGuarded = async (
    comp: TakeComposition,
    baseMtime: number | undefined,
  ): Promise<{ ok: true; mtime: number } | { ok: false; mtime: number }> =>
    exclusive(async () => {
      const onDisk = await compositionMtime();
      if (baseMtime !== undefined && onDisk !== baseMtime) return { ok: false, mtime: onDisk };
      const tmp = `${take.compositionPath}.tmp`;
      let committed = false;
      try {
        await writeFile(tmp, JSON.stringify(comp, null, 2));
        await deps.beforeCompositionCommit?.();
        if (baseMtime !== undefined) {
          const beforeRename = await compositionMtime();
          if (beforeRename !== onDisk) return { ok: false, mtime: beforeRename };
        }
        await rename(tmp, take.compositionPath);
        committed = true;
        return { ok: true, mtime: await compositionMtime() };
      } finally {
        if (!committed) await unlink(tmp).catch(() => {});
      }
    });

  type WritePayload = { composition: TakeComposition; baseMtime: number };

  /** The write guard is mandatory. A missing base used to mean "force write",
   *  which made a bare JSON body an invisible escape hatch around conflict
   *  protection. Callers must first GET /api/take and echo its mtime. */
  const readWrite = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<WritePayload | null> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: "invalid JSON request body" });
      return null;
    }
    const candidate =
      parsed && typeof parsed === "object"
        ? (parsed as { composition?: unknown; baseMtime?: unknown })
        : null;
    if (
      !candidate?.composition ||
      typeof candidate.baseMtime !== "number" ||
      !Number.isFinite(candidate.baseMtime)
    ) {
      sendJson(res, 428, {
        error:
          "write precondition required: send { composition, baseMtime } using the mtime from GET /api/take",
      });
      return null;
    }
    return {
      composition: candidate.composition as TakeComposition,
      baseMtime: candidate.baseMtime,
    };
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
        // read the mtime BEFORE the contents: if a write lands in between, the
        // client's base is older than what it holds and its next save 409s —
        // the safe direction. (Reading it after could hand out a base newer
        // than the composition we returned, which would silently clobber.)
        const mtime = await compositionMtime();
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
          mtime,
        });
        return;
      }
      if (path === "/api/take/video" && method === "GET") {
        await serveFile(req, res, take.capturePath);
        return;
      }
      if (path === "/api/take/mtime" && method === "GET") {
        sendJson(res, 200, { mtime: await compositionMtime() });
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
        const payload = await readWrite(req, res);
        if (!payload) return;
        const { composition: comp, baseMtime } = payload;
        const captureLog = await loadCaptureLog();
        const issues = validateComposition(comp, captureLog ? { captureLog } : {});
        const errors = issues.filter((i) => i.severity === "error");
        if (errors.length) {
          sendJson(res, 400, { issues });
          return;
        }
        const saved = await persistGuarded(comp, baseMtime);
        if (!saved.ok) {
          sendJson(res, 409, { conflict: true, mtime: saved.mtime });
          return;
        }
        sendJson(res, 200, { ok: true, issues, mtime: saved.mtime });
        return;
      }

      if (path === "/api/render" && method === "POST") {
        if (renderStarting || job?.status === "running") {
          sendJson(res, 409, { error: "a render is already in progress" });
          return;
        }
        renderStarting = true;
        try {
          const payload = await readWrite(req, res);
          if (!payload) return;
          const { composition: comp, baseMtime } = payload;
          const captureLog = (await loadCaptureLog()) ?? undefined;
          const issues = validateComposition(comp, captureLog ? { captureLog } : {});
          const errors = issues.filter((i: CompositionIssue) => i.severity === "error");
          if (errors.length) {
            sendJson(res, 400, { issues });
            return;
          }
          const saved = await persistGuarded(comp, baseMtime);
          if (!saved.ok) {
            // Same status as "render already running" above — the `conflict`
            // flag is what tells the two apart on the client.
            sendJson(res, 409, { conflict: true, mtime: saved.mtime });
            return;
          }
          const id = `${Date.now().toString(36)}-${++jobSeq}`;
          job = { id, progress: 0, status: "running", clients: new Set() };
          // Re-base immediately: the guarded write already happened. Waiting
          // for SSE `done` leaves the client stale when rendering fails or
          // disconnects.
          sendJson(res, 200, { jobId: id, mtime: saved.mtime });
          // Run the render in the background; stream progress to SSE clients.
          void runRender(job, comp, captureLog);
        } finally {
          renderStarting = false;
        }
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
      await (deps.renderComposition ?? renderComposition)({
        composition: comp,
        capturePath: take.capturePath,
        outPath: take.mp4Path,
        captureLog,
        chromePath: opts.chromePath,
        // POST /api/render already persisted `comp` under persistGuarded. A
        // second write after a long render would overwrite any agent edit that
        // landed while rendering.
        writeCompositionSibling: false,
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

/** Bind to 127.0.0.1 only; if the port is taken, try the next few. Resolves the
 *  port actually BOUND, which differs from the requested one when port 0 asks
 *  the OS to choose (how the tests get an isolated server). */
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
      server.listen(port, "127.0.0.1", () => {
        const addr = server.address();
        res(addr && typeof addr === "object" ? addr.port : port);
      });
    };
    tryOne();
  });
}
