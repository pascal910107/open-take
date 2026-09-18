// Reproducible, owned sample assets. No account, paid model, or stock soundtrack.
// Run from the repo after pnpm build: node examples/launch/prepare-assets.mjs

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTake } from "../../packages/runtime/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../out/launch-demo");
const assets = join(out, "assets");
await mkdir(assets, { recursive: true });

function wav(seconds, sample) {
  const rate = 44100,
    n = Math.round(seconds * rate),
    channels = 2;
  const b = Buffer.alloc(44 + n * channels * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * channels * 2, 40);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < channels; c++)
      b.writeInt16LE(
        Math.round(Math.max(-1, Math.min(1, sample(i / rate, c))) * 32767),
        44 + (i * channels + c) * 2,
      );
  return b;
}
const durationArg = process.argv.indexOf("--duration");
const musicDuration = durationArg >= 0 ? Number(process.argv[durationArg + 1]) : 26;
if (!Number.isFinite(musicDuration) || musicDuration < 1 || musicDuration > 3600)
  throw new Error("--duration must be a number between 1 and 3600 seconds");
const tau = Math.PI * 2;
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
const chords = [
  [50, 57, 61, 64],
  [47, 54, 57, 62],
  [43, 50, 57, 59],
  [45, 52, 59, 61],
];
await writeFile(
  join(assets, "music.wav"),
  wav(musicDuration, (t, c) => {
    let v = 0;
    for (let k = 0; k < Math.ceil(musicDuration / 4.5); k++) {
      const local = t - k * 4.5;
      if (local < 0 || local > 5.7) continue;
      const env = Math.min(1, local / 0.65) * Math.min(1, (5.7 - local) / 1.3);
      for (const [j, note] of chords[k % chords.length].entries()) {
        const f = hz(note) * (1 + (c ? 0.0008 : -0.0008));
        v +=
          env *
          (0.017 * Math.sin(tau * f * local + j * 0.4) + 0.004 * Math.sin(tau * f * 2 * local));
      }
    }
    // Restrained bell/pluck motif at 80 bpm, with a quiet octave echo.
    for (let k = Math.max(0, Math.floor(t / 0.75) - 3); k <= Math.floor(t / 0.75); k++) {
      const dt = t - k * 0.75;
      const note = [74, 69, 76, 73, 69, 66, 73, 71][k % 8];
      const env = (1 - Math.exp(-dt * 120)) * Math.exp(-dt * 4.2);
      v += 0.044 * env * (Math.sin(tau * hz(note) * dt) + 0.15 * Math.sin(tau * hz(note) * 2 * dt));
    }
    return v * Math.min(1, t / 0.8, (musicDuration - t) / 2.2);
  }),
);
await writeFile(
  join(assets, "ui.wav"),
  wav(0.55, (t) => {
    const env = Math.sin((Math.PI * t) / 0.55) ** 2 * Math.exp(-t * 5);
    return 0.12 * env * (Math.sin(tau * (520 * t + 220 * t * t)) + 0.25 * Math.sin(tau * 1040 * t));
  }),
);
await writeFile(
  join(assets, "tap.wav"),
  wav(0.22, (t) => 0.12 * (1 - Math.exp(-t * 400)) * Math.exp(-t * 35) * Math.sin(tau * 330 * t)),
);
console.log(`Original audio ready: ${assets}`);
if (process.argv.includes("--audio-only")) process.exit(0);

const html = await readFile(join(here, "fixture.html"));
const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((ok, fail) => {
  server.once("error", fail);
  server.listen(0, "127.0.0.1", ok);
});
const url = `http://127.0.0.1:${server.address().port}`;
const plan = {
  url,
  viewport: { width: 1440, height: 810 },
  startCursor: { x: 1060, y: 725 },
  steps: [
    { action: "wait", ms: 1000 },
    {
      action: "click",
      selector: "#approve",
      zoom: "always",
      settleMs: 1800,
      note: "Approve the final release checklist item",
    },
    {
      action: "click",
      selector: "#publish",
      zoom: "never",
      settleMs: 2200,
      note: "Publish the release and show the success receipt",
    },
    {
      action: "click",
      selector: "#publish",
      zoom: "never",
      settleMs: 2200,
      note: "Open the actual published release page",
    },
    { action: "wait", ms: 1500 },
  ],
};
await writeFile(join(out, "capture-plan.json"), JSON.stringify(plan, null, 2));
try {
  const result = await makeTake(plan, {
    outPath: join(out, "recording.mp4"),
    draft: true,
    logProgress: true,
    capture: { fps: 30, captureScale: 1 },
    planOpts: {
      output: { width: 1440, height: 810, fps: 30 },
      framing: {
        insetFrac: 0.97,
        cornerRadius: 14,
        background: { from: "#f5f2ea", to: "#f5f2ea", type: "solid" },
        shadow: { color: "rgba(23,46,40,.1)", blur: 20, offset: { x: 0, y: 6 } },
      },
    },
  });
  if (result.skipped.length) throw new Error(`Capture skipped: ${JSON.stringify(result.skipped)}`);
  await copyFile(result.mp4Path, join(assets, "recording.mp4"));
  console.log(
    JSON.stringify(
      {
        recording: join(assets, "recording.mp4"),
        capture: result.capturePath,
        events: result.composition.events.map((e) => ({ tMs: e.tMs, label: e.label })),
        durationMs: result.composition.durationMs,
      },
      null,
      2,
    ),
  );
} finally {
  await new Promise((ok) => server.close(ok));
}
