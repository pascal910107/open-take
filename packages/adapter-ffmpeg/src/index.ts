// Dormant ffmpeg segment compositor: not wired into the current
// cli -> runtime -> revideo compositor path. Kept for planned terminal/audio
// work, with its contract colocated here until that integration exists.
//
// transcodeToCanonical normalises WebM into the legacy canonical
// canonical render profile so concat can be -c copy stream-copy.
// concatSegments uses the concat demuxer (no re-encode); every input
// must already match the canonical profile.
//
// Audio: video inputs may be silent; we inject a silent
// stereo 48 kHz track via lavfi anullsrc so the MP4 has the audio
// stream that the canonical profile + concat-demuxer requires.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type BBox = [x: number, y: number, w: number, h: number];

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

export interface Compositor {
  transcodeToCanonical(webmPath: string, mp4OutPath: string): Promise<void>;
  muxSegment(opts: MuxOpts): Promise<{ mp4Path: string }>;
  concatSegments(segments: SegmentRef[], opts: ConcatOpts): Promise<{ mp4Path: string }>;
  zoom(input: string, bbox: BBox, scale: number, durationMs: number): Promise<string>;
  mixAudio(tracks: AudioTrackRef[]): Promise<string>;
}

// Profile string that toolFp.renderProfile must match (D21). Bumping
// the encode below requires minting v2 and bumping toolFp so caches
// invalidate.
export const CANONICAL_PROFILE_ID = "h264-1080p30-yuv420p-aac48k-v1";

export const CANONICAL_WIDTH = 1920;
export const CANONICAL_HEIGHT = 1080;
export const CANONICAL_FPS = 30;
export const CANONICAL_GOP = 30;
export const CANONICAL_SAMPLE_RATE = 48000;
export const CANONICAL_AUDIO_CHANNELS = 2;

// Minimum video duration a canonical segment is padded to. agent-browser's
// WebM holds ~100 ms of actual video for a fast batch (only frames captured
// between `record start` and `record stop`); without a pad, the resulting
// canonical mp4's video stream is much shorter than its container duration,
// and concat-stream-copied outputs end up with their video stream ending
// well before the audio (and container) does. Seek past the video end
// returns the last frame or fails. 1000 ms is the floor — comfortable for
// per-step viewing, long enough that narrated steps almost always have
// audio>video and muxSegment's existing audio-outlasts-video branch keeps
// covering the rest.
export const CANONICAL_MIN_VIDEO_MS = 1000;

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`ffmpeg exited ${code}\n--- ffmpeg stderr ---\n${stderr.slice(-4096)}`));
    });
  });
}

function runFfprobe(ffprobePath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(new Error(`ffprobe exited ${code}\n--- ffprobe stderr ---\n${stderr.slice(-4096)}`));
    });
  });
}

