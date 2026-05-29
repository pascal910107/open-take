// node-pty + asciinema v2 cast tee. v1 default terminal adapter (D9).
//
// Lifecycle: one PTY (spawned with the user's SHELL) per TerminalSession.
// Cast writing is bracketed by startCast/stopCast; while a cast is open
// every byte from the PTY emits one `[t, "o", data]` line, and every
// keystroke sent via run()/sendKeys() emits `[t, "i", data]`.
//
// Exit codes from `run({ waitForExit: true })` rely on a per-invocation
// random sentinel echoed after the command:
//
//     <cmd>\r echo __OD_EX_<id>:$?__\r
//
// `lastExitCode` reflects only the last waitForExit call. waitFor-only
// calls leave it null (D9: "terminal state is action replay", not
// "we always know exit codes").

import {
  createWriteStream,
  mkdirSync,
  type WriteStream,
} from "node:fs";
import { dirname } from "node:path";
import type {
  AssertionResult,
  TerminalAction,
  TerminalDriver,
  TerminalOpts,
  TerminalResult,
  TerminalSession,
} from "@open-take/core";

type IPty = {
  onData: (cb: (d: string) => void) => { dispose(): void };
  onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => { dispose(): void };
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
};

type PtySpawn = (
  file: string,
  args: string[] | string,
  options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
  },
) => IPty;

const BUFFER_CAP = 1 << 16; // 64 KiB tail

async function loadNodePty(): Promise<{ spawn: PtySpawn }> {
  const mod = await import("node-pty");
  const spawnFn = (mod as { spawn?: PtySpawn; default?: { spawn?: PtySpawn } })
    .spawn
    ?? (mod as { default?: { spawn?: PtySpawn } }).default?.spawn;
  if (!spawnFn) {
    throw new Error("node-pty: spawn() export not found (peerDependency may be missing)");
  }
  return { spawn: spawnFn };
}

export class NodePtyDriver implements TerminalDriver {
  async open(opts: TerminalOpts): Promise<TerminalSession> {
    const { spawn } = await loadNodePty();
    const cols = opts.cols ?? 100;
    const rows = opts.rows ?? 30;
    const cwd = opts.cwd ?? process.cwd();
    const shell = process.env.SHELL ?? "/bin/bash";

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    env.TERM = "xterm-256color";
    // Silence shell rc-file customizations that could interfere with the
    // sentinel parser (most aggressive prompts re-print on every key).
    // Authors that need a custom rc can swap SHELL via TerminalOpts later.
    env.PS1 = "$ ";

    const pty = spawn(shell, [], { name: "xterm-256color", cols, rows, cwd, env });
    const session = new NodePtySession(pty, cols, rows, shell);
    // Wait briefly for the initial prompt to flush before returning so
    // the first run() doesn't race with shell-startup output.
    await session.idle(150);
    return session;
  }
}

export class NodePtySession implements TerminalSession {
  private buffer = "";
  private castStream: WriteStream | null = null;
  private castStartMs: number | null = null;
  private disposed = false;
  private lastExitCode: number | null = null;
  private exitCode: number | null = null;
  private dataListeners: Array<(d: string) => void> = [];
  private exitListeners: Array<() => void> = [];

  constructor(
    private readonly pty: IPty,
    private readonly cols: number,
    private readonly rows: number,
    private readonly shell: string,
  ) {
    this.pty.onData((d) => this.handleData(d));
    this.pty.onExit((e) => {
      this.exitCode = e.exitCode;
      const ls = this.exitListeners.slice();
      this.exitListeners = [];
      for (const l of ls) l();
    });
  }

