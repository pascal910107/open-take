// The shutter's darkroom half: the renderer drew each output frame
// `schedule[n]` times at instants spread across the shutter (launch-scene.tsx,
// motion-speed.ts); this averages each group back into one frame — a moving
// edge becomes a smear instead of a strobe — and writes a film at the output
// rate for the delivery encode. Frames are averaged in 8-bit 4:2:0 YUV — the
// delivery's own format, and the native format of the JPEG screenshots — and
// written losslessly; a still frame (one sample) passes through untouched.

import { spawn } from "node:child_process";
import { resolveFfmpeg } from "./ffmpeg";

/** `raw` is a video file, or the ffmpeg input arguments of any other source
 *  (e.g. an image sequence: ["-framerate", "240", "-i", "shots/%07d.png"]). */
export async function accumulateShutter(
  raw: string | readonly string[],
  out: string,
  schedule: readonly number[],
  output: { width: number; height: number; fps: number },
  /** the source is full-range YUV (JPEG screenshots): bring it to the
   *  limited range the delivery expects, or cream turns white */
  opts: { fullRange?: boolean } = {},
): Promise<void> {
  const ffmpeg = await resolveFfmpeg();
  const { width, height, fps } = output;
  const frameBytes = (width * height * 3) / 2; // yuv420p: a full luma plane, two quarter chroma planes
  const input = typeof raw === "string" ? ["-i", raw] : [...raw];
  const decoder = spawn(
    ffmpeg,
    [
      "-v",
      "error",
      ...input,
      ...(opts.fullRange ? ["-vf", "scale=in_range=pc:out_range=tv"] : []),
      "-f",
      "rawvideo",
      "-pix_fmt",
      "yuv420p",
      "-",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const encoder = spawn(
    ffmpeg,
    [
      "-y",
      "-v",
      "error",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "yuv420p",
      "-s",
      `${width}x${height}`,
      "-r",
      String(fps),
      "-i",
      "-",
      // lossless: the delivery encode is the only lossy step
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-qp",
      "0",
      "-pix_fmt",
      "yuv420p",
      out,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  const errors: string[] = [];
  // a dead encoder surfaces through the write callbacks; its EPIPE must not crash the process
  encoder.stdin!.on("error", (e) => errors.push(`encode stdin: ${e.message}`));
  decoder.stderr.on("data", (d) => errors.push(`decode: ${d}`));
  encoder.stderr.on("data", (d) => errors.push(`encode: ${d}`));
  const exited = (p: ReturnType<typeof spawn>) =>
    new Promise<number>((res) => p.on("close", (code) => res(code ?? 1)));
  const decoded = exited(decoder),
    encoded = exited(encoder);
  const write = (buf: Buffer) =>
    new Promise<void>((res, rej) => encoder.stdin!.write(buf, (e) => (e ? rej(e) : res())));

  const frame = Buffer.alloc(frameBytes);
  // ≤ 16 samples × 255 fits a Uint16
  const sum = new Uint16Array(frameBytes);
  const averaged = Buffer.alloc(frameBytes);
  let filled = 0,
    n = 0,
    k = 0;

  // Revideo may render a trailing frame past the requested range (it rounds
  // the range end); a frame or two past the schedule is that, not a mismatch.
  let extra = 0;
  const onFrame = async () => {
    const samples = schedule[n];
    if (samples === undefined) {
      extra++;
      return;
    }
    if (samples === 1) {
      await write(frame);
      n++;
      return;
    }
    if (k === 0) sum.set(frame);
    else for (let i = 0; i < frameBytes; i++) sum[i]! += frame[i]!;
    if (++k < samples) return;
    await flush(samples);
  };
  const flush = async (samples: number) => {
    const half = samples >> 1;
    for (let i = 0; i < frameBytes; i++) averaged[i] = ((sum[i]! + half) / samples) | 0;
    await write(averaged);
    n++;
    k = 0;
  };

  try {
    for await (const chunk of decoder.stdout as AsyncIterable<Buffer>) {
      let offset = 0;
      while (offset < chunk.length) {
        const take = Math.min(chunk.length - offset, frameBytes - filled);
        chunk.copy(frame, filled, offset, offset + take);
        filled += take;
        offset += take;
        if (filled === frameBytes) {
          await onFrame();
          filled = 0;
        }
      }
    }
    // a render cut short inside the last frame: average the samples it has
    if (k > 0 && n === schedule.length - 1) await flush(k);
  } catch (error) {
    // don't leave the decoder blocked on a full pipe behind a failed write
    decoder.kill("SIGKILL");
    encoder.kill("SIGKILL");
    await Promise.all([decoded, encoded]);
    throw new Error(
      `shutter: ${error instanceof Error ? error.message : String(error)}\n${errors.join("")}`,
    );
  } finally {
    encoder.stdin!.end();
  }
  const [dec, enc] = await Promise.all([decoded, encoded]);
  if (dec !== 0 || enc !== 0) throw new Error(`shutter: ffmpeg failed\n${errors.join("")}`);
  const rendered = schedule.slice(0, n).reduce((a, b) => a + b, 0) + k + extra;
  const expected = schedule.reduce((a, b) => a + b, 0);
  // at most one output frame short (the delivery pads it) and two renders over
  if (filled !== 0 || k !== 0 || n < schedule.length - 1 || extra > 2)
    throw new Error(
      `shutter: the renderer produced ${rendered} frames for a schedule of ${expected} renders (${schedule.length} output frames); refusing to guess which frame is which`,
    );
}
