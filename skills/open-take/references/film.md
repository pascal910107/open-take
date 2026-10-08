# Films you write yourself

A launch or promo film is yours to make: what it shows, what it says, how it
moves and how it sounds. Write it the way you would build anything for the web
— a page, with HTML, CSS, SVG, canvas, WebGL, any library — and let open-take
do the parts that are plumbing: playing the page frame-exactly, motion blur,
encoding, measuring what you cannot see or hear.
open-take adds no look of its own: the story, the type, the colours, the
motion and the music are the film's author's, and so is how good the film is.

## One way to work

A path through a film, there when it helps. Any step can be skipped,
reordered or done another way; nothing checks that it was followed.

1. **What the product has.** What can be recorded (`make`), saved as a
   screen (`make --states`), what it really puts out — a number it works out,
   a file it makes, a sound — and what exists about it outside the app (its
   About page, repository, store listing, changelog). In earlier films the
   pace often followed the material more than the plan
   (`skill film material`).
2. **The main line** — what the film is about, in one sentence.
3. **A beat sheet**, if you keep one: `tl.segment` in `time.js` — what each
   stretch is meant to do, what moves, what holds, how it hands over to the
   next, what is heard. Free words; nothing grades them.
4. **A draft** — `film render --draft`, `film still`, `film sheet`.
5. **Look and listen** — `film probe`, `film listen`, `film check`: what the
   picture and the sound did, beside what the page declared, each line
   measured, estimated or not detected (`skill film checking`).
6. **The seconds that matter, as the master will show them** — a handoff, a
   whip, a burst of cuts: `film render --from --to`, blurred, alone.
7. **Change what you decide to change**, and go round 4–6 as often as it
   helps. The reports are there to see by, not to satisfy.
8. **The master.**

## What's there for…

Capabilities and where each is described; none of them is a step.

- a screen with more text than a viewer reads → one real part as a layer of
  its own (`lift`), the rest faded (`isolate`), the camera on one box
  (`cam.frame`) — `skill film material`
- the interface itself, sharp at any size, its parts separable → a saved
  screen: `make --states` (`<take>.take/states/<id>/state.html`; `open-take
  states` outlines a take's), a `shoot` still (each `s.still()` and the still
  an action ends on keep one by default, in `shots/states/<id>/`), or the
  product's page at `film init --url` (`states/home/`); `index.json` beside
  each lists every element — `skill film material`
- the real action, then its result → `clipEvents` (when the result showed,
  measured off the recording), `seam` (when the saved screen can stand in for
  the recording) — `skill film material`
- stills from a capture script of your own, with boxes and cursor → `shoot` —
  `skill film material`
- cuts on the music → `film beats`, `grid` (from a beats file or your own
  bpm), `matchCut`, `density`; a track edited by bars → `cutToBars`, `landOn`
  — `skill film cutting`
- the product's colours, fonts and type sizes → `film look`, `kit/look.js`
  (`fitText`, `contrast`, `readable`) — `skill film look`
- what each kit block does, on your own material → `film gallery --with` —
  `skill film checking`
- what the picture and the sound did → `film probe` (its text lane: how big
  the text reads on a phone, and where the product's own words are most of
  it), `film listen` (its grid as `grid({ bpm, offset })` for the page),
  `film check`, `film sheet`, `film still` — `skill film checking`
- a few seconds as the master shows them, a patch into the master, slow
  pushes over interface text without jitter (`film picture`,
  `--supersample`) → `skill film render`
- how the renderer plays a page (`__film`, `__render`, clocks) → `skill film
  page`
- the product's own sound from a take, a soundtrack → `skill film sound`
- films a viewer said he would post, segment by segment → `skill cases`

## Start

```sh
npx open-take film init film/     # kit/ and a page to start from
npx open-take film init film/ --url https://the.product/   # also its page as a saved screen and its look
```

With `--url` (and `--size`, `--profile` for a signed-in page) `film init`
first keeps the product's page as a saved screen in `states/home/` and reads
its look into `look/` (`film look`); the page it starts from names both in a
comment. Either one failing is a line, and the init goes on. Every verb
answers `--help` (`open-take film probe --help`, `open-take help shoot`) with
its usage and the flags it takes.

`kit/` holds plain functions — much of it what twelve films without it each
wrote again, and often got wrong. The page `film init` starts from imports
only `time.js` and lists the rest; its length is a placeholder.

- `camera.js` — say when to see what (`cam.frame(box, { arrive: 12 })`); the
  path is open-take's take camera, tuned by eye on recordings: the view itself
  moves, so what is framed heads for its place in a straight line; it is kept
  inside the content once, when asked, never mid-move. Seven of those films
  moved the centre and the zoom separately and clamped the centre every
  frame: the camera stopped short, then swung back. Defaults are measured (in
  0.73 s, out 1.34 s, what is framed fills 60 %); every move can set its own
  `dur` and `ease`, and a cut is `cam.cut(box, t)`. More is there when a
  film asks for it, each off until it is set: `camera({ lead })` (every move
  leaves and lands that much earlier; cuts stay put), `keepInside: false` (a
  view may go past the content), `zoom: "log"` (the width changes at an even
  pace in log space — long zooms do not rush their last part) — each also per
  move — and `handheld: { amp, rot, period, seed }` (a seeded hand that never
  repeats). `cam.shake(at, { amp, rot, dur, freq })` jolts it once;
  `cam.jitter(t)` is what the hand and the shakes add (`at(t)` leaves them
  out, so a 3D page adds them itself); `cam.depth(k)` is a layer at its own
  depth (1 moves with the content, 0 holds still, above 1 passes in front),
  with its own `transform(t)`, `toView`, `toContent`.
