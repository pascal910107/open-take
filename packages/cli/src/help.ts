// `open-take <verb> --help`, `open-take film <sub> --help`, `open-take help <verb> [<sub>]`.
//
// One verb's usage, cut out of the full USAGE text (its usage lines, its
// paragraph, and the shared flag notes for the flags it takes) so the two can
// never say different things; the flags it accepts come from the same
// allowlists the parser enforces. `film` and `launch` subcommands check their
// flags inside their own branch in cli.ts, so their lists live here — the
// test (help.test.ts) reads cli.ts and fails when the two drift apart.

/** the flags each `film <sub>` accepts — the same lists its `only(…)` call in cli.ts takes */
export const FILM_FLAGS: Record<string, string[]> = {
  init: ["--force", "--url", "--size", "--profile", "--no-steady", "--no-materials", "--from"],
  render: [
    "--out",
    "--root",
    "--audio",
    "--draft",
    "--no-blur",
    "--fps",
    "--size",
    "--duration",
    "--from",
    "--to",
    "--workers",
    "--supersample",
    "--keep-layers",
    "--into",
    "--no-report",
    "--verbose",
  ],
  mux: ["--audio", "--out"],
  picture: ["--scale", "--out"],
  still: [
    "--at",
    "--out",
    "--root",
    "--no-blur",
    "--size",
    "--supersample",
    "--keep-layers",
    "--verbose",
  ],
  sheet: ["--out", "--every", "--at"],
  beats: ["--out"],
  listen: ["--events", "--stems", "--out", "--every", "--clips", "--vs"],
  gallery: ["--blocks", "--with", "--subject", "--beats", "--out"],
  probe: ["--events", "--out", "--every", "--page", "--root", "--text-every", "--no-text"],
  look: [
    "--out",
    "--state",
    "--text",
    "--page",
    "--fonts",
    "--font-files",
    "--size",
    "--no-picture",
    "--json",
    "--verbose",
  ],
  check: ["--size", "--fps", "--json", "--page", "--root", "--verbose"],
};

/** the flags each `launch <sub>` reads */
export const LAUNCH_FLAGS: Record<string, string[]> = {
  init: ["--video"],
  compose: ["--out"],
  check: [],
  render: ["--out", "--draft", "--verbose"],
};

const SUPERSAMPLE = `--supersample <n> draws every frame at n× the pixels each way and averages
it down. Without it, a render draws at 3× only the frames where the page's
text moves under a device pixel a frame (Chrome places glyphs on whole
pixels, so it steps there), up to the nearest cut or fast move, and prints
where; --supersample 1 draws every frame at the film's own size. A slow push
on a screen is steadiest as a picture of it shot at twice the pixels
(\`film picture\`), rendered with --supersample 3.`;

const ROOT = `--root <dir> is the directory the page is served from (default: the current
directory when the page is inside it, else the page's own folder), for a page
that reaches files outside it.`;

