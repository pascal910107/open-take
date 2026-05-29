// Adapter interfaces. Browser capture is now pure CDP in @open-take/runtime
// (no browser-adapter package). Remaining adapter bodies:
//   @open-take/adapter-node-pty       (D9)
//   @open-take/adapter-elevenlabs     (D11)
//   @open-take/adapter-ffmpeg         (D10)
//
// See docs/architecture.md §4.

import type { BrowserAction, TerminalAction } from "../ir/index.js";

export type BBox = [x: number, y: number, w: number, h: number];

// --- BrowserDriver ----------------------------------------------------

export interface BrowserDriver {
  open(opts: BrowserOpts): Promise<BrowserSession>;
}

export type BrowserOpts = {
  headed?: boolean;
  viewport?: { width: number; height: number };
  workspaceRoot?: string;
  sessionName?: string;
  // When set, assertA11yTreeMatches writes the observed a11y tree to
  // its snapshotPath (creating or overwriting) and returns PASS
  // instead of diffing. Routed from `open-take render --update-snapshots`.
  updateSnapshots?: boolean;
};

export type ActionResult = {
  ok: boolean;
  output?: string;
  error?: string;
};

export type AssertionResult = {
  ok: boolean;
  kind: string;
  message?: string;
};

export type ActionBatchResult = {
  results: ActionResult[];
  assertions: AssertionResult[];
};

export type DeterminismOpts = {
  startEpochMs: number;
  prngSeed: number;
  freezeRaf?: boolean;
};

export interface BrowserSession {
  dispose(): Promise<void>;

  // State save/restore via session-file copy (D8 / spike-1b).
  restoreStateFile(path: string): Promise<void>;
  saveStateFile(path: string): Promise<void>;

  // Recording
  startVideo(path: string): Promise<void>;
  stopVideo(): Promise<void>;

  // Batch — the runtime coalesces a step's actions through here.
  // AgentBrowserDriver: one `agent-browser batch` invocation.
  // PlaywrightDriver: in-process sequential calls.
  runActionBatch(actions: BrowserAction[]): Promise<ActionBatchResult>;

  // Per-action bboxes for the inspector (Q-E). v0 returns {}.
  collectBboxes(actions: BrowserAction[]): Promise<Record<string, BBox>>;

  // Network mocking (D19). v0 stubs are allowed; not required for the
  // dryrun smoke.
  recordHar(path: string): Promise<void>;
  replayHar(path: string): Promise<void>;

  // Determinism scaffold (D19). v0 may be a no-op for static fixtures.
  installDeterminismScaffold(opts: DeterminismOpts): Promise<void>;
}

// --- TerminalDriver ---------------------------------------------------

export interface TerminalDriver {
  open(opts: TerminalOpts): Promise<TerminalSession>;
}

export type TerminalOpts = {
  cwd?: string;
  cols?: number;
  rows?: number;
};

export type TerminalResult = {
  exitCode: number | null;
  bufferAtFinish: string;
};

export interface TerminalSession {
  run(cmd: string, opts?: { waitFor?: string; waitForExit?: boolean }): Promise<TerminalResult>;
  sendKeys(keys: string): Promise<void>;
  read(): Promise<string>;
  startCast(path: string): Promise<void>;
  stopCast(): Promise<void>;
  replayActions(actions: TerminalAction[]): Promise<void>;
  dispose(): Promise<void>;

  // Exit code of the most recent Terminal.run({ waitForExit: true }).
  // Reset whenever a new run() starts. Returns null when no command has
  // completed yet, or when the most recent run used `waitFor` only.
  getLastExitCode(): number | null;

  // Execute a step's terminal actions in document order, mirroring the
  // BrowserSession.runActionBatch shape so the runtime can collect
  // AssertionResult[] alongside browser assertions. Each terminal.assert*
  // action yields exactly one AssertionResult; non-assert actions yield
  // none. Implementations tee output to the active cast when one is open.
  runActions(actions: TerminalAction[]): Promise<{ assertions: AssertionResult[] }>;
}

// --- TTSDriver --------------------------------------------------------

export interface TTSDriver {
  synthesize(text: string, opts: TTSOpts): Promise<{ audio: Uint8Array; vtt: string }>;
  modelVersion(): string;
}

export type TTSOpts = {
  voiceId: string;
  lang?: string;
};

// --- Compositor -------------------------------------------------------

export interface Compositor {
  transcodeToCanonical(webmPath: string, mp4OutPath: string): Promise<void>;
  muxSegment(opts: MuxOpts): Promise<{ mp4Path: string }>;
  concatSegments(segments: SegmentRef[], opts: ConcatOpts): Promise<{ mp4Path: string }>;
  zoom(input: string, bbox: BBox, scale: number, durationMs: number): Promise<string>;
  mixAudio(tracks: AudioTrackRef[]): Promise<string>;
}

export type MuxOpts = {
  videoPath: string;
  audioPath?: string;
  subtitlePath?: string;
  outPath: string;
};

export type ConcatOpts = {
  outPath: string;
  htmlReplayPath?: string;
  castPath?: string;
};

export type SegmentRef = {
  mp4Path: string;
  castPath?: string;
};

export type AudioTrackRef = {
  path: string;
  gainDb?: number;
};
