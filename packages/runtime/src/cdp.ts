// Minimal Chrome DevTools Protocol toolkit for the high-fps capture path.
//
// Why this exists: agent-browser's `record` wraps Playwright recordVideo,
// hard-throttled to ~10fps (no fps flag — native binary). The fps spike
// (spike-revideo/fps/VERDICT.md) proved a direct CDP `Page.startScreencast`
// delivers ~60fps, and that driving the drag via CDP `Input` at ~16ms steps
// keeps the captured ink in lockstep with the synthetic cursor. So the
// hi-fps path drives AND captures over one CDP page session: one owner, one
// clock, no per-step agent-browser process spawn.
//
// No deps — Node 22's global `WebSocket`/`fetch` carry the protocol.

import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveFfmpeg } from "@open-take/compositor";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const require = createRequire(import.meta.url);

// Where we cache an auto-downloaded Chrome-for-Testing + the resolved buildId.
const CHROME_CACHE = join(homedir(), ".open-take", "browsers");
const BUILDID_FILE = join(homedir(), ".open-take", "chrome-build.json");

// --- locate a launchable Chrome ----------------------------------------
// Resolution order: explicit/env → a Chrome-for-Testing we downloaded → a
// CfT an agent-browser install left behind (legacy). Returns null if none
// (→ ensureChrome downloads CfT). We deliberately do NOT auto-pick the user's
// *system* Chrome: launching the same binary while Chrome is already running
// hands off to the existing instance and never opens the debug port (proven).
// CfT is the isolated, automation-stable browser Playwright/Puppeteer use too.
// Point OPEN_TAKE_CHROME at a system Chrome if you really want one (close it
// first).
export function resolveChrome(explicit?: string): string | null {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  if (process.env.OPEN_TAKE_CHROME) candidates.push(process.env.OPEN_TAKE_CHROME);

  // a Chrome-for-Testing we downloaded earlier (offline: derived from the
  // saved buildId, no network)
  if (existsSync(BUILDID_FILE)) {
    try {
      const exe = computeChromePathSync(JSON.parse(readFileSync(BUILDID_FILE, "utf8")).buildId);
      if (exe) candidates.push(exe);
    } catch {
      /* ignore a corrupt cache marker */
    }
  }

  // legacy: a CfT an older agent-browser install left behind (also isolated)
  const abBrowsers = join(homedir(), ".agent-browser", "browsers");
  if (existsSync(abBrowsers)) {
    for (const d of readdirSync(abBrowsers)
      .filter((n) => n.startsWith("chrome-"))
      .sort()
      .reverse()) {
      candidates.push(
        join(
          abBrowsers,
          d,
          "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        ),
        join(abBrowsers, d, "chrome-linux64", "chrome"),
        join(abBrowsers, d, "chrome"),
      );
    }
  }

  return candidates.find((c) => c && existsSync(c)) ?? null;
}

// Best-effort sync path to a cached CfT build (lazy-loads the helper; returns
// null if @puppeteer/browsers isn't resolvable for any reason).
function computeChromePathSync(buildId: string): string | null {
  try {
    // require keeps this synchronous inside the sync resolver
    const { computeExecutablePath, Browser } = require("@puppeteer/browsers");
    return computeExecutablePath({ browser: Browser.CHROME, buildId, cacheDir: CHROME_CACHE });
  } catch {
    return null;
  }
}

// Resolve a Chrome, downloading Chrome-for-Testing on first use if the machine
// has none. The download is a one-time, cached fetch via @puppeteer/browsers
// (Chrome-team-maintained pure downloader) — this is what keeps install
// zero-config without binding us to agent-browser.
export async function ensureChrome(explicit?: string): Promise<string> {
  const found = resolveChrome(explicit);
  if (found) return found;
  try {
    const { install, resolveBuildId, detectBrowserPlatform, computeExecutablePath, Browser } =
      await import("@puppeteer/browsers");
    const platform = detectBrowserPlatform();
    if (!platform) throw new Error("unsupported platform");
    const buildId = await resolveBuildId(Browser.CHROME, platform, "stable");
    const exe = computeExecutablePath({ browser: Browser.CHROME, buildId, cacheDir: CHROME_CACHE });
    if (!existsSync(exe)) {
      mkdirSync(CHROME_CACHE, { recursive: true });
      // First run on this machine: a one-time ~150MB fetch. Say so (and show
      // coarse progress) so `make` doesn't look like a silent stall.
      process.stderr.write(
        `open-take: downloading Chrome for Testing (${buildId}, one-time) → ${CHROME_CACHE}\n`,
      );
      let lastPct = -1;
      await install({
        browser: Browser.CHROME,
        buildId,
        cacheDir: CHROME_CACHE,
        downloadProgressCallback: (downloaded: number, total: number) => {
          if (!total) return;
          const pct = Math.floor((downloaded / total) * 100);
          // throttle to whole-ten-percent steps to keep the log quiet
          if (pct >= lastPct + 10 || pct === 100) {
            lastPct = pct;
            process.stderr.write(`open-take: …Chrome download ${pct}%\n`);
          }
        },
      });
      process.stderr.write("open-take: Chrome ready.\n");
    }
    mkdirSync(dirname(BUILDID_FILE), { recursive: true });
    writeFileSync(BUILDID_FILE, JSON.stringify({ buildId }));
    return exe;
  } catch (e) {
    throw new Error(
      `open-take: no Chrome found and auto-download failed (${(e as Error).message}). ` +
        "Install Chrome/Chromium, or set OPEN_TAKE_CHROME to a Chrome binary.",
    );
  }
}

// --- minimal CDP client over a page-target websocket -------------------
export class CDP {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, (params: any) => void>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev: MessageEvent) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.handlers.get(msg.method)?.(msg.params);
      }
    });
  }

  static connect(wsUrl: string): Promise<CDP> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.addEventListener("open", () => resolve(new CDP(ws)));
      ws.addEventListener("error", () => reject(new Error(`CDP connect failed: ${wsUrl}`)));
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, fn: (params: any) => void): void {
    this.handlers.set(method, fn);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

// --- launch + page-target discovery ------------------------------------
export type Browser = {
  cdp: CDP;
  /** the page target's id (for browser-level window commands) */
  targetId: string;
  /** kill the browser process and remove its temp profile */
  close: () => Promise<void>;
};

/** Launch headless Chrome, return a CDP session bound to its page target. */
export async function launchBrowser(opts: {
  width: number;
  height: number;
  chromePath?: string;
}): Promise<Browser> {
  const chrome = await ensureChrome(opts.chromePath);
  const userDir = mkdtempSync(join(tmpdir(), "open-take-cdp-"));
  const proc: ChildProcess = spawn(
    chrome,
    [
      "--remote-debugging-port=0", // pick a free port; read it back from DevToolsActivePort
      `--user-data-dir=${userDir}`,
      `--window-size=${opts.width},${opts.height}`,
      "--headless=new",
      // automation browser (throwaway profile, loads the user's own target app);
      // without this the launch hangs — never writes DevToolsActivePort — in
      // sandboxed/containerised/CI contexts where Chrome's own sandbox can't init.
      "--no-sandbox",
      // never touch the OS keychain (macOS would pop a "Chrome for Testing wants
      // to use Chromium Safe Storage" password prompt every capture); use an
      // in-process store instead. These are puppeteer/playwright defaults.
      "--password-store=basic",
      "--use-mock-keychain",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-features=Translate,AcceptCHFrame,MediaRouter,OptimizationHints",
      "--mute-audio",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  proc.stderr?.on("data", (d) => (stderr += d));

  const close = async () => {
    const exited = new Promise<void>((res) => {
      if (proc.exitCode != null) return res();
      proc.once("exit", () => res());
      setTimeout(res, 2000); // don't hang if exit never fires
    });
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await exited;
    // Chrome may still be flushing its profile; retry the rm rather than throw.
    rmSync(userDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };

  try {
    const port = await readDevtoolsPort(userDir, proc);
    const target = await pageTargetWs(port);
    const cdp = await CDP.connect(target.wsUrl);
    return { cdp, targetId: target.id, close };
  } catch (e) {
    await close();
    throw new Error(
      `open-take(hi-fps): browser launch failed: ${(e as Error).message}\n${stderr.slice(-600)}`,
    );
  }
}

// Chrome writes the chosen debugging port to <user-data-dir>/DevToolsActivePort
// (line 1) once the listener is up. Polling that file is the race-free way to
// learn a port-0 launch's actual port.
async function readDevtoolsPort(userDir: string, proc: ChildProcess): Promise<number> {
  const file = join(userDir, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode != null) throw new Error(`chrome exited early (${proc.exitCode})`);
    if (existsSync(file)) {
      const line = readFileSync(file, "utf8").split("\n")[0]?.trim();
      const port = Number(line);
      if (Number.isFinite(port) && port > 0) return port;
    }
    await sleep(50);
  }
  throw new Error("timed out waiting for DevToolsActivePort");
}

async function pageTargetWs(port: number): Promise<{ wsUrl: string; id: string }> {
  for (let i = 0; i < 60; i++) {
    try {
      const list = (await (await fetch(`http://localhost:${port}/json`)).json()) as Array<{
        type: string;
        id: string;
        webSocketDebuggerUrl?: string;
      }>;
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return { wsUrl: page.webSocketDebuggerUrl, id: page.id };
    } catch {
      /* browser not ready yet */
    }
    await sleep(100);
  }
  throw new Error("no page target appeared");
}

// Grow the window so the *natural* layout viewport matches the requested size.
// Headless reserves window chrome (~140px), so a 1280x800 window yields a
// ~1280x657 viewport. `Page.startScreencast` captures the window surface, NOT
// the layout viewport — so a device-metrics override would desync the captured
// frame from the coordinate space events are measured in. Resizing the real
// window keeps frame == viewport == event space, exactly. Returns the achieved
// inner size; on a browser that won't resize (remote/CDP service) it falls back
// to whatever the natural inner is — still self-consistent, just maybe smaller.
export async function fitViewport(
  cdp: CDP,
  targetId: string,
  vw: number,
  vh: number,
): Promise<[number, number]> {
  const readInner = async (): Promise<[number, number]> => {
    const r = await cdp.send<{ result?: { value?: string } }>("Runtime.evaluate", {
      expression: "JSON.stringify([window.innerWidth, window.innerHeight])",
      returnByValue: true,
    });
    const v = JSON.parse(r.result?.value ?? "[0,0]");
    return [Number(v[0]), Number(v[1])];
  };
  let win: { windowId: number; bounds: { width: number; height: number } } | null = null;
  try {
    win = await cdp.send("Browser.getWindowForTarget", { targetId });
  } catch {
    return readInner(); // can't resize — use the natural viewport
  }
  if (!win?.windowId) return readInner();
  let { width, height } = win.bounds;
  let inner = await readInner();
  for (let i = 0; i < 4; i++) {
    const dw = vw - inner[0];
    const dh = vh - inner[1];
    if (Math.abs(dw) <= 1 && Math.abs(dh) <= 1) break;
    width += dw;
    height += dh;
    await cdp.send("Browser.setWindowBounds", {
      windowId: win.windowId,
      bounds: { width, height },
    });
    await sleep(120);
    inner = await readInner();
  }
  return inner;
}

// --- screencast recorder ------------------------------------------------
// Frames stream in only when the page surface changes; each is written to
// disk immediately (don't buffer ~1500 JPEGs in RAM) with its arrival offset
// from t0, so the encoder can reconstruct true wall-clock timing.
export type Frame = { file: string; offMs: number };

export class Screencast {
  private cdp: CDP;
  private dir: string;
  private t0 = 0;
  private n = 0;
  readonly frames: Frame[] = [];

  constructor(cdp: CDP, dir: string) {
    this.cdp = cdp;
    this.dir = dir;
  }

  /** Begin capture. `t0` (Date.now) anchors every frame + event onto one clock. */
  async start(
    t0: number,
    opts: { maxWidth: number; maxHeight: number; quality?: number },
  ): Promise<void> {
    this.t0 = t0;
    this.cdp.on("Page.screencastFrame", (p: { data: string; sessionId: number }) => {
      const off = Date.now() - this.t0;
      const file = join(this.dir, `f-${String(this.n++).padStart(5, "0")}.jpg`);
      writeFileSync(file, Buffer.from(p.data, "base64"));
      this.frames.push({ file, offMs: off });
      // ack so Chrome keeps sending (un-acked frames stall the stream)
      this.cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
    });
    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: opts.quality ?? 90,
      maxWidth: opts.maxWidth,
      maxHeight: opts.maxHeight,
      everyNthFrame: 1,
    });
  }

  async stop(): Promise<void> {
    await this.cdp.send("Page.stopScreencast").catch(() => {});
  }
}

// --- encode timestamped frames -> video --------------------------------
// concat demuxer with per-frame `duration` reproduces real wall-clock pacing
// (static stretches naturally hold one frame). `-vsync cfr -r <fps>` resamples
// onto a constant grid the web/MP4 decoders downstream read cleanly. Codec
// follows the output extension so the file stays honest (.webm→vp9, else h264).
export async function encodeFrames(
  frames: Frame[],
  endMs: number,
  outPath: string,
  fps: number,
  ffmpegBin?: string,
): Promise<void> {
  if (frames.length === 0) throw new Error("open-take(hi-fps): no frames captured");
  const bin = ffmpegBin ?? (await resolveFfmpeg());
  const dir = frames[0]!.file.slice(0, frames[0]!.file.lastIndexOf("/"));
  const listPath = join(dir, "frames.concat");

  // Each frame is shown until the next arrives; the first is held back to t0
  // so the video timeline starts where event timestamps do.
  const lines: string[] = [];
  const bounds = [
    0,
    ...frames.slice(1).map((f) => f.offMs),
    Math.max(endMs, frames[frames.length - 1]!.offMs + 33),
  ];
  for (let i = 0; i < frames.length; i++) {
    const dur = Math.max(0.001, (bounds[i + 1]! - bounds[i]!) / 1000);
    lines.push(`file '${frames[i]!.file}'`, `duration ${dur.toFixed(4)}`);
  }
  // concat demuxer ignores the final entry's duration unless the file repeats.
  lines.push(`file '${frames[frames.length - 1]!.file}'`);
  writeFileSync(listPath, lines.join("\n"));

  const isWebm = /\.webm$/i.test(outPath);
  const codec = isWebm
    ? ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "28", "-deadline", "good", "-cpu-used", "4"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"];

  // Color: the screencast frames are full-range JPEGs (601). For h264, convert
  // to STANDARD limited-range bt709 and label all four fields (range/matrix/
  // primaries/transfer) so every downstream decoder agrees: the revideo render,
  // end-user players, AND any browser <video>→canvas consumer.
  // Without tags ffmpeg stamped yuvj420p/pc/bt470bg, which Chrome's canvas
  // mis-decodes as limited and over-brightens (~20 levels) → washed-out colors in
  // a canvas preview, while ffmpeg/revideo honored the full-range tag and stayed
  // faithful. `scale` converts (and sets range+matrix); `setparams` adds the
  // primaries+transfer labels scale leaves unspecified, so all four are explicit.
  const colorConvert = isWebm
    ? ""
    : ":in_range=full:in_color_matrix=bt470bg:out_range=tv:out_color_matrix=bt709";
  const colorLabel = isWebm
    ? ""
    : ",setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709";

  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-vsync",
      "cfr",
      "-r",
      String(fps),
      // screencast frames can be odd-sized (e.g. 1280x657); yuv420p needs
      // even dims, so round down to the nearest even before pixel-format.
      "-vf",
      `scale=trunc(iw/2)*2:trunc(ih/2)*2${colorConvert},format=yuv420p${colorLabel}`,
      ...codec,
      outPath,
    ];
    const c = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    c.stderr.on("data", (d) => (err += d));
    c.on("error", reject);
    c.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg encode exited ${code}: ${err.slice(-800)}`)),
    );
  });
}

/** A throwaway temp dir for the screencast's per-frame JPEGs. */
export const makeFrameDir = (): string => mkdtempSync(join(tmpdir(), "open-take-frames-"));