const FILM_ABOUT: Record<string, string> = {
  init: `Copy the film kit into <dir>: kit/ (a camera with the take camera's motion, a
cursor, one timeline for picture and sound, saved screens and shot stills as
material, the sound's plumbing) and a page to start from. The kit is the
film's own code from then on. A file of yours that differs from the kit's is
kept and listed; --force replaces it.
  --url <url>        also open the product's page in open-take's Chrome and
                     keep it as a saved screen (states/home/ in <dir>), and
                     read its look into <dir>/look/; neither stops the init
  --size WxH         the page's CSS px for --url (default 1920x1080)
  --profile <name>   a signed-in Chrome profile for --url (as for make)
  --no-steady        keep the page at once for --url, not once what is on
                     screen stops changing (as for shoot)
  --no-materials     don't read the whole page for --url (as for shoot)
  --from <dir>       a shoot's folder or a take the film is made from: its
                     component inventory (components.json — each part's
                     values with where they were read, its relations) is
                     measured where missing and pointed to; nothing is
                     written into <dir> for it and the page to start from
                     is unchanged
With --url the saved screen's parts are measured too (states/home/components.json),
and the whole page is read: its images (saved in states/assets/), its copy
below the first screen too, and the page as one sheet
(states/home/materials.json, sheet.jpg; all of it: open-take materials <dir>).`,
  render: `Play the page on film time in headless Chrome and write an H.264 master
(default film.mp4) with measured motion blur and the page's soundtrack. The
page is driven by window.__render(t), or its own CSS/WAAPI/rAF/GSAP/video
animation (frame-exact); window.__film = { duration, audio, marks } describes
it. A <video> on the page is shown from its decoded frames.
  --audio <file>|none  the soundtrack instead of the page's own (none: silent)
  --draft              a quick copy to look at: half size, 30 fps unless
                       --fps, no motion blur, no supersampling
  --no-blur            no motion blur
  --keep-layers        keep the page's will-change hints (dropped by default:
                       a layer kept as one picture turns soft when enlarged)
  --size WxH           the page's CSS px (default 1920x1080)
  --fps <n>            the film's frame rate (default the page's, else 60)
  --out <film.mp4>     where the master goes (default film.mp4)
  --duration <s>       how long (default window.__film.duration)
  --from <s> --to <s>  only those seconds; with --into <film.mp4> they are put
                       into that master in place of its own seconds
  --workers <n>        Chrome pages rendering in parallel (default: chosen
                       for this machine)
  --verbose            pass every page console line through
  --no-report          don't print what was measured on the film when it
                       is done (a few seconds: where the product's words are
                       most of the text and their size on a phone, jumps not
                       declared as cuts and how far their content moved,
                       pictures shot while the product's screen was still
                       changing, live text moving under a pixel a frame —
                       \`film probe\` reads all of it and more)
${SUPERSAMPLE}
${ROOT}`,
  mux: `Put a new soundtrack under a rendered film without rendering the picture
again. --audio <file> or none (silent); --out (default: the film in place).`,
  picture: `Draw a saved screen (a take's states/<id>/state.html, or its folder) as a PNG at
--scale (default 2) picture px per screen px — material for a slow push that
stays steady (render it with --supersample 3). Default --out:
picture@<scale>x.png beside state.html.`,
  still: `Write PNG stills of the page at the given film times (--at 1.5,12), into --out
(default stills/). --size WxH (default 1920x1080), --no-blur, --keep-layers,
--verbose as for \`film render\`.
${SUPERSAMPLE}
${ROOT}`,
  sheet: `A timed contact sheet of any video: --every <s> between frames (default about
48 frames over the film) or --at <s>,<s>… for exact times. Default --out:
<film>.sheet.png.`,
  beats: `Read a piece of music (or a film's sound) as a grid to cut on and write
<name>.beats.json (or --out): tempo, beats, downbeats and bars, sections with
their energy, drops, onsets — each field measured, estimated (with a
confidence) or not detected. The kit's cut.js and audio.mjs (cutToBars) read
it.`,
  listen: `The film's sound (or a score alone) as information, into --out (default
<input>.listen/): listen.png (spectrum, loudness, onsets and beat grid,
sections, each stem's activity, the page's events, cuts and curves, marked
with the sheet's times), listen.md and listen.json (loudness, tempo,
sections, bars repeated verbatim, pauses, which events have no sound within
40 ms, cut-to-onset offsets) — each line measured, estimated or not detected,
never a grade.
  --events <events.json>  the page's events (default <input>.events.json when
                          it exists)
  --stems <dir>           one sound file per part: how many dB each event's
                          sound sits over the rest
  --clips                 solo/<stem>.m4a and mute/<stem>.m4a beside the report
  --vs <previous>         what changed against an earlier version (loudness,
                          tempo, onsets, sections, events that gained or lost a
                          sound, where the two differ most) + A/B clips in vs/
  --every <s>             the sheet's spacing, to mark the same times`,
  probe: `The film's picture as information, into --out (default <input>.probe/):
probe.png (how much the picture changes each frame, where no change is seen,
shots, small swaps, cuts per 5 s, the whole picture's zoom and movement and
where it turns back, cut-to-onset offsets, the page's beat sheet (tl.segment)
beside what happened, how much of the frame is text and how big it is on the
film and on a phone, when a subject leaves the frame, then before/after
thumbnails of every big change), probe.md and probe.json — each line
measured, estimated or not detected, no score.
Given a film folder, its page and the film.mp4 beside or in it are used.
  --page <page.html|dir>  the film's page: its text read on the film clock and
                          its beat sheet taken from it (--root as for render)
  --events <events.json>  the page's events (default <input>.events.json)
  --every <s>             the sheet's spacing, to mark the same times
  --text-every <s>        seconds between reads of text in the frames
                          (default 0.5; macOS text recognition, else an edge
                          count)
  --no-text               don't read the frames for text`,
  look: `Read the product's look off its real interface — a take, its states/ folder,
one saved screen, a URL, or a look.json written before — into --out (default
./look): every colour with how much of the screen it paints and where, an
estimate of the roles (bg, surface, text, muted, accent, on-accent, border),
the families the text is set in with their actual font files, the type sizes,
radii, shadows and the motion timings its CSS declares — look.json, look.css
and look.png (a specimen at film size), each part measured, estimated or not
detected, none of it a preset.
  --state s0,s3          only these saved screens
  --text <words>         check every character of the film's words against
                         those font files (CJK included)
  --page <page.html|dir> the same for the words on the film's page
  --fonts <dir>          write the font files the words need, cut down to
                         them, with a fonts.css
  --font-files <a,b>     more font files the film uses (checked and packaged)
  --size WxH             the page's CSS px for a URL (default 1920x1080)
  --no-picture           skip look.png
  --json                 print look.json instead of the summary
The kit's look.js fits text to a box, measures contrast and how big a size
reads on a phone.`,
  gallery: `Draw each block of the kit (the film folder's own kit/ when given, else the
kit this package ships) — motion, camera options, cut helpers — at six
instants with its value and speed over time, its default beside three other
settings: a PNG per block, index.md and gallery.json into --out (default
gallery/), every number measured on the function, none a target.
  --blocks rise,camera.shake,…  names, or groups (motion, camera, cut)
  --with <picture|state|take>   draw on the product's own picture, saved screen
                                or take instead of a neutral stand-in
  --subject <id|text|x,y,w,h>   the element of it the blocks move (default:
                                one chosen and said)
  --beats <beats.json>          draw the cut helpers on the film's own music`,
  check: `Measure a finished film: format, hitches, cadence, cuts, flashes (a few frames
unlike the frames on both sides), shots that start on near-blank frames, black
frames, loudness, clicks. With --page (the film's page; --root as for render)
it also reads the page over the film's time: text over text, text into a
small painted element, text cut by the frame's edge, and the smallest text on
screen (information, not a verdict). Each finding has a time; one the page
marks as intended (window.__film.marks = [{ at, until?, what? }]) is listed as
marked, not as a defect. --size/--fps: what the film should be. --json prints
the result as data. Exits 1 when a finding is an error.`,
};

