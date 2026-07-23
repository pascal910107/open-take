// Dormant narration adapter: not wired into the current
// cli -> runtime -> compositor product path. Kept for the planned narration
// work, with its small contract colocated here until that integration exists.
//
// MockTTSDriver: silent MP3 (via ffmpeg lavfi) at a duration derived
// from text length, plus a word-aligned VTT. Useful in CI and for development
// without API keys.
//
// ElevenLabsDriver: real API call. Uses the `with-timestamps` endpoint
// (alignment per character) so we can build a character-accurate VTT
// for future transcript/subtitle support.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TTSOpts = {
  voiceId: string;
  lang?: string;
};

export interface TTSDriver {
  synthesize(text: string, opts: TTSOpts): Promise<{ audio: Uint8Array; vtt: string }>;
  modelVersion(): string;
}

// ----- shared helpers ------------------------------------------------

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

function fmtVttTime(sec: number): string {
  const value = Number.isFinite(sec) && sec >= 0 ? sec : 0;
  const h = Math.floor(value / 3600)
    .toString()
    .padStart(2, "0");
  const m = Math.floor((value % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const s = (value % 60).toFixed(3).padStart(6, "0");
  return `${h}:${m}:${s}`;
}

export type WordCue = { text: string; start: number; end: number };

export function buildVttFromWordCues(cues: WordCue[]): string {
  if (cues.length === 0) return "WEBVTT\n\n";
  const blocks = cues.map(
    (c, i) => `${i + 1}\n${fmtVttTime(c.start)} --> ${fmtVttTime(c.end)}\n${c.text}`,
  );
  return "WEBVTT\n\n" + blocks.join("\n\n") + "\n";
}

// Build a VTT from a character-aligned ElevenLabs response. Groups
// adjacent non-whitespace characters into words and emits one cue per
// word with the word's covering [start, end] interval. Whitespace
// becomes cue gaps. Exported for testing.
export function buildVttFromAlignment(alignment: {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}): string {
  const {
    characters,
    character_start_times_seconds: ss,
    character_end_times_seconds: es,
  } = alignment;
  const cues: WordCue[] = [];
  let cur: WordCue | null = null;
  for (let i = 0; i < characters.length; i++) {
    const c = characters[i] ?? "";
    const s = ss[i] ?? 0;
    const e = es[i] ?? s;
    if (/\s/.test(c)) {
      if (cur) {
        cues.push(cur);
        cur = null;
      }
      continue;
    }
    if (cur === null) {
      cur = { text: c, start: s, end: e };
    } else {
      cur.text += c;
      cur.end = e;
    }
  }
  if (cur) cues.push(cur);
  return buildVttFromWordCues(cues);
}

// ----- MockTTSDriver -------------------------------------------------

const DEFAULT_CHARS_PER_SECOND = 15;

export type MockTTSDriverOpts = {
  ffmpegPath?: string;
  charsPerSecond?: number;
  minDurationSec?: number;
};

export class MockTTSDriver implements TTSDriver {
  ffmpegPath: string;
  charsPerSecond: number;
  minDurationSec: number;

  constructor(opts: MockTTSDriverOpts = {}) {
    this.ffmpegPath = opts.ffmpegPath ?? "ffmpeg";
    this.charsPerSecond = opts.charsPerSecond ?? DEFAULT_CHARS_PER_SECOND;
    this.minDurationSec = opts.minDurationSec ?? 0.5;
  }

  async synthesize(text: string, _opts: TTSOpts): Promise<{ audio: Uint8Array; vtt: string }> {
    const durationSec = mockDurationOf(text, this.charsPerSecond, this.minDurationSec);
    const audio = await synthesizeSilence(this.ffmpegPath, durationSec);
    const vtt = buildMockVtt(text, durationSec);
    return { audio, vtt };
  }

  modelVersion(): string {
    return "mock-v0";
  }
}

export function mockDurationOf(
  text: string,
  charsPerSecond = DEFAULT_CHARS_PER_SECOND,
  minDurationSec = 0.5,
): number {
  const sec = text.length / Math.max(1, charsPerSecond);
  return Math.max(minDurationSec, Number(sec.toFixed(3)));
}

export function buildMockVtt(text: string, totalSec: number): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return "WEBVTT\n\n";
  const per = totalSec / words.length;
  const cues: WordCue[] = words.map((w, i) => ({
    text: w,
    start: Number((i * per).toFixed(3)),
    end: Number(((i + 1) * per).toFixed(3)),
  }));
  return buildVttFromWordCues(cues);
}

async function synthesizeSilence(ffmpegPath: string, sec: number): Promise<Uint8Array> {
  const work = mkdtempSync(join(tmpdir(), "open-take-mocktts-"));
  const outPath = join(work, "silent.mp3");
  try {
    await runFfmpeg(ffmpegPath, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=mono:sample_rate=24000",
      "-t",
      String(sec),
      "-c:a",
      "libmp3lame",
      "-b:a",
      "32k",
      outPath,
    ]);
    return new Uint8Array(readFileSync(outPath));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ----- ElevenLabsDriver ----------------------------------------------

export type ElevenLabsDriverOpts = {
  apiKey: string;
  modelId?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
};

const DEFAULT_MODEL_ID = "eleven_multilingual_v2";
const DEFAULT_API_BASE = "https://api.elevenlabs.io";

export class ElevenLabsDriver implements TTSDriver {
  apiKey: string;
  modelId: string;
  apiBase: string;
  private fetchImpl: typeof fetch;

  constructor(opts: ElevenLabsDriverOpts) {
    if (!opts.apiKey) throw new Error("ElevenLabsDriver: apiKey is required");
    this.apiKey = opts.apiKey;
    this.modelId = opts.modelId ?? DEFAULT_MODEL_ID;
    this.apiBase = opts.apiBase ?? DEFAULT_API_BASE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async synthesize(text: string, opts: TTSOpts): Promise<{ audio: Uint8Array; vtt: string }> {
    const voiceId = opts.voiceId;
    if (!voiceId) throw new Error("ElevenLabsDriver: opts.voiceId is required");
    const lang = opts.lang;

    const url = `${this.apiBase}/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps`;
    const body: Record<string, unknown> = {
      text,
      model_id: this.modelId,
    };
    if (lang) body.language_code = lang;

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "xi-api-key": this.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`ElevenLabs ${res.status}: ${errText.slice(0, 500)}`);
    }
    const j = (await res.json()) as ElevenLabsResponse;
    const audio = decodeBase64(j.audio_base64);
    const vtt = j.alignment ? buildVttFromAlignment(j.alignment) : "WEBVTT\n\n";
    return { audio, vtt };
  }

  modelVersion(): string {
    return `elevenlabs-${this.modelId}`;
  }
}

type ElevenLabsResponse = {
  audio_base64: string;
  alignment?: {
    characters: string[];
    character_start_times_seconds: number[];
    character_end_times_seconds: number[];
  };
};

function decodeBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}
