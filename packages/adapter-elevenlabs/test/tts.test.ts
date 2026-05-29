// Tests for the TTS adapters.
//
// Mock driver: exercises the end-to-end synthesize path (ffmpeg → MP3
// bytes) plus VTT cue generation. Skips when ffmpeg isn't on PATH —
// CI environments without ffmpeg can still run the rest of the suite.
//
// ElevenLabs driver: uses an injected fetch so we never hit the real
// API. Tests verify the request shape + alignment-to-VTT translation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  ElevenLabsDriver,
  MockTTSDriver,
  buildMockVtt,
  buildVttFromAlignment,
  buildVttFromWordCues,
  mockDurationOf,
} from "../src/index.ts";

function ffmpegOnPath(): boolean {
  try {
    const r = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
    return r.status === 0;
  } catch {
    return false;
  }
}

test("mockDurationOf: scales with text length, respects min", () => {
  assert.equal(mockDurationOf(""), 0.5);
  assert.equal(mockDurationOf("a"), 0.5);
  // 30 chars / 15 cps = 2.0s
  assert.equal(mockDurationOf("a".repeat(30)), 2);
  // 90 chars / 15 cps = 6.0s
  assert.equal(mockDurationOf("a".repeat(90)), 6);
});

test("buildMockVtt: emits one cue per word, cues sum to ~total", () => {
  const text = "First we drop a PNG into the workspace.";
  const total = mockDurationOf(text);
  const vtt = buildMockVtt(text, total);
  assert.match(vtt, /^WEBVTT\n\n/);
  // 8 words → 8 cues.
  const cueCount = (vtt.match(/-->/g) ?? []).length;
  assert.equal(cueCount, 8);
});

test("buildVttFromWordCues: empty input returns valid VTT skeleton", () => {
  assert.equal(buildVttFromWordCues([]), "WEBVTT\n\n");
});

test("buildVttFromAlignment: groups characters into words", () => {
  // "hi world" → 2 cues.
  const chars = ["h", "i", " ", "w", "o", "r", "l", "d"];
  const starts = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
  const ends = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
  const vtt = buildVttFromAlignment({
    characters: chars,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  });
  const cueCount = (vtt.match(/-->/g) ?? []).length;
  assert.equal(cueCount, 2);
  assert.match(vtt, /^WEBVTT\n\n1\n00:00:00\.000 --> 00:00:00\.200\nhi/);
  assert.match(vtt, /2\n00:00:00\.300 --> 00:00:00\.800\nworld/);
});

test("buildVttFromAlignment: handles trailing whitespace", () => {
  const chars = ["a", " "];
  const starts = [0.0, 0.1];
  const ends = [0.1, 0.2];
  const vtt = buildVttFromAlignment({
    characters: chars,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  });
  // One word "a"
  assert.equal((vtt.match(/-->/g) ?? []).length, 1);
});

test("ElevenLabsDriver: posts to with-timestamps and builds VTT", async () => {
  let capturedUrl: string | undefined;
  let capturedBody: unknown;
  let capturedHeaders: Record<string, string> | undefined;
  const responseJson = {
    audio_base64: Buffer.from([0x49, 0x44, 0x33, 0x04]).toString("base64"),
    alignment: {
      characters: ["h", "i"],
      character_start_times_seconds: [0, 0.1],
      character_end_times_seconds: [0.1, 0.2],
    },
  };
  const fakeFetch = (async (url: string, init: RequestInit | undefined) => {
    capturedUrl = url;
    capturedBody = JSON.parse(String(init?.body ?? "null"));
    capturedHeaders = init?.headers as Record<string, string>;
    return new Response(JSON.stringify(responseJson), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const driver = new ElevenLabsDriver({ apiKey: "test-key", fetchImpl: fakeFetch });
  const out = await driver.synthesize("hi", { voiceId: "voice-1" });

  assert.equal(capturedUrl, "https://api.elevenlabs.io/v1/text-to-speech/voice-1/with-timestamps");
  assert.deepEqual(capturedBody, { text: "hi", model_id: "eleven_multilingual_v2" });
  assert.equal(capturedHeaders?.["xi-api-key"], "test-key");
  assert.deepEqual(Array.from(out.audio), [0x49, 0x44, 0x33, 0x04]);
  assert.match(out.vtt, /^WEBVTT\n\n1\n00:00:00\.000 --> 00:00:00\.200\nhi/);
});

test("ElevenLabsDriver: surfaces lang as language_code", async () => {
  let capturedBody: { language_code?: string } | undefined;
  const fakeFetch = (async (_url: string, init: RequestInit | undefined) => {
    capturedBody = JSON.parse(String(init?.body ?? "null"));
    return new Response(JSON.stringify({ audio_base64: "" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const driver = new ElevenLabsDriver({ apiKey: "k", fetchImpl: fakeFetch });
  await driver.synthesize("hi", { voiceId: "v", lang: "ja" });
  assert.equal(capturedBody?.language_code, "ja");
});

test("ElevenLabsDriver: surfaces 4xx errors with status code", async () => {
  const fakeFetch = (async () => {
    return new Response("invalid voice", { status: 422 });
  }) as unknown as typeof fetch;

  const driver = new ElevenLabsDriver({ apiKey: "k", fetchImpl: fakeFetch });
  await assert.rejects(
    () => driver.synthesize("hi", { voiceId: "missing" }),
    /ElevenLabs 422.*invalid voice/,
  );
});

test("ElevenLabsDriver: missing voiceId throws", async () => {
  const driver = new ElevenLabsDriver({ apiKey: "k", fetchImpl: (async () => new Response()) as unknown as typeof fetch });
  await assert.rejects(() => driver.synthesize("hi", { voiceId: "" }), /voiceId is required/);
});

test("ElevenLabsDriver.modelVersion: encodes model id", () => {
  const driver = new ElevenLabsDriver({ apiKey: "k", modelId: "eleven_turbo_v2_5", fetchImpl: fetch });
  assert.equal(driver.modelVersion(), "elevenlabs-eleven_turbo_v2_5");
});

test("MockTTSDriver.modelVersion is mock-v0", () => {
  assert.equal(new MockTTSDriver().modelVersion(), "mock-v0");
});

test(
  "MockTTSDriver.synthesize: produces non-empty MP3 + word-aligned VTT (skipped if no ffmpeg)",
  { skip: !ffmpegOnPath() },
  async () => {
    const driver = new MockTTSDriver();
    const out = await driver.synthesize("Hello world.", { voiceId: "mock" });
    assert.ok(out.audio.length > 100, "MP3 bytes should be non-trivial");
    // MP3 frames usually start with 0xFF or 0x49 ("ID3" header). Either is fine.
    assert.ok(out.audio[0] === 0xff || out.audio[0] === 0x49, "first byte should be MP3 sync/ID3");
    assert.match(out.vtt, /^WEBVTT\n\n/);
    assert.equal((out.vtt.match(/-->/g) ?? []).length, 2);
  },
);
