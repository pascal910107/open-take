// A headless Chrome for the seek renderer, driven over the DevTools protocol
// with nothing but Node 22's global WebSocket and fetch — the shape of
// packages/runtime/src/cdp.ts, cut down to what a frame renderer needs: one
// page, evaluate, screenshot, close.
//
// The browser is launched at an EXPLICIT path (the caller resolves it; never
// a system Chrome, which hands the launch to the instance already running and
// never opens its debug port) with a fresh throwaway profile and the render
// hygiene flags the html-renderer spike measured: every compositor stage runs
// before a draw, no checkerboard tiles, one colour profile, no LCD text. The
// GPU path is kept — software raster costs 2.5× per shot and only buys a
// bit-exactness that CRF encoding erases anyway (single-LSB jitter otherwise).
//
// Every wait has a timeout and every failure is a rejection, never a hang: a
// page that throws (Runtime.evaluate's exceptionDetails, an uncaught
// Runtime.exceptionThrown), a Chrome that exits, a socket that closes.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type HtmlBrowser = {
  /** Run `expression` in the page. A returned promise is awaited; a throw or
   *  rejection (Runtime.evaluate exceptionDetails) rejects. */
  evaluate<T = unknown>(expression: string, opts?: { timeoutMs?: number }): Promise<T>;
  /** The viewport as PNG (default) or JPEG bytes. */
  screenshot(opts?: { format?: "png" | "jpeg"; quality?: number }): Promise<Buffer>;
  /** Kill Chrome and remove its profile. Idempotent; never throws. */
  close(): Promise<void>;
};

export type LaunchHtmlBrowserOpts = {
  /** the Chrome binary to run — resolved by the caller, never searched for here */
  chromePath: string;
  /** the page to open; resolves once its load event fired */
  url: string;
  width: number;
  height: number;
  /** default for every wait: launch, load, evaluate, screenshot (60 s) */
  timeoutMs?: number;
  /** the throwaway profile's directory name prefix in the temp dir */
  profilePrefix?: string;
  /** runs in every document before any of its own scripts
   *  (Page.addScriptToEvaluateOnNewDocument) */
  initScript?: string;
  /** device pixels per CSS pixel, default 1: the page lays out at
   *  width×height CSS px and screenshots come out that many times larger
   *  (a half-size draft is 0.5) */
  deviceScaleFactor?: number;
  /** the page's console calls: level (log, warning, error…) and text */
  onConsole?: (level: string, text: string) => void;
};

// Chrome writes the port of a `--remote-debugging-port=0` launch to
// <profile>/DevToolsActivePort once the listener is up. The first run of a
// freshly downloaded bundle can take several seconds to start (macOS validates
// the code signature) — the runtime measured 4.5 s — so the wait is generous;
// a crashed Chrome still fails fast through its exit.
const DEVTOOLS_PORT_WAIT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 60_000;

/** Launch a headless Chrome at `chromePath`, open `url` in a `width`×`height`
 *  viewport and wait for its load event. Fails (with Chrome killed and its
 *  profile removed) if the binary is missing, Chrome exits or never opens its
 *  port, or the navigation errors. */