- `cursor.js` — say where it clicks, types or drags and when; it travels at
  the take cursor's pace (0.35 content widths a second, 0.30–0.85 s a leg,
  landing on the action), timed by what the viewer sees when zoomed in. What
  it looks like is yours.
- `motion.js` — moves as plain functions of time: give one t and when it
  starts, read back numbers, put them anywhere (CSS, canvas, WebGL). A closed-
  form spring (`spring`, `springVel`, `springSettle`, `settle`; `damping` is
  the ratio ζ, or say `overshoot`, or framer-style `stiffness`/`friction`);
  entrances and exits whose opacity follows the travel (`rise`/`riseOut`,
  `pop`/`popOut`, `drop`/`dropOut` with stretch and squash, `maskRise`/
  `maskOut` out of its own line, `type`/`untype`, and `typeTimes` — each
  character's time, for its sound); handoffs where one picture becomes the
  next (`morphRect` with `rectClip`/`inset`, `iris`, `zoomThrough` — one scale
  about a fixed point, `gather`, `hop`); contact (`press`, `impact`). Every
  default is an option of the call; any move can be written by hand instead:

  ```js
  import { rise, morphRect, rectClip } from "./kit/motion.js";
  const w = rise(t, 2.0);                                  // { x, y, opacity, p }
  const r = morphRect(t, 4, 4.5, buttonBox, { x: 0, y: 0, w: 1920, h: 1080 });
  card.style.clipPath = rectClip(r, { width: 1920, height: 1080 });
  ```
- `time.js` — named moments and an optional pulse in one module that the
  page and the score both import; no tempo unless you give one. What happens
  in the picture and how fast it moves can be said there too, for the score:
  `tl.event(at, kind, { x, y, force, label })`, `tl.curve(name, (t) => n)`
  (`speed(fn)` turns a position — `cam.at` too — into px a second; with
  `{ cuts: tl.events }` — or `cam.moves` for the camera's own `cam.cut`s —
  each shot is measured on its own, so a hard cut is not read as a jump of
  thousands of px a second), and
  `window.__film = { …, ...tl.hooks() }` hands both to the renderer. A beat
  sheet can live there too: `tl.segment(from, to, { label, hold, handoff,
  subject, sound })` (moments' names or seconds; `handoff` is how it hands
  over at `to` — `"carry"`, `"cut"`, `"matchcut"`, `"sound"` or your own
  words; `subject` a CSS selector or a subject's name). Every field is
  optional; `film render` writes the sheet into the events file and `film
  probe` sets it beside what the picture did. What the film uses that
  someone else made can be kept there as well: `tl.credit({ what, by,
  licence, url, text })` (or a plain `window.__film.credits` list) goes into
  the events file as `credits` — a record for whoever publishes the film,
  nothing checks it.
- `media.js` — a saved screen's parts measured where they are now
  (`screen(iframe).box("#search")`), shot stills played by film time, their
  boxes and cursor read from the shoot's log; a take's recording mapped onto
  film time with its actions and the moments their results showed, the seam
  where a saved screen can stand in for the recording, and one real part
  lifted out of a saved screen as a layer of its own
  (`skill film material`).
- `cut.js` — cutting on the music (`skill film cutting`): the
  music's grid, a match cut's framing, cuts declared for the score. Nothing
  in it cuts on its own.
- `look.js` — type and colour at film scale (`skill film look`):
  the biggest size a text fits a box at and where its lines break, contrast,
  how big a size reads on a phone, the product's colours by role.
- `audio.mjs` — for the score's Node script: buffers and a mix, an envelope
  that releases from the level it reached (one that releases from the
  sustain level clicks), filters that stop and name their track when they
  blow up, a reverb, a sidechain, seeded numbers, a WAV writer; `normalize`
  lands the mix on −16 LUFS with its true peak under −1 dBTP, measured as
  BS.1770 measures it (films that guessed from peaks shipped at −12.2 and
  −17.8); `diagnose` checks each stem for NaN, clipping, clicks and DC. For
  sound that is not synthesized — a recording, the product's own sounds, a
  track — `load` decodes any file ffmpeg reads, `slice`/`fade`/`varispeed`
  shape it, and `play(bus, sound, at, { align, rate, semitones, gain, pan,
  send })` lands its start, its attack (`"onset"`), its peak or any point of
  it on `at`, with gain, pan and send as numbers or functions of film time;
  `buses`, `space` (one shared room) and `crossfade` go with it, and
  `readEvents`/`curveOf`/`panFor` read what the page exported (`curveOf`
  splits a curve at the film's cuts — each shot held to its cut, the next
  from its own first value; `{ cuts: [] }` draws straight across); `cutToBars`
  and `landOn` edit a track by whole bars (`skill film cutting`).
  The music itself is yours: no melodies, instruments or samples.

It is the film's code from then on: read it, change it, drop it for any
scene. The renderer only ever reads `__film` and `__render`. One flat layer
per camera; for 3D, read `cam.at(t)` and project it yourself.

## The rest of this guide

Each prints on its own; `skill film --all` prints the whole guide in this
order. The files are under `film/` beside this one.

- `skill film material` — material from the real product: saved screens,
  recordings, `shoot`, `kit/media.js` (`lift`, `isolate`, `seam`, `clipEvents`)
- `skill film page` — the page: `__film`, `__render`, clocks, size
- `skill film cutting` — cutting on the music: `film beats`, `kit/cut.js`, bar edits
- `skill film look` — the product's look: `film look`, `kit/look.js`
- `skill film checking` — look at it: still, sheet, check, listen, probe, gallery
- `skill film render` — render: draft, master, `--from --to --into`, motion
  blur, the events file, moving text
- `skill film sound` — the soundtrack and the product's own sound
- `skill film cases` — where the cases are (`skill cases` prints them)
- `skill film numbers` — render times, loudness