  // Wait `ms` of quiescence (no data for ms). Used to flush initial
  // prompt without making strong assumptions about the shell's PS1.
  async idle(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout = setTimeout(resolve, ms);
      const onData = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          this.dataListeners = this.dataListeners.filter((l) => l !== onData);
          resolve();
        }, ms);
      };
      this.dataListeners.push(onData);
    });
  }

  private handleData(d: string): void {
    this.buffer += d;
    if (this.buffer.length > BUFFER_CAP) {
      this.buffer = this.buffer.slice(-Math.floor(BUFFER_CAP / 2));
    }
    if (this.castStream && this.castStartMs !== null) {
      const t = (Date.now() - this.castStartMs) / 1000;
      this.castStream.write(JSON.stringify([t, "o", d]) + "\n");
    }
    const ls = this.dataListeners.slice();
    for (const l of ls) l(d);
  }

  private writeInput(data: string): void {
    if (this.castStream && this.castStartMs !== null) {
      const t = (Date.now() - this.castStartMs) / 1000;
      this.castStream.write(JSON.stringify([t, "i", data]) + "\n");
    }
    this.pty.write(data);
  }

  async run(
    cmd: string,
    opts?: { waitFor?: string; waitForExit?: boolean },
  ): Promise<TerminalResult> {
    // Default to waitForExit when neither flag is set — the common case
    // (run a quick command and continue) shouldn't require boilerplate.
    const waitForExit = opts?.waitForExit ?? !opts?.waitFor;
    this.lastExitCode = null;

    if (waitForExit) {
      const id = Math.random().toString(36).slice(2, 10);
      const sentinel = `__OD_EX_${id}`;
      this.writeInput(`${cmd}\r`);
      // Append the marker via printf so a failed `cmd` doesn't suppress
      // the echo (printf is a builtin in bash/zsh; `;` instead of `&&`).
      this.writeInput(`printf '%s\\n' "${sentinel}:$?:_END_"\r`);
      const match = await this.waitForRegex(
        new RegExp(`${sentinel}:(-?\\d+):_END_`),
      );
      this.lastExitCode = Number.parseInt(match[1]!, 10);
      return { exitCode: this.lastExitCode, bufferAtFinish: this.buffer };
    }

    this.writeInput(`${cmd}\r`);
    if (opts?.waitFor) {
      await this.waitFor(opts.waitFor);
    }
    return { exitCode: null, bufferAtFinish: this.buffer };
  }

  async sendKeys(keys: string): Promise<void> {
    this.writeInput(keys);
  }

  async read(): Promise<string> {
    return this.buffer;
  }

  async startCast(path: string): Promise<void> {
    mkdirSync(dirname(path), { recursive: true });
    this.castStream = createWriteStream(path);
    const header = {
      version: 2,
      width: this.cols,
      height: this.rows,
      timestamp: Math.floor(Date.now() / 1000),
      env: { SHELL: this.shell, TERM: "xterm-256color" },
    };
    this.castStream.write(JSON.stringify(header) + "\n");
    this.castStartMs = Date.now();
  }

  async stopCast(): Promise<void> {
    if (!this.castStream) return;
    const s = this.castStream;
    this.castStream = null;
    this.castStartMs = null;
    await new Promise<void>((resolve) => s.end(() => resolve()));
  }

  // Silent re-execution for HIT-replay-headless state catch-up. Skips
  // assertions (they were evaluated and cached on the original MISS).
  async replayActions(actions: TerminalAction[]): Promise<void> {
    const wasCasting = this.castStream !== null;
    const savedStream = this.castStream;
    const savedStart = this.castStartMs;
    this.castStream = null;
    this.castStartMs = null;
    try {
      for (const a of actions) {
        if (a.kind === "terminal.run") {
          const opts: { waitFor?: string; waitForExit?: boolean } = {};
          if (a.waitFor !== undefined) opts.waitFor = a.waitFor;
          if (a.waitForExit !== undefined) opts.waitForExit = a.waitForExit;
          await this.run(a.cmd, opts);
        } else if (a.kind === "terminal.sendKeys") {
          await this.sendKeys(a.keys);
        }
      }
    } finally {
      if (wasCasting) {
        this.castStream = savedStream;
        this.castStartMs = savedStart;
      }
    }
  }

  async runActions(
    actions: TerminalAction[],
  ): Promise<{ assertions: AssertionResult[] }> {
    const assertions: AssertionResult[] = [];
    for (const a of actions) {
      switch (a.kind) {
        case "terminal.run": {
          const opts: { waitFor?: string; waitForExit?: boolean } = {};
          if (a.waitFor !== undefined) opts.waitFor = a.waitFor;
          if (a.waitForExit !== undefined) opts.waitForExit = a.waitForExit;
          await this.run(a.cmd, opts);
          break;
        }
        case "terminal.sendKeys": {
          await this.sendKeys(a.keys);
          break;
        }
        case "terminal.assertContains": {
          const ok = this.buffer.includes(a.text);
          const r: AssertionResult & { actual?: string } = {
            ok,
            kind: "terminal.assertContains",
          };
          if (!ok) {
            r.message = `terminal output does not contain ${JSON.stringify(a.text)}`;
            r.actual = this.buffer.slice(-200);
          }
          assertions.push(r);
          break;
        }
        case "terminal.assertExit": {
          const observed = this.lastExitCode;
          const ok = observed === a.code;
          const r: AssertionResult & { actual?: string } = {
            ok,
            kind: "terminal.assertExit",
          };
          if (!ok) {
            r.message =
              observed === null
                ? "no completed Terminal.run({ waitForExit: true }) before this assertion"
                : `expected exit ${a.code}, got ${observed}`;
            if (observed !== null) r.actual = String(observed);
          }
          assertions.push(r);
          break;
        }
      }
    }
    return { assertions };
  }

  getLastExitCode(): number | null {
    return this.lastExitCode;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.stopCast();
    try {
      this.pty.kill();
    } catch {
      // best-effort
    }
  }

  private async waitFor(needle: string, timeoutMs = 30_000): Promise<void> {
    if (this.buffer.includes(needle)) return;
    return new Promise<void>((resolve, reject) => {
      const onData = () => {
        if (this.buffer.includes(needle)) {
          this.dataListeners = this.dataListeners.filter((l) => l !== onData);
          clearTimeout(timer);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        this.dataListeners = this.dataListeners.filter((l) => l !== onData);
        reject(new Error(`terminal waitFor timeout (${timeoutMs}ms): ${JSON.stringify(needle)}`));
      }, timeoutMs);
      this.dataListeners.push(onData);
    });
  }

  private async waitForRegex(re: RegExp, timeoutMs = 30_000): Promise<RegExpMatchArray> {
    const initial = this.buffer.match(re);
    if (initial) return initial;
    return new Promise<RegExpMatchArray>((resolve, reject) => {
      const onData = () => {
        const m = this.buffer.match(re);
        if (m) {
          this.dataListeners = this.dataListeners.filter((l) => l !== onData);
          clearTimeout(timer);
          resolve(m);
        }
      };
      const timer = setTimeout(() => {
        this.dataListeners = this.dataListeners.filter((l) => l !== onData);
        reject(new Error(`terminal waitForRegex timeout (${timeoutMs}ms): ${re}`));
      }, timeoutMs);
      this.dataListeners.push(onData);
    });
  }
}