// Probe a media file's duration in milliseconds. Used by the compose
// tool to populate per-step startMs/durationMs in the embed manifest.
// Falls through to `ffprobe` next to the compositor's `ffmpegPath` —
// the system install typically ships both.
// Render an asciinema v2 cast as a canonical-profile mp4 so a
// terminal-only step joins the concat list alongside browser
// segments. Frame-by-frame: walk cast events, simulate a line-based
// terminal buffer, dedup states, render one PNG per distinct state
// via PIL, ffmpeg concat-demux with per-frame durations into a
// canonical mp4. Result: typing animates in real time.
//
// Terminal model is intentionally minimal — line buffer, LF / CR / BS,
// printable chars with line wrap, scroll-up when buffer exceeds the
// visible window. CSI / OSC / charset / SGR / cursor-positioning escape
// sequences are stripped. This is enough for echo / printf / pnpm /
// git output. NOT enough for curses (vim / less / top / progress bars
// that use cursor moves) — those render as scrolling text, not
// in-place updates. Real terminal-emulator quality is a future
// dependency choice (pyte would slot in as a drop-in replacement of
// the BufferState class).
//
// Output conforms to D21 canonical profile so the result still
// concat-stream-copies with browser siblings.
//
// Caching: the renderer is deterministic from (cast bytes, font,
// title); the caller (compose.ts) caches at `renderings/<rk>/video.mp4`
// so subsequent composes don't re-render.
export async function castToMp4(
  castPath: string,
  outPath: string,
  opts?: {
    fontPath?: string;
    ffmpegPath?: string;
    pythonPath?: string;
    minDurationMs?: number;
    tailPadMs?: number;
    // Per-state-transition minimum, in ms. Acts as a floor on the
    // duration each distinct visible state holds before advancing to
    // the next. Important for asciinema casts of fast commands (echo /
    // printf / git status) where zsh emits the entire output in a few
    // microseconds — without a floor, dedup produces N near-instant
    // frames that the eye can't perceive. Default 50 ms produces a
    // visible but tight build-up (~1–3 s for a typical 3-command echo
    // burst). Real long-running output (pnpm test, pip install) is
    // unaffected because its natural event spacing already exceeds the
    // floor.
    minFrameMs?: number;
    maxLines?: number;
    widthChars?: number;
    title?: string;
  },
): Promise<void> {
  if (!existsSync(castPath)) {
    throw new Error(`castToMp4: cast file not found at ${castPath}`);
  }

  // Pick a monospace font. macOS first; common Linux locations next;
  // env override last word for CI.
  const fontCandidates = [
    opts?.fontPath,
    process.env.OPEN_TAKE_TERMINAL_FONT,
    "/System/Library/Fonts/SFNSMono.ttf",
    "/System/Library/Fonts/Menlo.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
  ].filter(Boolean) as string[];
  let fontPath: string | undefined;
  for (const f of fontCandidates) {
    if (existsSync(f)) {
      fontPath = f;
      break;
    }
  }
  if (!fontPath) {
    throw new Error(
      "castToMp4: no monospace font found; set OPEN_TAKE_TERMINAL_FONT to a .ttf path",
    );
  }

  const pythonPath = opts?.pythonPath ?? "python3";
  const ffmpegPath = opts?.ffmpegPath ?? "ffmpeg";
  const tmp = mkdtempSync(join(tmpdir(), "open-take-cast-"));

  try {
    // Python+PIL renderer. Inline so the package ships as
    // dist/index.js only (no sidecar .py shipping concerns). ~120
    // lines is the upper bound before this should become its own
    // file under packages/adapter-ffmpeg/scripts/.
    const py = [
      "import json, os, re, sys",
      "from PIL import Image, ImageDraw, ImageFont",
      "",
      "cast_path = sys.argv[1]",
      "font_path = sys.argv[2]",
      "out_dir = sys.argv[3]",
      "title = sys.argv[4]",
      "width_chars = int(sys.argv[5])",
      "visible_lines = int(sys.argv[6])",
      "tail_pad_sec = float(sys.argv[7])",
      "min_dur_sec = float(sys.argv[8])",
      "min_frame_sec = float(sys.argv[9])",
      "",
      `W, H = ${CANONICAL_WIDTH}, ${CANONICAL_HEIGHT}`,
      "BG = (10, 13, 17)",
      "FG = (200, 225, 180)",
      "TITLE_FG = (110, 130, 140)",
      "FONT_SIZE = 26",
      "TITLE_SIZE = 20",
      "LINE_SPACING = 10",
      "X_PAD = 80",
      "Y_PAD = 80 if title else 60",
      "Y_TITLE = 40",
      "",
      "events = []",
      "with open(cast_path, encoding='utf-8', errors='replace') as f:",
      "    _header = f.readline()",
      "    for line in f:",
      "        line = line.strip()",
      "        if not line: continue",
      "        try:",
      "            evt = json.loads(line)",
      "        except Exception:",
      "            continue",
      "        if isinstance(evt, list) and len(evt) >= 3:",
      "            t, kind, data = evt[0], evt[1], evt[2]",
      "            if kind == 'o' and isinstance(data, str):",
      "                events.append((float(t), data))",
      "",
      "CSI = re.compile(r'\\x1b\\[[0-9;?]*[a-zA-Z]')",
      "OSC = re.compile(r'\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)')",
      "CHARSET = re.compile(r'\\x1b[()][AB012]')",
      "NONRENDER = re.compile(r'[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]')",
      "",
      "def strip_ansi(s):",
      "    s = CSI.sub('', s)",
      "    s = OSC.sub('', s)",
      "    s = CHARSET.sub('', s)",
      "    s = NONRENDER.sub('', s)",
      "    return s",
      "",
      "lines = ['']",
      "cur_row = 0",
      "cur_col = 0",
      "",
      "def feed(ch):",
      "    global lines, cur_row, cur_col",
      "    if ch == '\\n':",
      "        cur_row += 1",
      "        cur_col = 0",
      "        while len(lines) <= cur_row:",
      "            lines.append('')",
      "    elif ch == '\\r':",
      "        cur_col = 0",
      "    elif ch == '\\b':",
      "        cur_col = max(0, cur_col - 1)",
      "    else:",
      "        while len(lines) <= cur_row:",
      "            lines.append('')",
      "        line = lines[cur_row]",
      "        if len(line) < cur_col:",
      "            line = line + ' ' * (cur_col - len(line))",
      "        line = line[:cur_col] + ch + line[cur_col+1:]",
      "        lines[cur_row] = line",
      "        cur_col += 1",
      "        if cur_col >= width_chars:",
      "            cur_row += 1",
      "            cur_col = 0",
      "            while len(lines) <= cur_row:",
      "                lines.append('')",
      "",
      "def snapshot():",
      "    visible = lines[-visible_lines:] if len(lines) > visible_lines else lines",
      "    return '\\n'.join(visible)",
      "",
      "frames = []",
      "prev = None",
      "if not events:",
      "    events = [(0.0, '')]",
      "for t, data in events:",
      "    for ch in strip_ansi(data):",
      "        feed(ch)",
      "    snap = snapshot()",
      "    if snap != prev:",
      "        frames.append((t, snap))",
      "        prev = snap",
      "",
      "if not frames:",
      "    frames = [(0.0, '')]",
      "",
      "# Adjusted timeline: enforce a per-frame minimum so fast casts",
      "# (events emitted within microseconds of each other) still",
      "# produce a visible build-up. Each frame starts no earlier than",
      "# the previous frame's start + min_frame_sec; honest spacings",
      "# already exceeding the floor are preserved.",
      "scheduled = []",
      "cursor_t = 0.0",
      "for i, (orig_t, snap) in enumerate(frames):",
      "    start_t = max(orig_t, cursor_t)",
      "    scheduled.append((start_t, snap))",
      "    cursor_t = start_t + min_frame_sec",
      "frames = scheduled",
      "",
      "last_event_orig = events[-1][0] if events else 0.0",
      "last_frame_start = frames[-1][0]",
      "# Total must cover (a) the last original event + tail_pad,",
      "# (b) the min duration floor, AND (c) the last scheduled frame",
      "# start + tail_pad so the final state holds long enough to read.",
      "total_sec = max(last_event_orig + tail_pad_sec, min_dur_sec, last_frame_start + tail_pad_sec)",
      "",
      "font = ImageFont.truetype(font_path, FONT_SIZE)",
      "title_font = ImageFont.truetype(font_path, TITLE_SIZE)",
      "",
      "def render(state_text):",
      "    img = Image.new('RGB', (W, H), BG)",
      "    draw = ImageDraw.Draw(img)",
      "    if title:",
      "        draw.text((X_PAD, Y_TITLE), title, font=title_font, fill=TITLE_FG)",
      "    draw.multiline_text((X_PAD, Y_PAD), state_text, font=font, fill=FG, spacing=LINE_SPACING)",
      "    return img",
      "",
      "os.makedirs(out_dir, exist_ok=True)",
      "ffconcat = ['ffconcat version 1.0']",
      "written = 0",
      "for i, (start_t, snap) in enumerate(frames):",
      "    end_t = frames[i+1][0] if i+1 < len(frames) else total_sec",
      "    duration = end_t - start_t",
      "    if duration <= 0:",
      "        continue",
      "    png_path = os.path.join(out_dir, f'f-{written:04d}.png')",
      "    render(snap).save(png_path)",
      "    ffconcat.append(f\"file '{png_path}'\")",
      "    ffconcat.append(f'duration {duration:.3f}')",
      "    written += 1",
      "",
      "if written == 0:",
      "    # Single empty frame for the full duration.",
      "    png_path = os.path.join(out_dir, 'f-0000.png')",
      "    render('').save(png_path)",
      "    ffconcat.append(f\"file '{png_path}'\")",
      "    ffconcat.append(f'duration {total_sec:.3f}')",
      "    ffconcat.append(f\"file '{png_path}'\")",
      "else:",
      "    # ffmpeg concat-demuxer quirk: last file's duration only",
      "    # applies if the file is re-referenced after it.",
      "    last_png = os.path.join(out_dir, f'f-{written-1:04d}.png')",
      "    ffconcat.append(f\"file '{last_png}'\")",
      "",
      "with open(os.path.join(out_dir, 'frames.ffconcat'), 'w') as f:",
      "    f.write('\\n'.join(ffconcat) + '\\n')",
      "",
      "sys.stdout.write(f'{total_sec:.3f}')",
    ].join("\n");

    const tailPadSec = ((opts?.tailPadMs ?? 700) / 1000).toFixed(3);
    const minDurSec = ((opts?.minDurationMs ?? 1500) / 1000).toFixed(3);
    const minFrameSec = ((opts?.minFrameMs ?? 50) / 1000).toFixed(3);
    const widthChars = String(opts?.widthChars ?? 120);
    const visibleLines = String(opts?.maxLines ?? 28);
    const title = opts?.title ?? "";

    const totalSecOut = await runChildCapture(pythonPath, [
      "-c",
      py,
      castPath,
      fontPath,
      tmp,
      title,
      widthChars,
      visibleLines,
      tailPadSec,
      minDurSec,
      minFrameSec,
    ]);
    const totalSec = Number(totalSecOut.trim());
    if (!Number.isFinite(totalSec) || totalSec <= 0) {
      throw new Error(
        `castToMp4: python+PIL renderer returned an unparseable duration: ${JSON.stringify(totalSecOut)}`,
      );
    }
    const ffconcatPath = join(tmp, "frames.ffconcat");
    if (!existsSync(ffconcatPath)) {
      throw new Error(`castToMp4: python+PIL did not write frames.ffconcat at ${ffconcatPath}`);
    }
    const totalSecStr = totalSec.toFixed(3);

    // concat demuxer with per-frame durations + canonical encode +
    // silent stereo audio sized to total_sec. fps=30 + format=yuv420p
    // resample so the output conforms to the canonical profile.
    const args = [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      ffconcatPath,
      "-f",
      "lavfi",
      "-t",
      totalSecStr,
      "-i",
      `anullsrc=channel_layout=stereo:sample_rate=${CANONICAL_SAMPLE_RATE}`,
      "-vf",
      `fps=${CANONICAL_FPS},format=yuv420p`,
      "-c:v",
      "libx264",
      "-profile:v",
      "baseline",
      "-level",
      "4.1",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(CANONICAL_FPS),
      "-g",
      String(CANONICAL_GOP),
      "-keyint_min",
      String(CANONICAL_GOP),
      "-sc_threshold",
      "0",
      "-c:a",
      "aac",
      "-ar",
      String(CANONICAL_SAMPLE_RATE),
      "-ac",
      String(CANONICAL_AUDIO_CHANNELS),
      "-b:a",
      "128k",
      "-t",
      totalSecStr,
      "-movflags",
      "+faststart",
      outPath,
    ];
    await runFfmpeg(ffmpegPath, args);
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

function runChildCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(new Error(`${cmd} exited ${code}\n--- ${cmd} stderr ---\n${stderr.slice(-4096)}`));
    });
  });
}