export async function launchHtmlBrowser(opts: LaunchHtmlBrowserOpts): Promise<HtmlBrowser> {
  const { chromePath, url, width, height } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!existsSync(chromePath)) throw new Error(`html render: no Chrome binary at ${chromePath}`);
  if (!(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0))
    throw new Error(`html render: viewport must be whole positive pixels, got ${width}×${height}`);

  const userDir = mkdtempSync(join(tmpdir(), opts.profilePrefix ?? "open-take-html-"));
  const proc: ChildProcess = spawn(
    chromePath,
    [
      "--headless=new",
      "--remote-debugging-port=0", // a free port, read back from DevToolsActivePort
      `--user-data-dir=${userDir}`,
      // The runtime capture path found the launch never writes DevToolsActivePort
      // in sandboxed/containerised/CI contexts where Chrome's own sandbox can't
      // init; the page here is our own local file, so the sandbox buys nothing.
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--mute-audio",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--metrics-recording-only",
      // never touch the OS keychain (macOS would prompt for Chromium Safe Storage)
      "--password-store=basic",
      "--use-mock-keychain",
      // render hygiene: a screenshot only after every compositor stage has run,
      // no checkerboarded tiles, one colour profile, no LCD subpixel text
      "--run-all-compositor-stages-before-draw",
      "--disable-checker-imaging",
      "--force-color-profile=srgb",
      "--disable-lcd-text",
      "--font-render-hinting=none",
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  proc.stderr?.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });

  // the process's fate, observable by every wait below
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let spawnError: Error | null = null;
  const exited = new Promise<void>((r) => {
    proc.once("exit", (code, signal) => {
      exit = { code, signal };
      r();
    });
    proc.once("error", (e) => {
      spawnError = e;
      r();
    });
  });
  const exitWithin = (ms: number) =>
    Promise.race([exited.then(() => true), sleep(ms).then(() => false)]);
  const chromeGone = (): Error | null => {
    if (spawnError) return new Error(`Chrome could not start: ${spawnError.message}`);
    if (exit)
      return new Error(
        `Chrome exited (${exit.signal ?? `code ${exit.code}`})${stderr ? `\n${stderr.slice(-600)}` : ""}`,
      );
    return null;
  };

  // Chrome must not outlive this process: a sync kill on exit (the temp
  // profile goes with it). Removed again on close so listeners never pile up.
  const killOnExit = () => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    rmSync(userDir, { recursive: true, force: true });
  };
  process.once("exit", killOnExit);

  let session: Session | null = null;
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (!closing) {
      closing = (async () => {
        process.off("exit", killOnExit);
        // Browser.close lets Chrome retire its GPU and renderer helpers itself;
        // a Chrome that does not go within the grace period is killed.
        if (session?.alive) session.send("Browser.close", {}, 1000).catch(() => {});
        if (!(await exitWithin(session?.alive ? 1500 : 0))) {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* already gone */
          }
          await exitWithin(2000); // don't hang if exit never fires
        }
        session?.close();
        await killSurvivors(userDir);
        // Chrome may still be flushing the profile: retry the rm, and never let
        // a directory that will not go take the place of the render's own error
        try {
          rmSync(userDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } catch {
          setTimeout(() => {
            try {
              rmSync(userDir, { recursive: true, force: true });
            } catch {
              /* a profile a dying helper still held: swept with the next launch's tmp */
            }
          }, 1000).unref();
        }
      })();
    }
    return closing;
  };

  // one uncaught page error poisons the page: every call in flight and every
  // later one rejects with it, so a broken page never renders quietly. The
  // calls in flight are held in a set and let go as they settle — racing each
  // one against a single never-settling "poisoned" promise instead kept every
  // settled call (and its result: a 1 MB screenshot) reachable from that
  // promise's reaction list, and a full film ran Node out of memory.
  let pageError: Error | null = null;
  const inflight = new Set<(e: Error) => void>();
  const poison = (e: Error) => {
    if (pageError) return;
    pageError = e;
    for (const reject of inflight) reject(e);
    inflight.clear();
  };
  const guarded = <T>(p: Promise<T>): Promise<T> => {
    if (pageError) return Promise.reject(pageError);
    return new Promise<T>((resolve, reject) => {
      inflight.add(reject);
      p.then(
        (v) => {
          inflight.delete(reject);
          resolve(v);
        },
        (e) => {
          inflight.delete(reject);
          reject(e);
        },
      );
    });
  };

  try {
    const port = await readDevtoolsPort(userDir, chromeGone);
    const wsUrl = await pageTargetWs(port, chromeGone);
    session = await Session.connect(wsUrl, timeoutMs);
    const s = session;
    // Chrome going away fails every pending call at once (not on their timeouts)
    void exited.then(() => s.fail(chromeGone() ?? new Error("Chrome exited")));

    s.on<{ exceptionDetails: ExceptionDetails }>("Runtime.exceptionThrown", (p) =>
      poison(new Error(`page error: ${describeException(p.exceptionDetails)}`)),
    );
    s.on("Inspector.targetCrashed", () => poison(new Error("page crashed")));
    // a dialog would block the page for good; a render page has no one to answer it
    s.on("Page.javascriptDialogOpening", () => {
      s.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
    });

    await s.send("Page.enable", {}, timeoutMs);
    await s.send("Runtime.enable", {}, timeoutMs);
    if (opts.onConsole) {
      const onConsole = opts.onConsole;
      s.on<{ type: string; args: { value?: unknown; description?: string }[] }>(
        "Runtime.consoleAPICalled",
        (p) =>
          onConsole(p.type, p.args.map((a) => String(a.value ?? a.description ?? "")).join(" ")),
      );
    }
    if (opts.initScript)
      await s.send("Page.addScriptToEvaluateOnNewDocument", { source: opts.initScript }, timeoutMs);
    await s.send("Page.setLifecycleEventsEnabled", { enabled: true }, timeoutMs);
    await s.send(
      "Emulation.setDeviceMetricsOverride",
      { width, height, deviceScaleFactor: opts.deviceScaleFactor ?? 1, mobile: false },
      timeoutMs,
    );

    // The load event of OUR navigation, matched by loaderId: about:blank's own
    // load, or a redirect chain, must not pass for it. Events are recorded from
    // before the navigate call — several protocol messages can be dispatched in
    // one turn, so a listener registered after the reply could miss the event.
    const loaded = new Set<string>();
    s.on<{ name: string; loaderId: string }>("Page.lifecycleEvent", (p) => {
      if (p.name === "load") loaded.add(p.loaderId);
    });
    const nav = await guarded(
      s.send<{ loaderId?: string; errorText?: string }>("Page.navigate", { url }, timeoutMs),
    );
    if (nav.errorText) throw new Error(`could not load ${url}: ${nav.errorText}`);
    const loaderId = nav.loaderId;
    if (!(loaderId && loaded.has(loaderId)))
      await guarded(
        s.waitFor<{ name: string; loaderId: string }>(
          "Page.lifecycleEvent",
          (p) => p.name === "load" && (!loaderId || p.loaderId === loaderId),
          timeoutMs,
          `load of ${url}`,
        ),
      );
  } catch (e) {
    await close();
    throw new Error(`html render: browser launch failed: ${(e as Error).message}`, { cause: e });
  }

  const s = session;
  return {
    async evaluate<T = unknown>(
      expression: string,
      evalOpts: { timeoutMs?: number } = {},
    ): Promise<T> {
      const r = await guarded(
        s.send<{ result?: { value?: unknown }; exceptionDetails?: ExceptionDetails }>(
          "Runtime.evaluate",
          { expression, awaitPromise: true, returnByValue: true },
          evalOpts.timeoutMs ?? timeoutMs,
        ),
      );
      if (r.exceptionDetails)
        throw new Error(`page threw: ${describeException(r.exceptionDetails)}`);
      return r.result?.value as T;
    },
    async screenshot(shot: { format?: "png" | "jpeg"; quality?: number } = {}): Promise<Buffer> {
      const format = shot.format ?? "png";
      const r = await guarded(
        s.send<{ data: string }>(
          "Page.captureScreenshot",
          {
            format,
            ...(format === "jpeg" && shot.quality != null ? { quality: shot.quality } : {}),
            optimizeForSpeed: true,
            captureBeyondViewport: false,
          },
          timeoutMs,
        ),
      );
      return Buffer.from(r.data, "base64");
    },
    close,
  };
}