const LAUNCH_ABOUT: Record<string, string> = {
  init: `Make <directory> (it must not exist) with assets/<video> copied in and a
starter launch.json around it, at the video's own frame rate.`,
  compose: `Build a launch composition from a brief JSON and write it to --out (refuses to
overwrite an existing file); asset paths are rebased to the output's folder.`,
  check: `Validate a launch.json (assets, motion, story) and list its issues; exits 1 on
an error. Takes no flags.`,
  render: `Check and render a launch.json to --out (default launch.mp4 beside it, or
launch.draft.mp4 with --draft). --verbose prints render progress.`,
};

/** true when the command line asks for help: `--help` or `-h` anywhere after the verb */
export const asksForHelp = (args: readonly string[]): boolean =>
  args.some((a) => a === "--help" || a === "-h");

type Entry = { head: string[]; lines: string[] };

/** the Usage: block's entries, each with its words after `open-take` */
function usageEntries(usage: string): Entry[] {
  const all = usage.split("\n");
  const start = all.indexOf("Usage:") + 1;
  const out: Entry[] = [];
  for (let i = start; i < all.length && all[i]!.trim(); i++) {
    const line = all[i]!;
    const m = /^ {2}open-take\s+(.*)$/.exec(line);
    if (m) out.push({ head: m[1]!.split(/\s+/), lines: [line] });
    else out.at(-1)?.lines.push(line);
  }
  return out;
}

