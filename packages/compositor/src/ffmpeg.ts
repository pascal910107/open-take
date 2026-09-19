// ffmpeg/ffprobe resolution — zero-config, the way Chrome is handled
// (runtime/src/cdp.ts ensureChrome): a system binary on PATH is used when it
// is at least as new as the builds we test on; otherwise a pinned static build
// is fetched once into ~/.open-take/ffmpeg and reused. Nothing is bundled in
// the npm package any more: the @ffmpeg-installer binaries it used to carry
// were ffmpeg 4.4 on macOS and 2018/2019 git snapshots on Linux and Windows,
// only ever ran on machines without a system ffmpeg, and that is where 0.5.0
// and 0.5.1 rendered nothing.
//
// The builds come from eugeneware/ffmpeg-static's GitHub release (the assets
// its npm package downloads at install time — used here without the package,
// so no postinstall script and nothing pnpm has to approve), pinned by tag
// and sha256. Overrides: OPEN_TAKE_FFMPEG / OPEN_TAKE_FFPROBE name a binary
// to use as is.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

/** The ffmpeg-static release the managed builds come from. */
export const FFMPEG_RELEASE = "b6.1.1";
const RELEASE_URL = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_RELEASE}/`;

/** The oldest ffmpeg among the managed builds (darwin-arm64 carries 6.0; the
 *  others 6.1–8.0). A system ffmpeg older than this is passed over: the
 *  managed builds are what the tests run on, and nothing older ever is. */
export const FFMPEG_FLOOR: readonly [number, number] = [6, 0];

/** sha256 of each gzipped asset, as published on the release. */
const ASSETS: Record<string, { ffmpeg: string; ffprobe: string }> = {
  "darwin-arm64": {
    ffmpeg: "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa",
    ffprobe: "d986a8ec7b030899fe66a8a288ed809a3543338705a3ce178cfb85869c5d80be",
  },
  "darwin-x64": {
    ffmpeg: "929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106",
    ffprobe: "d4da574d6e2e197bd259b47d69cf262df9e312af24ad960444f6d806d3d4c186",
  },
  "linux-x64": {
    ffmpeg: "bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa",
    ffprobe: "25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067",
  },
  "linux-arm64": {
    ffmpeg: "754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0",
    ffprobe: "2ab6aba60ee84412dff9188720703376cb4e7aaf7e0b5e43aa8249f2acae5bf8",
  },
  "linux-arm": {
    ffmpeg: "64b115a12f0ab77c277e3c418aae8b40ef881e75e746a0e2d066a206b9bc5172",
    ffprobe: "2471169c19fea00018413eebf188703c19ae5ab614477465146d4cdc7458b55d",
  },
  "linux-ia32": {
    ffmpeg: "169b27c078a8ecedb814cac67afccf15a9868d63e9d74ef86088adefaa500d00",
    ffprobe: "a75c55bcaad1b0e79f2201d82b9cc43903d950857615f91baaea5ce92d756e63",
  },
  "win32-x64": {
    ffmpeg: "8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77",
    ffprobe: "f309e6223ad89d2fe54bccd420a7709b66fd27540674e92309578ed491a43c8d",
  },
};

type Tool = "ffmpeg" | "ffprobe";

/** The release's asset key for this machine, or null when it ships none.
 *  Windows on ARM runs the x64 build under emulation. */
export function managedPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  const key = platform === "win32" && arch === "arm64" ? "win32-x64" : `${platform}-${arch}`;
  return key in ASSETS ? key : null;
}

/** Where the managed builds live: ~/.open-take/ffmpeg/<release>/<platform>. */
export function managedDir(): string {
  return join(
    homedir(),
    ".open-take",
    "ffmpeg",
    FFMPEG_RELEASE,
    managedPlatform() ?? "unsupported",
  );
}

const exeName = (tool: Tool): string => (process.platform === "win32" ? `${tool}.exe` : tool);

/** `[major, minor]` from an ffmpeg/ffprobe `-version` banner, or null when
 *  the build carries no release number (a git snapshot such as
 *  "N-47683-g0e8eb07980" or "2024-05-02-git-…") — treated as below the floor. */
export function parseFfmpegVersion(banner: string): [number, number] | null {
  const m = /^ff(?:mpeg|probe) version (?:n|v)?(\d+)\.(\d+)/m.exec(banner);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export const meetsFloor = (v: [number, number] | null): boolean =>
  !!v && (v[0] > FFMPEG_FLOOR[0] || (v[0] === FFMPEG_FLOOR[0] && v[1] >= FFMPEG_FLOOR[1]));

/** The `-version` banner of a binary, or null when it does not run. */
function versionBanner(bin: string): string | null {
  try {
    const r = spawnSync(bin, ["-version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return r.status === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

const runsOk = (bin: string): boolean => versionBanner(bin) !== null;

/** Some downloads land without an executable bit; repair at the point of
 *  use. Windows does not use POSIX execute bits. */
async function ensureExecutable(path: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const info = await stat(path);
    if ((info.mode & 0o111) === 0) await chmod(path, info.mode | 0o111);
  } catch {
    // Best effort. The normal spawn still returns the useful failure.
  }
}

export type ManagedOpts = {
  /** where to keep the build (tests point this at a temp dir) */
  cacheDir?: string;
  /** the fetch to download with (tests substitute a local one) */
  fetchImpl?: typeof fetch;
  /** progress lines go here (default: process.stderr) */
  log?: (line: string) => void;
};

/** Fetch one gzipped asset, verifying the published sha256 of the gz bytes
 *  while they stream, and land the executable atomically. */
async function download(
  tool: Tool,
  platform: string,
  dest: string,
  opts: ManagedOpts,
): Promise<void> {
  const url = `${RELEASE_URL}${tool}-${platform}.gz`;
  const expected = ASSETS[platform]![tool];
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const res = await (opts.fetchImpl ?? fetch)(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  // First run on this machine: a one-time ~20–30 MB fetch. Say so (and show
  // coarse progress) so `make` doesn't look like a silent stall.
  log(
    `open-take: downloading ${tool} (${FFMPEG_RELEASE}, one-time${total ? `, ${Math.round(total / 1e6)} MB` : ""}) → ${dest}`,
  );
  const hash = createHash("sha256");
  let received = 0;
  let lastPct = -1;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      received += chunk.length;
      if (total) {
        const pct = Math.floor((received / total) * 100);
        // throttle to whole-ten-percent steps to keep the log quiet
        if (pct >= lastPct + 10 || pct === 100) {
          lastPct = pct;
          log(`open-take: …${tool} download ${pct}%`);
        }
      }
      cb(null, chunk);
    },
  });
  await mkdir(join(dest, ".."), { recursive: true });
  const part = `${dest}.${process.pid}.part`;
  try {
    await pipeline(
      // the fetch body is a WHATWG stream typed for the DOM; Node's is the same thing
      Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream),
      meter,
      createGunzip(),
      createWriteStream(part),
    );
    const digest = hash.digest("hex");
    if (digest !== expected) {
      throw new Error(
        `${url}: sha256 ${digest} is not the pinned ${expected} — refusing to run it`,
      );
    }
    await chmod(part, 0o755);
    await rename(part, dest);
  } catch (e) {
    await rm(part, { force: true });
    throw e;
  }
  log(`open-take: ${tool} ready.`);
}

/** The managed build of a tool: on disk already, or fetched now. */
async function ensureManaged(tool: Tool, opts: ManagedOpts = {}): Promise<string> {
  const platform = managedPlatform();
  if (!platform) {
    throw new Error(`no ${tool} build is published for ${process.platform}-${process.arch}`);
  }
  const dir = opts.cacheDir ?? managedDir();
  const dest = join(dir, exeName(tool));
  if (existsSync(dest)) {
    await ensureExecutable(dest);
    if (runsOk(dest)) return dest;
    await rm(dest, { force: true }); // a cut-short or foreign file: fetch again
  }
  await download(tool, platform, dest, opts);
  if (!runsOk(dest)) throw new Error(`${dest} downloaded but does not run`);
  return dest;
}

/** The managed ffmpeg regardless of what is on PATH — the build every
 *  zero-config install runs, so tests run against it too. */
export const resolveManagedFfmpeg = (opts?: ManagedOpts): Promise<string> =>
  ensureManaged("ffmpeg", opts);
export const resolveManagedFfprobe = (opts?: ManagedOpts): Promise<string> =>
  ensureManaged("ffprobe", opts);

const cached: Partial<Record<Tool, Promise<string>>> = {};

async function resolveTool(tool: Tool): Promise<string> {
  const explicit = process.env[tool === "ffmpeg" ? "OPEN_TAKE_FFMPEG" : "OPEN_TAKE_FFPROBE"];
  if (explicit) {
    if (!runsOk(explicit))
      throw new Error(`${tool} at ${explicit} (from the environment) does not run`);
    return explicit;
  }
  const banner = versionBanner(tool);
  if (banner) {
    const version = parseFfmpegVersion(banner);
    if (meetsFloor(version)) return tool;
    process.stderr.write(
      `open-take: the ${tool} on PATH (${version ? version.join(".") : "no release number"}) is older than ${FFMPEG_FLOOR.join(".")} — using the managed build\n`,
    );
  }
  try {
    return await ensureManaged(tool);
  } catch (e) {
    throw new Error(
      `open-take: no ${tool} ≥ ${FFMPEG_FLOOR.join(".")} on PATH and the managed download failed (${(e as Error).message}). ` +
        `Install ffmpeg (brew install ffmpeg / apt install ffmpeg) or set OPEN_TAKE_${tool.toUpperCase()} to a binary.`,
    );
  }
}

function resolveCached(tool: Tool): Promise<string> {
  let p = cached[tool];
  if (!p) {
    p = resolveTool(tool).catch((e) => {
      cached[tool] = undefined; // a failed download may succeed next time
      throw e;
    });
    cached[tool] = p;
  }
  return p;
}

export const resolveFfmpeg = (): Promise<string> => resolveCached("ffmpeg");
export const resolveFfprobe = (): Promise<string> => resolveCached("ffprobe");

/** True when an `ffmpeg -encoders` table has a video-encoder ROW named
 *  `encoder` (" V....D libx264  ..."), not merely the name as a substring
 *  somewhere — descriptions repeat encoder names constantly. */
export function parseEncoders(encodersText: string, encoder: string): boolean {
  const escaped = encoder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*V\\S{5}\\s+${escaped}(?:\\s|$)`, "m").test(encodersText);
}

const encoderCache = new Map<string, Promise<boolean>>();

/** True when the RESOLVED ffmpeg (resolveFfmpeg — which may be a system
 *  binary lacking libvpx-vp9) offers the named video encoder. Cached per
 *  name; any failure is false, never a throw. */
export function ffmpegHasEncoder(name: string): Promise<boolean> {
  let cached = encoderCache.get(name);
  if (!cached) {
    cached = hasEncoderOnce(name).catch(() => false);
    encoderCache.set(name, cached);
  }
  return cached;
}

async function hasEncoderOnce(name: string): Promise<boolean> {
  const ffmpeg = await resolveFfmpeg();
  const text = await new Promise<string>((res, rej) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-encoders"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.on("error", rej);
    child.on("close", (code) =>
      code === 0 ? res(out) : rej(new Error(`ffmpeg -encoders exited ${code}`)),
    );
  });
  return parseEncoders(text, name);
}