// --- the process's debug port and page target -------------------------------

/** Kill every process still carrying this profile's path in its arguments.
 *  Chrome hands `--user-data-dir` to its GPU, renderer and utility helpers, and
 *  they normally go with the browser — but not always: under load, two helpers
 *  were seen alive 5 s after their browser had exited on Browser.close. A
 *  survivor would hold the profile open and keep rendering nothing. POSIX only:
 *  on Windows the sandbox's job object takes the helpers down with the browser. */
async function killSurvivors(userDir: string): Promise<void> {
  if (process.platform === "win32") return;
  const table = await new Promise<string>((r) =>
    execFile(
      "ps",
      ["-axo", "pid=,command="],
      { encoding: "utf8", maxBuffer: 1 << 24 },
      (_error, stdout) => r(stdout ?? ""), // no ps (a bare container): nothing to sweep with
    ),
  );
  for (const line of table.split("\n")) {
    if (!line.includes(userDir)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (!(pid > 0) || pid === process.pid) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone between the listing and now */
    }
  }
}

async function readDevtoolsPort(userDir: string, gone: () => Error | null): Promise<number> {
  const file = join(userDir, "DevToolsActivePort");
  for (let i = 0; i < DEVTOOLS_PORT_WAIT_MS / 50; i++) {
    const dead = gone();
    if (dead) throw dead;
    if (existsSync(file)) {
      const port = Number(readFileSync(file, "utf8").split("\n")[0]?.trim());
      if (Number.isFinite(port) && port > 0) return port;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for DevToolsActivePort (${DEVTOOLS_PORT_WAIT_MS / 1000}s)`);
}

async function pageTargetWs(port: number, gone: () => Error | null): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const dead = gone();
    if (dead) throw dead;
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Array<{
        type: string;
        webSocketDebuggerUrl?: string;
      }>;
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* the listener is up before the target list is */
    }
    await sleep(100);
  }
  throw new Error("no page target appeared");
}

// --- exceptions as text --------------------------------------------------------

type ExceptionDetails = {
  text: string;
  lineNumber: number;
  columnNumber: number;
  url?: string;
  exception?: { description?: string; value?: unknown };
};

/** "Error: boom\n    at __seek (http://…/index.html:5:20)" plus the location
 *  when the description carries no stack of its own. */
function describeException(d: ExceptionDetails): string {
  const description =
    d.exception?.description ??
    (d.exception && "value" in d.exception ? String(d.exception.value) : d.text);
  const lines = description.split("\n");
  const where =
    lines.length > 1 || !d.url ? "" : ` (${d.url}:${d.lineNumber + 1}:${d.columnNumber + 1})`;
  return lines.slice(0, 4).join("\n") + where;
}

// --- minimal CDP client over a page-target websocket ------------------------

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

class Session {
  private ws: WebSocket;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<(params: unknown) => void>>();
  private dead: Error | null = null;

  get alive(): boolean {
    return this.dead === null;
  }

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        error?: { message?: string };
        result?: unknown;
        method?: string;
        params?: unknown;
      };
      if (msg.id != null) {
        const call = this.pending.get(msg.id);
        if (!call) return; // answered after its timeout
        this.pending.delete(msg.id);
        if (msg.error) call.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else call.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.handlers.get(msg.method) ?? []) fn(msg.params);
      }
    });
    ws.addEventListener("close", () => this.fail(new Error("the DevTools socket closed")));
    ws.addEventListener("error", () => this.fail(new Error("the DevTools socket failed")));
  }

  static connect(wsUrl: string, timeoutMs: number): Promise<Session> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        reject(new Error(`connecting to ${wsUrl} timed out after ${timeoutMs} ms`));
        ws.close();
      }, timeoutMs);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve(new Session(ws));
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error(`CDP connect failed: ${wsUrl}`));
        },
        { once: true },
      );
    });
  }

  /** Send a command; the reply, or a rejection on a protocol error, a dead
   *  session, or `timeoutMs` passing (a late reply is then dropped). */
  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        this.pending.delete(id);
        fn();
      };
      if (timeoutMs)
        timer = setTimeout(
          () => settle(() => reject(new Error(`${method} timed out after ${timeoutMs} ms`))),
          timeoutMs,
        );
      this.pending.set(id, {
        resolve: (value) => settle(() => resolve(value as T)),
        reject: (error) => settle(() => reject(error)),
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        settle(() => reject(e as Error));
      }
    });
  }

  on<T = unknown>(method: string, fn: (params: T) => void): void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(fn as (params: unknown) => void);
  }

  /** The next `method` event `pred` accepts, or a rejection after `timeoutMs`. */
  waitFor<T>(
    method: string,
    pred: (params: T) => boolean,
    timeoutMs: number,
    what: string,
  ): Promise<T> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise<T>((resolve, reject) => {
      const fn = (params: T) => {
        if (!pred(params)) return;
        clearTimeout(timer);
        this.handlers.get(method)?.delete(fn as (params: unknown) => void);
        resolve(params);
      };
      const timer = setTimeout(() => {
        this.handlers.get(method)?.delete(fn as (params: unknown) => void);
        reject(new Error(`${what} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.on(method, fn);
    });
  }

  /** Reject every pending call and every later one with `error`. */
  fail(error: Error): void {
    if (this.dead) return;
    this.dead = error;
    for (const call of this.pending.values()) call.reject(error);
    this.pending.clear();
  }

  close(): void {
    this.fail(new Error("the browser was closed"));
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}