export async function probeDurationMs(path: string, ffprobePath = "ffprobe"): Promise<number> {
  const out = await runFfprobe(ffprobePath, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=nw=1:nk=1",
    path,
  ]);
  const trimmed = out.trim();
  const sec = Number(trimmed);
  if (!Number.isFinite(sec) || sec < 0) {
    throw new Error(`probeDurationMs: unexpected ffprobe output: ${JSON.stringify(trimmed)}`);
  }
  return Math.round(sec * 1000);
}

export class FfmpegCompositor implements Compositor {
  constructor(public ffmpegPath = "ffmpeg") {}

  // D21 canonical profile. Pad-to-fit-16:9 so an arbitrary input aspect
  // doesn't get cropped. Always inject silent stereo so every canonical
  // mp4 has matching audio stream metadata (concat -c copy depends on
  // identical stream layout).
  //
  // Video padding: agent-browser's WebM for a fast browser batch contains
  // only the frames captured between `record start` and `record stop` —
  // often ~100 ms even when the action wall-clock was longer. Without
  // padding, the canonical mp4 ends up with a video stream much shorter
  // than its audio/container, and concat-stream-copied final mp4s have
  // their video ending early. Probe the WebM duration first; pad the
  // video stream via `tpad=stop_mode=clone` up to `CANONICAL_MIN_VIDEO_MS`
  // (or the WebM's own length, whichever is longer); cap audio via `-t`
  // to the same target so the resulting mp4 has video and audio matching.
  async transcodeToCanonical(webmPath: string, mp4OutPath: string): Promise<void> {
    let webmMs = 0;
    try {
      webmMs = await probeDurationMs(webmPath);
    } catch {
      // If probing fails (corrupt webm, empty file, etc.), let ffmpeg
      // report the real error. tpad still safely no-ops with stop=0.
      webmMs = 0;
    }
    const targetMs = Math.max(webmMs, CANONICAL_MIN_VIDEO_MS);
    const padMs = Math.max(0, targetMs - webmMs);
    const padSec = (padMs / 1000).toFixed(3);
    const targetSec = (targetMs / 1000).toFixed(3);

    const vf = [
      `scale=${CANONICAL_WIDTH}:${CANONICAL_HEIGHT}:force_original_aspect_ratio=decrease`,
      `pad=${CANONICAL_WIDTH}:${CANONICAL_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black`,
      "setsar=1",
      `fps=${CANONICAL_FPS}`,
      // tpad with stop_duration=0 is a no-op (cheap path); with >0 it
      // clones the last decoded frame to extend the stream.
      `tpad=stop_mode=clone:stop_duration=${padSec}`,
      "format=yuv420p",
    ].join(",");

    const args = [
      "-y",
      "-i",
      webmPath,
      "-f",
      "lavfi",
      "-t",
      targetSec,
      "-i",
      `anullsrc=channel_layout=stereo:sample_rate=${CANONICAL_SAMPLE_RATE}`,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "libx264",
      "-profile:v",
      "baseline",
      "-level",
      "4.1",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-vf",
      vf,
      "-r",
      String(CANONICAL_FPS),
      "-g",
      String(CANONICAL_GOP),
      "-keyint_min",
      String(CANONICAL_GOP),
      "-sc_threshold",
      "0",
      "-c:a",
      "aac",
      "-ar",
      String(CANONICAL_SAMPLE_RATE),
      "-ac",
      String(CANONICAL_AUDIO_CHANNELS),
      "-b:a",
      "128k",
      "-t",
      targetSec,
      "-movflags",
      "+faststart",
      mp4OutPath,
    ];

    await runFfmpeg(this.ffmpegPath, args);
  }

