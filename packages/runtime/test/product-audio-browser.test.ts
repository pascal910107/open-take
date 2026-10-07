// Product audio against real Chrome: a served page that beeps (an oscillator
// started in the same click handler that repaints the page) and plays a
// served WAV through an <audio> element. The take must come back with the
// sound on the capture timeline — each steady-state beep shortly after its
// click, the product's own delay kept — and the fetched WAV listed and saved.
// A silent page must leave no files at all, and opting out must too.
// Skips without Chrome for Testing.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureTake } from "../src/capture";
import { resolveChrome } from "../src/cdp";
import type { ProductSoundReport } from "../src/product-audio";
import type { TakePlan } from "../src/types";

const chrome = process.env.OPEN_TAKE_E2E_CHROME ?? resolveChrome();
const skip = chrome ? false : "no Chrome for Testing";

const BEEP = `<!doctype html><html><body style="margin:0;background:#fff">
<button id="beep" style="position:absolute;left:100px;top:100px;width:200px;height:80px">Beep</button>
<button id="media" style="position:absolute;left:100px;top:300px;width:200px;height:80px">Media</button>
<button id="muted" style="position:absolute;left:400px;top:100px;width:200px;height:80px">Muted</button>
<button id="routed" style="position:absolute;left:400px;top:300px;width:200px;height:80px">Routed</button>
<script>
let ctx;
document.getElementById("beep").addEventListener("click", () => {
  ctx = ctx || new AudioContext();
  document.body.style.background = document.body.style.background === "black" ? "white" : "black";
  const o = ctx.createOscillator(), g = ctx.createGain();
  g.gain.value = 0.5;
  o.connect(g); g.connect(ctx.destination);
  o.start(); o.stop(ctx.currentTime + 0.15);
});
document.getElementById("media").addEventListener("click", () => { new Audio("/tone.wav").play(); });
document.getElementById("muted").addEventListener("click", () => { const m = new Audio("/tone.wav"); m.muted = true; m.play(); });
document.getElementById("routed").addEventListener("click", () => {
  const el = new Audio("/tone.wav");
  ctx.createMediaElementSource(el).connect(ctx.destination);
  el.play();
});
</script></body></html>`;
const SILENT = `<!doctype html><html><body><button id="b">Quiet</button>
<script>document.getElementById("b").addEventListener("click", () => { document.body.style.background = "#eee"; });</script>
</body></html>`;

function toneWav(): Buffer {
  const sr = 44100;
  const n = sr / 5;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    b.writeInt16LE(Math.round(8000 * Math.sin((i / sr) * 2 * Math.PI * 660)), 44 + i * 2);
  return b;
}

