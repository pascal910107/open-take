import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const upstream = dirname(require.resolve("@revideo/renderer/package.json"));
const out = join(root, "dist");

await rm(out, { recursive: true, force: true });
await cp(join(upstream, "lib"), out, { recursive: true });

async function replaceOnce(path, from, to) {
  const source = await readFile(path, "utf8");
  const first = source.indexOf(from);
  if (first === -1 || source.indexOf(from, first + from.length) !== -1) {
    throw new Error(`Expected exactly one ${JSON.stringify(from)} in ${path}`);
  }
  await writeFile(path, source.replace(from, to));
}

await replaceOnce(
  join(out, "server", "render-video.js"),
  'require("puppeteer")',
  'require("puppeteer-core")',
);
await replaceOnce(
  join(out, "server", "render-video.d.ts"),
  "from 'puppeteer';",
  "from 'puppeteer-core';",
);
await replaceOnce(
  join(out, "server", "renderer-plugin.js"),
  "@revideo/renderer/lib/client/render",
  "@open-take/revideo-renderer/dist/client/render",
);
// Page-console passthrough stringifies non-primitive args as "JSHandle:…" —
// unactionable noise that buries real warnings (open-take issue #9). Forward
// them only under OPEN_TAKE_VERBOSE; string args (real messages) still pass.
// The `${…}` below are not our interpolations — they are the literal source
// text of the line we are matching and re-emitting inside revideo's build
// output, so they have to survive as characters.
await replaceOnce(
  join(out, "server", "render-video.js"),
  // biome-ignore lint/suspicious/noTemplateCurlyInString: matching revideo's source verbatim
  "console.log(`Worker ${id}: ${msg.args()[i]}`);",
  "if (process.env.OPEN_TAKE_VERBOSE || !String(message).startsWith('JSHandle')) {\n" +
    // biome-ignore lint/suspicious/noTemplateCurlyInString: re-emitting that same line
    "                console.log(`Worker ${id}: ${msg.args()[i]}`);\n" +
    "            }",
);
// The silent audio track revideo synthesises for a scene without sound goes
// through fluent-ffmpeg, whose capability check parses `ffmpeg -formats` with
// a two-column regex; FFmpeg ≥ 7 prints a third column for devices (" D d
// lavfi"), so the check misreads the name and refuses "-f lavfi" on every
// current ffmpeg ("Input format lavfi is not available"). Spawn ffmpeg
// directly for that one file — same arguments, same output, no capability
// lookup — through the path revideo was configured with.
await writeFile(
  join(out, "server", "silent-audio.js"),
  `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSilentAudioFile = createSilentAudioFile;
const child_process_1 = require("node:child_process");
const ffmpeg_1 = require("@revideo/ffmpeg");
function createSilentAudioFile(filePath, duration) {
    return new Promise((resolve, reject) => {
        const args = [
            "-y",
            "-loglevel", ffmpeg_1.ffmpegSettings.getLogLevel(),
            "-f", "lavfi",
            "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
            "-t", String(duration),
            filePath,
        ];
        const child = (0, child_process_1.spawn)(ffmpeg_1.ffmpegSettings.getFfmpegPath(), args, { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (d) => { stderr += d; });
        child.on("error", reject);
        child.on("close", (code) => code === 0
            ? resolve(filePath)
            : reject(new Error(\`ffmpeg (silent audio) exited \${code}: \${stderr.slice(-800)}\`)));
    });
}
`,
);
// Both call sites (the multi-worker collector and the single-worker path)
// reach it through the module object, so swap the one binding.
await replaceOnce(
  join(out, "server", "render-video.js"),
  'const ffmpeg_1 = require("@revideo/ffmpeg");',
  'const ffmpeg_1 = Object.assign({}, require("@revideo/ffmpeg"), require("./silent-audio"));',
);
await rm(join(out, "server", "tsconfig.tsbuildinfo"), { force: true });