  // Mux a canonical (silent) video.mp4 with a narration audio track
  // into a single mp4 that still conforms to the D21 canonical profile.
  //
  // Duration contract: output = max(videoMs, audioMs). Narration is
  // never truncated; if the recorded action ran shorter than the spoken
  // line, the last video frame is cloned to fill the gap. If the
  // narration is shorter than the video, silence pads the audio tail.
  // (The old -shortest behavior clipped the output to the shorter of
  // the two — which sized embed-manifest steps to the silent webm
  // rather than the narration, hiding most of the spoken audio.)
  //
  // Video stream: stream-copied when audio fits inside video; re-encoded
  //   with canonical params (tpad clone) only when narration outlasts
  //   the recorded action. Either way, the muxed mp4 stays
  //   concat-stream-copy compatible with siblings.
  // Audio stream: re-encoded to AAC 48 kHz stereo so the resulting mp4
  //   keeps identical audio-stream metadata to other canonical
  //   segments. Padded with silence when the source is shorter than
  //   the video.
  // Subtitles: VTT is kept as a sidecar file at the architecture's
  //   `subs.vtt` path; v1 does NOT mux as mov_text because viewers
  //   render the transcript pane from the standalone VTT (D11).
  //   `subtitlePath` is accepted in the surface for forward
  //   compatibility but is a no-op in v1.
  async muxSegment(opts: MuxOpts): Promise<{ mp4Path: string }> {
    if (!opts.videoPath) {
      throw new Error("FfmpegCompositor.muxSegment: videoPath is required");
    }
    if (!opts.outPath) {
      throw new Error("FfmpegCompositor.muxSegment: outPath is required");
    }

    // No audio supplied: silent canonical stereo, sized to video.
    if (!opts.audioPath) {
      const args = [
        "-y",
        "-i",
        opts.videoPath,
        "-f",
        "lavfi",
        "-i",
        `anullsrc=channel_layout=stereo:sample_rate=${CANONICAL_SAMPLE_RATE}`,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-ar",
        String(CANONICAL_SAMPLE_RATE),
        "-ac",
        String(CANONICAL_AUDIO_CHANNELS),
        "-b:a",
        "128k",
        "-shortest",
        "-movflags",
        "+faststart",
        opts.outPath,
      ];
      await runFfmpeg(this.ffmpegPath, args);
      void opts.subtitlePath;
      return { mp4Path: opts.outPath };
    }

    const videoMs = await probeDurationMs(opts.videoPath);
    const audioMs = await probeDurationMs(opts.audioPath);

    if (audioMs <= videoMs) {
      // Cheap path: video stream-copied, audio padded with silence to
      // match video length so the embed-manifest sizing reflects video.
      const targetSec = (videoMs / 1000).toFixed(3);
      const args = [
        "-y",
        "-i",
        opts.videoPath,
        "-i",
        opts.audioPath,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-ar",
        String(CANONICAL_SAMPLE_RATE),
        "-ac",
        String(CANONICAL_AUDIO_CHANNELS),
        "-b:a",
        "128k",
        "-af",
        `apad=whole_dur=${targetSec},atrim=0:${targetSec},asetpts=PTS-STARTPTS`,
        "-movflags",
        "+faststart",
        opts.outPath,
      ];
      await runFfmpeg(this.ffmpegPath, args);
      void opts.subtitlePath;
      return { mp4Path: opts.outPath };
    }

    // Audio outlasts video: clone the last video frame to fill the gap.
    // tpad requires re-encode, so the entire video stream gets canonical
    // params applied — same encode params transcodeToCanonical uses, so
    // the result still concat-stream-copies with siblings.
    const extendSec = ((audioMs - videoMs) / 1000).toFixed(3);
    const args = [
      "-y",
      "-i",
      opts.videoPath,
      "-i",
      opts.audioPath,
      "-filter_complex",
      `[0:v]tpad=stop_mode=clone:stop_duration=${extendSec},fps=${CANONICAL_FPS},format=yuv420p,setsar=1[v]`,
      "-map",
      "[v]",
      "-map",
      "1:a:0",
      "-c:v",
      "libx264",
      "-profile:v",
      "baseline",
      "-level",
      "4.1",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(CANONICAL_FPS),
      "-g",
      String(CANONICAL_GOP),
      "-keyint_min",
      String(CANONICAL_GOP),
      "-sc_threshold",
      "0",
      "-c:a",
      "aac",
      "-ar",
      String(CANONICAL_SAMPLE_RATE),
      "-ac",
      String(CANONICAL_AUDIO_CHANNELS),
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      opts.outPath,
    ];
    await runFfmpeg(this.ffmpegPath, args);
    void opts.subtitlePath;
    return { mp4Path: opts.outPath };
  }