async function serve(): Promise<{ server: Server; url: string }> {
  const wav = toneWav();
  const server = createServer((req, res) => {
    if (req.url === "/tone.wav")
      return res.writeHead(200, { "content-type": "audio/wav" }).end(wav);
    const html = req.url === "/silent" ? SILENT : BEEP;
    res.writeHead(200, { "content-type": "text/html" }).end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${addr.port}` };
}

/** onsets (ms) in a float WAV: the first loud sample after ≥50 ms of quiet */
function onsets(path: string): number[] {
  const buf = readFileSync(path);
  const sr = buf.readUInt32LE(24);
  const pcm = new Float32Array(buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + buf.length));
  const out: number[] = [];
  let last = -1e9;
  for (let i = 0; i < pcm.length / 2; i++) {
    if (Math.abs(pcm[2 * i]!) <= 0.02) continue;
    const t = (i / sr) * 1000;
    if (t - last > 50) out.push(t);
    last = t;
  }
  return out;
}

const take = async (url: string, steps: TakePlan["steps"], productAudio?: boolean) => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-pa-"));
  const log = await captureTake({ url, viewport: { width: 800, height: 600 }, steps } as TakePlan, {
    videoPath: join(dir, "capture.mp4"),
    captureScale: 1,
    ...(chrome ? { chromePath: chrome } : {}),
    ...(productAudio === false ? { productAudio: false } : {}),
  });
  return { dir, log };
};

test("a page's own sound is recorded onto the capture timeline", {
  skip,
  timeout: 120_000,
}, async () => {
  const { server, url } = await serve();
  const click = (selector: string, settleMs: number) => ({
    action: "click" as const,
    selector,
    settleMs,
  });
  const { dir, log } = await take(`${url}/`, [
    click("#beep", 600),
    click("#beep", 600),
    click("#media", 800),
    click("#beep", 600),
    click("#muted", 800),
    click("#routed", 800),
    click("#beep", 600),
  ]);
  try {
    const report = JSON.parse(
      readFileSync(join(dir, "product-sound.json"), "utf8"),
    ) as ProductSoundReport;
    assert.ok(report.audio, "sound was heard");
    assert.equal(report.audio.startMs, 0);
    assert.deepEqual(
      report.audio.sources.map((s) => s.kind).sort(),
      ["media", "webaudio"],
      "the AudioContext and the <audio> element were both tapped",
    );
    const heard = onsets(join(dir, "product-audio.wav"));
    const clicks = log.events.map((e) => e.tMs);
    assert.equal(clicks.length, 7);
    // beeps 2 and 4: the context is already running, so the sound follows its
    // click by the input dispatch + one render — measured ~60-80 ms here
    for (const i of [1, 3]) {
      const after = heard.filter((t) => t >= clicks[i]! - 20);
      assert.ok(after.length, `a sound after click ${i + 1}`);
      const d = after[0]! - clicks[i]!;
      assert.ok(d >= -20 && d < 250, `beep ${i + 1} at click + ${Math.round(d)} ms`);
    }
    // the media element's sound comes after its click (fetch + decode)
    assert.ok(
      heard.some((t) => t > clicks[2]! && t < clicks[3]!),
      "the <audio> element's sound",
    );
    // a muted element is not heard; one routed into the page's own graph is
    // heard once (at that graph's speakers), not twice
    assert.ok(
      !heard.some((t) => t > clicks[4]! && t < clicks[5]!),
      "the muted <audio> element stays unheard",
    );
    assert.ok(
      heard.some((t) => t > clicks[5]! && t < clicks[6]!),
      "the routed element is heard",
    );
    // blocks meet sample-exactly: the loudest thing is one 0.5 beep, no
    // spike where two ~85 ms blocks join
    assert.ok(
      report.audio.peakDbfs <= 20 * Math.log10(0.5) + 0.05,
      `peak ${report.audio.peakDbfs}`,
    );
    const wav = readFileSync(join(dir, "product-audio.wav"));
    const sr = wav.readUInt32LE(24);
    const pcm = new Float32Array(
      wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.length),
    );
    let routedPeak = 0;
    for (
      let i = Math.round((clicks[5]! / 1000) * sr);
      i < Math.round((clicks[6]! / 1000) * sr);
      i++
    )
      routedPeak = Math.max(routedPeak, Math.abs(pcm[2 * i]!));
    assert.ok(
      routedPeak > 0.2 && routedPeak < 0.3,
      `routed element peak ${routedPeak} (tone 0.244)`,
    );
    // the fetched WAV is listed and saved
    assert.equal(report.files.length, 1, "one URL, fetched three times, listed once");
    assert.equal(report.files[0]!.mimeType, "audio/wav");
    assert.equal(report.files[0]!.saved, "product-sounds/tone.wav");
    assert.ok(readFileSync(join(dir, "product-sounds/tone.wav")).equals(toneWav()));
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a silent page, or opting out, leaves no product sound files", {
  skip,
  timeout: 120_000,
}, async () => {
  const { server, url } = await serve();
  try {
    const quiet = await take(`${url}/silent`, [{ action: "click", selector: "#b", settleMs: 400 }]);
    for (const f of ["product-audio.wav", "product-sound.json", "product-sounds"])
      assert.equal(existsSync(join(quiet.dir, f)), false, `silent page: no ${f}`);
    assert.equal(quiet.log.events.length, 1, "the take itself is unaffected");
    await rm(quiet.dir, { recursive: true, force: true });

    const off = await take(
      `${url}/`,
      [{ action: "click", selector: "#beep", settleMs: 600 }],
      false,
    );
    for (const f of ["product-audio.wav", "product-sound.json"])
      assert.equal(existsSync(join(off.dir, f)), false, `opted out: no ${f}`);
    await rm(off.dir, { recursive: true, force: true });
  } finally {
    server.close();
  }
});