/** a verb's own paragraph: `  <verb>  …` up to the next entry or blank line */
function paragraph(usage: string, verb: string): string[] {
  const all = usage.split("\n");
  const at = all.findIndex((l) => new RegExp(`^ {2}${verb}(\\s{2,}|$)`).test(l));
  if (at < 0) return [];
  const out = [all[at]!];
  for (let i = at + 1; i < all.length; i++) {
    const l = all[i]!;
    if (!l.trim() || /^ {2}\S/.test(l)) break;
    out.push(l);
  }
  return out;
}

/** the shared notes on a flag (`  --fps <n>   (make/ci) …`) that apply to this verb */
function flagNotes(usage: string, verb: string, accepted: readonly string[]): string[] {
  const all = usage.split("\n");
  const out: string[] = [];
  for (let i = 0; i < all.length; i++) {
    const m = /^ {2}(--[\w-]+)(?:\s+<[^>]+>)?\s+(?:\(([^)]*)\))?/.exec(all[i]!);
    if (!m || !accepted.includes(m[1]!)) continue;
    const verbs = m[2]?.split("/").map((v) => v.trim().split(/\s+/)[0]);
    if (verbs && !verbs.includes(verb)) continue;
    out.push(all[i]!);
    for (let j = i + 1; j < all.length && /^ {4,}\S/.test(all[j]!); j++) out.push(all[j]!);
  }
  return out;
}

const flagsLine = (flags: readonly string[]): string =>
  flags.length ? `Flags: ${flags.join(" ")}` : "Flags: none";

/**
 * The help for `words` ([verb] or [verb, sub]); the full usage when the verb
 * is unknown or absent. `flagsByCmd` is the parser's per-verb allowlist.
 */
export function helpText(
  usage: string,
  flagsByCmd: Record<string, readonly string[]>,
  words: readonly string[],
): string {
  const [verb, sub] = words;
  const entries = usageEntries(usage);
  if (!verb || !entries.some((e) => e.head[0] === verb)) return usage;
  const usageOf = (pick: (e: Entry) => boolean) =>
    ["Usage:", ...entries.filter(pick).flatMap((e) => e.lines)].join("\n");

  if (verb === "film" || verb === "launch") {
    const flags = verb === "film" ? FILM_FLAGS : LAUNCH_FLAGS;
    const about = verb === "film" ? FILM_ABOUT : LAUNCH_ABOUT;
    if (sub && sub in flags)
      return `${[
        usageOf((e) => e.head[0] === verb && e.head[1] === sub),
        about[sub]!,
        flagsLine(flags[sub]!),
      ].join("\n\n")}\n`;
    const intro = paragraph(usage, verb);
    return `${[
      usageOf((e) => e.head[0] === verb),
      ...(intro.length ? [intro.join("\n")] : []),
      `One subcommand's flags: open-take ${verb} <${Object.keys(flags).join("|")}> --help`,
    ].join("\n\n")}\n`;
  }

  const accepted = flagsByCmd[verb] ?? [];
  const intro = paragraph(usage, verb);
  const notes = flagNotes(usage, verb, accepted);
  return `${[
    usageOf((e) => e.head[0] === verb),
    ...(intro.length ? [intro.join("\n")] : []),
    flagsLine(accepted),
    ...(notes.length ? [notes.join("\n")] : []),
  ].join("\n\n")}\n`;
}