  // Concat demuxer with -c copy. Inputs MUST already be canonical
  // (transcodeToCanonical applied). Concat list lives in a tmp file
  // (ffmpeg concat demuxer requires it on disk).
  async concatSegments(segments: SegmentRef[], opts: ConcatOpts): Promise<{ mp4Path: string }> {
    if (segments.length === 0) {
      throw new Error("concatSegments: no segments");
    }
    if (segments.length === 1) {
      // Single-segment fast-path: copy the only segment to outPath.
      const args = [
        "-y",
        "-i",
        segments[0]!.mp4Path,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        opts.outPath,
      ];
      await runFfmpeg(this.ffmpegPath, args);
      return { mp4Path: opts.outPath };
    }

    const work = mkdtempSync(join(tmpdir(), "open-take-concat-"));
    const listPath = join(work, "list.txt");
    // ffmpeg concat demuxer: lines of `file 'path'`. Single-quote the
    // path and escape embedded single quotes per ffmpeg's docs.
    const escapePath = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;
    const list = segments.map((s) => `file ${escapePath(s.mp4Path)}`).join("\n") + "\n";
    writeFileSync(listPath, list);

    try {
      const args = [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        opts.outPath,
      ];
      await runFfmpeg(this.ffmpegPath, args);
      return { mp4Path: opts.outPath };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  // Compose.zoom — first compositor effect beyond transcode + concat.
  // ffmpeg `zoompan` filter applied over `durationMs` worth of frames,
  // centered on the bbox center. Output preserves the canonical
  // profile so the result still concats stream-copy.
  //
  // The bbox is in source-video pixels (matches action-bboxes.json
  // coordinates). `scale` is the target zoom multiplier; we ramp from
  // 1.0 to `scale` over the zoom window, then hold for the rest of
  // the segment. Pre-window frames are passed through unchanged.
  //
  // Implementation notes:
  //   - zoompan operates on FPS-converted frames. We pin to the
  //     canonical 30 fps so frame counts are predictable.
  //   - The output frame is the same size as the canonical profile so
  //     the result still concats stream-copy with siblings.
  //   - We avoid `setpts` math by computing zoompan's frame-index
  //     window directly: `zoompan` is given the full source as input
  //     and produces a 1080p output with a per-frame zoom value.
  async zoom(input: string, region: BBox, scale: number, durationMs: number): Promise<string> {
    if (scale <= 1 || !Number.isFinite(scale)) {
      throw new Error(`FfmpegCompositor.zoom: scale must be > 1, got ${scale}`);
    }
    if (durationMs <= 0 || !Number.isFinite(durationMs)) {
      throw new Error(`FfmpegCompositor.zoom: durationMs must be > 0, got ${durationMs}`);
    }
    const [bx, by, bw, bh] = region;
    const cx = bx + bw / 2;
    const cy = by + bh / 2;

    const zoomFrames = Math.max(1, Math.round((durationMs / 1000) * CANONICAL_FPS));
    // zoompan's per-frame zoom expression. Linear ramp from 1 to scale
    // over the first zoomFrames; hold at `scale` thereafter. `on` is
    // the output frame index inside zoompan.
    const z =
      `if(lte(on,${zoomFrames}), ` + `1 + (${scale - 1}) * on/${zoomFrames}, ` + `${scale})`;

    // zoompan's pan expressions are in source-pixel coordinates pre-
    // zoom. Center the window on (cx, cy) so the zoom feels anchored
    // to the bbox; clamp inside the source so we don't pan off frame.
    const xExpr = `clip(${cx} - (iw/zoom)/2, 0, iw - iw/zoom)`;
    const yExpr = `clip(${cy} - (ih/zoom)/2, 0, ih - ih/zoom)`;

    // Output stays at canonical resolution.
    const outSize = `${CANONICAL_WIDTH}x${CANONICAL_HEIGHT}`;

    // Total output frames: at least zoomFrames; pad with a hold of the
    // final zoomed frame so the full segment isn't truncated. We pass
    // the SOURCE duration through by setting `d=1` (zoompan default) and
    // letting the input's actual frame count drive the loop, but we
    // also need to ensure the output runs at least `zoomFrames` frames
    // long. With `d=1` zoompan emits one frame per input frame, so the
    // segment length is preserved.
    const vf = [
      `fps=${CANONICAL_FPS}`,
      `zoompan=z='${z}':x='${xExpr}':y='${yExpr}':d=1:s=${outSize}:fps=${CANONICAL_FPS}`,
      "setsar=1",
      "format=yuv420p",
    ].join(",");

    const work = mkdtempSync(join(tmpdir(), "open-take-zoom-"));
    const outPath = join(work, "zoomed.mp4");
    const args = [
      "-y",
      "-i",
      input,
      "-c:v",
      "libx264",
      "-profile:v",
      "baseline",
      "-level",
      "4.1",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-vf",
      vf,
      "-r",
      String(CANONICAL_FPS),
      "-g",
      String(CANONICAL_GOP),
      "-keyint_min",
      String(CANONICAL_GOP),
      "-sc_threshold",
      "0",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      outPath,
    ];
    await runFfmpeg(this.ffmpegPath, args);
    return outPath;
  }

  // Mix N audio tracks down to one MP3. Used when a step combines
  // narration with browser/terminal beeps; v1 callers usually mix just
  // one track (narration) so this is a passthrough in that case.
  //
  // amix's `normalize=0` keeps the audio at unity gain instead of
  // attenuating proportionally to input count — saves us from
  // surprise volume drops when stacking narration with a quiet beep.
  // Per-track `gainDb` rides on a `volume` filter that feeds amix.
  async mixAudio(tracks: AudioTrackRef[]): Promise<string> {
    if (tracks.length === 0) {
      throw new Error("FfmpegCompositor.mixAudio: tracks is empty");
    }
    const work = mkdtempSync(join(tmpdir(), "open-take-mix-"));
    const outPath = join(work, "mixed.mp3");

    if (tracks.length === 1) {
      const t = tracks[0]!;
      const gain = t.gainDb ?? 0;
      const args: string[] = ["-y", "-i", t.path];
      if (gain !== 0) {
        args.push("-af", `volume=${gain}dB`);
      }
      args.push(
        "-c:a",
        "libmp3lame",
        "-b:a",
        "128k",
        "-ar",
        String(CANONICAL_SAMPLE_RATE),
        outPath,
      );
      await runFfmpeg(this.ffmpegPath, args);
      return outPath;
    }

    const args: string[] = ["-y"];
    for (const t of tracks) {
      args.push("-i", t.path);
    }
    const filterParts: string[] = [];
    for (let i = 0; i < tracks.length; i++) {
      const gain = tracks[i]!.gainDb ?? 0;
      filterParts.push(`[${i}:a]volume=${gain}dB[g${i}]`);
    }
    const inputs = tracks.map((_, i) => `[g${i}]`).join("");
    filterParts.push(`${inputs}amix=inputs=${tracks.length}:duration=longest:normalize=0[out]`);
    args.push(
      "-filter_complex",
      filterParts.join(";"),
      "-map",
      "[out]",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      "-ar",
      String(CANONICAL_SAMPLE_RATE),
      outPath,
    );
    await runFfmpeg(this.ffmpegPath, args);
    return outPath;
  }
}
