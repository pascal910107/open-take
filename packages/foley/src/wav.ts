// Minimal WAV I/O: 16/24/32-bit PCM and 32-bit float in; 16-bit PCM out.
// No ffmpeg in the loop — a cue sheet mixes to samples in-process.

export type Pcm = { sampleRate: number; channels: Float32Array[] };

export function decodeWav(buf: Buffer): Pcm {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("not a RIFF/WAVE file");
  let off = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | undefined;
  let data: Buffer | undefined;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      let format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const sampleRate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE carries the real format in the sub-format GUID
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24);
      fmt = { format, channels, sampleRate, bits };
    } else if (id === "data") data = buf.subarray(body, Math.min(buf.length, body + size));
    off = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error("WAV has no fmt/data chunk");
  const { format, channels, sampleRate, bits } = fmt;
  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < channels; c++) {
      const p = (i * channels + c) * bytes;
      let v: number;
      if (format === 3 && bits === 32) v = data.readFloatLE(p);
      else if (format === 1 && bits === 16) v = data.readInt16LE(p) / 32768;
      else if (format === 1 && bits === 24)
        v = ((data[p]! | (data[p + 1]! << 8) | (data[p + 2]! << 16)) << 8) / 2147483648;
      else if (format === 1 && bits === 32) v = data.readInt32LE(p) / 2147483648;
      else if (format === 1 && bits === 8) v = (data[p]! - 128) / 128;
      else throw new Error(`unsupported WAV format ${format} / ${bits}-bit`);
      out[c]![i] = v;
    }
  return { sampleRate, channels: out };
}

export function encodeWav(pcm: Pcm): Buffer {
  const channels = pcm.channels.length;
  const frames = pcm.channels[0]?.length ?? 0;
  const dataBytes = frames * channels * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(pcm.sampleRate, 24);
  buf.writeUInt32LE(pcm.sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  let p = 44;
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, pcm.channels[c]![i]!));
      buf.writeInt16LE(Math.round(v * 32767), p);
      p += 2;
    }
  return buf;
}

/** Linear resample (good enough for SFX pitch/rate changes). */
export function resample(x: Float32Array, ratio: number): Float32Array {
  if (ratio === 1) return x;
  const n = Math.max(1, Math.floor(x.length / ratio));
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = i * ratio;
    const j = Math.floor(s);
    const f = s - j;
    const a = x[Math.min(j, x.length - 1)]!;
    const b = x[Math.min(j + 1, x.length - 1)]!;
    y[i] = a + (b - a) * f;
  }
  return y;
}
