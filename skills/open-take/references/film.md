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
   ([material](#material-from-the-real-product)).
2. **The main line** — what the film is about, in one sentence.
3. **A beat sheet**, if you keep one: `tl.segment` in `time.js` — what each
   stretch is meant to do, what moves, what holds, how it hands over to the
   next, what is heard. Free words; nothing grades them.
4. **A draft** — `film render --draft`, `film still`, `film sheet`.
5. **Look and listen** — `film probe`, `film listen`, `film check`: what the
   picture and the sound did, beside what the page declared, each line
   measured, estimated or not detected ([look at it](#look-at-it)).
6. **The seconds that matter, as the master will show them** — a handoff, a
   whip, a burst of cuts: `film render --from --to`, blurred, alone.
7. **Change what you decide to change**, and go round 4–6 as often as it
   helps. The reports are there to see by, not to satisfy.
8. **The master.**

## Start

```sh
npx open-take film init film/     # kit/ and a page to start from
```

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
  ([material](#material-from-the-real-product)).
- `cut.js` — cutting on the music ([below](#cutting-on-the-music)): the
  music's grid, a match cut's framing, cuts declared for the score. Nothing
  in it cuts on its own.
- `look.js` — type and colour at film scale ([below](#the-products-look)):
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
  and `landOn` edit a track by whole bars ([below](#cutting-on-the-music)).
  The music itself is yours: no melodies, instruments or samples.

It is the film's code from then on: read it, change it, drop it for any
scene. The renderer only ever reads `__film` and `__render`. One flat layer
per camera; for 3D, read `cam.at(t)` and project it yourself.

## The page

A film is a page that knows its length:

```js
window.__film = { duration: 42.5, audio: "score.wav" }; // audio: optional, relative to the page
```

Then either:

- **draw any moment on request** — `window.__render = (t) => { … }` (t in
  seconds, called in any order; may return a promise). The page is a pure
  function of time, which makes every frame reproducible and lets a section be
  re-rendered alone; or
- **just animate** — CSS animations and transitions, the Web Animations API,
  `requestAnimationFrame` loops, GSAP, three.js, `<video>`. The renderer puts
  every clock the page can read on film time (`performance.now`, `Date`,
  timers, rAF), pauses every animation and video and sets it to the exact
  frame. Such a page keeps its own state, so it is played front to back.
  `requestAnimationFrame` runs 60 times a second of film time, as on a 60 Hz
  screen, so what it moves is drawn sharp; motion blur falls on what CSS, the
  Web Animations API or `__render` move.

`Math.random` is seeded (every render draws the same numbers). The page lays
out at 1920×1080 CSS px unless `__film` says `width`/`height` (a vertical cut:
1080×1920). `__film.ready` (a promise) holds the first frame until your assets
are in; fonts and images are awaited anyway.

## Render

```sh
npx open-take film render film/index.html --out film.mp4          # 1080p60 master
npx open-take film render film/index.html --draft --out draft.mp4 # half size, 30 fps, no blur, fast
npx open-take film render film/index.html --from 12 --to 16 --out part.mp4
```

Render the master once, when the film is done; look at drafts and stills
while you work on it. A draft has no blur and half the frames; a few
seconds whose motion matters — a handoff, a whip, a fast zoom — can be seen
as the master will show them, alone, with `--from`/`--to` and no `--into`
(it costs those seconds' share of a master render). A change to a few
seconds goes into the master you have, in place of its own frames — the rest is not drawn again; a change to
the sound alone is not a render at all:

```sh
npx open-take film render film/index.html --from 12 --to 16 --into film.mp4
npx open-take film mux film.mp4 --audio score.wav
```

A `<video>` on the page is shown from its decoded frames: steady under a slow
push and quick to render, as it is — and one you draw into a canvas gets the
same frames.

The directory served is the working directory when the page is inside it
(`--root <dir>` otherwise); a file the page asks for that is not there fails
the render by name. Motion blur is measured, not guessed: every frame's
shutter (180°) is probed for how far anything visible moves and gets one
sample per 3 px of travel, averaged in linear light — still frames pass
through untouched. The master is H.264 High, yuv420p, BT.709, 60 fps, with the
soundtrack as AAC. `<audio>` elements on the page are not recorded — the
soundtrack is `__film.audio` (or `--audio <file>`).

Every render also writes `<film>.events.json` beside the film: the page's
events and named moments, each curve sampled once a frame, and the cuts —
the page's events of kind `"cut"` (`declaredCuts`) and those the blur probe saw
(`detectedCuts`; a draft or `--no-blur` sees none, and a cut between two
shutters can be missed) — and the page's beat sheet as `segments`
(`tl.segment`). A page without hooks gets empty lists. A
`--from --to --into` patch updates the master's file in place. The score's
script reads it, so the sound follows the picture as rendered.

Text that moves slowly — a slow push or drift across an interface — steps a
pixel at a time, because Chrome places each glyph on a whole pixel. Push a
picture of the screen, not the live screen: shoot it once at twice the
pixels, show that picture at the screen's size, and render with
`--supersample 3`:

```sh
npx open-take film picture takes/x.take/states/s3   # → states/s3/picture@2x.png
```

Measured on a saved screen pushed from 1× to 1.6× in 4 s (six
lines of 13–18 px text, frame-to-frame jitter): 0.49 px as the live screen,
0.19 px as the live screen with `--supersample 3`, 0.08 px as the picture
with `--supersample 3` (0.10 with `--supersample 2`), which rendered in about
the live screen's time without it. The picture's last frame is as sharp as
the live screen's, a shade lighter. A layer drawn once at its largest and
only scaled down (`will-change: transform`) steadies large type — 40 px bold
pushed 1.0–1.2× went from 0.26 px to 0.06 px — but not interface text
(0.48 px on the push above), and `--supersample` turns it off.

## Look at it

You cannot watch the film; these are the next best things:

```sh
npx open-take film still film/index.html --at 3.5,12,12.4 --out stills   # PNGs as the master shows them
npx open-take film sheet film.mp4                                        # every ~second on one timed sheet
npx open-take film check film.mp4 --size 1920x1080 --fps 60              # format, hitches, cadence, cuts, black, loudness, clicks
npx open-take film listen film.mp4                                       # the sound, laid out on the sheet's times
npx open-take film probe film/                                           # the picture, beside what the page declared
npx open-take film gallery film/ --with takes/x.take                     # what each kit block does, on your material
```

`film probe` (a film, or the film's folder: it finds `film.mp4` beside or
in it and reads the page) writes `film.probe/`: `probe.png` on the sheet's
ruler and `probe.md`/`probe.json`. It reports how much the picture changes
each frame and where no change is seen; shots, cuts per 5 s, and small swaps
(jumps that change 2–12 % of the frame); every big change with thumbnails
before and after; each cut's offset to the nearest sound onset; the whole
picture's zoom and travel, with its runs, where it turns back, stretches
that go back and forth and moves repeated at an even pace. With a beat sheet
(`tl.segment`) it sets each segment beside what happened: written to hold
and the picture still moved (where, and how much), the subject leaving the
frame (from the page by selector, or from the positions the page declared as
curves `<name>.x`/`<name>.y`), and the handoff written next to the one seen
at its end. Its text lane says how much of the frame is text, how many
characters are on screen at once and how big they are — on the film and on
an upright phone — with the film's own words, the product's words in saved
screens (both read from the page) and text inside pictures (read off the
frames: macOS text recognition, elsewhere an edge count with no sizes) kept
apart, and where the film's words sit over a picture or the subject.
`--page`/`--root` say where the page is when it is not beside the film;
`--no-text` skips that lane. No line is a score or a target.

`film probe`, `film listen` and `film beats` read any film, not only yours —
a reference you like, say — and describe it the same way. That is a
description of that film, not a number to reach.

`film gallery` draws each block of the kit — every motion, each camera
option, the cut helpers — at six moments, with its value and its speed over
time, the default beside three other settings, measured on the function
(settles at, swings past rest, top speed; "not detected" when it never
does). Given the film's folder it draws the film's own `kit/`, as you have
changed it. `--with` puts the blocks on the product's picture, saved screen
or take, moving one real element of it (`--subject <id|text|x,y,w,h>`, or one
it picks and names); `--beats` draws the cut helpers on the film's own music.
`--blocks rise,camera.shake` or `motion`/`camera`/`cut` narrow it.

`film listen` (a film or a WAV) writes `film.listen/`: `listen.png` — the
spectrum, loudness, onsets with a beat grid, sections, the page's events
(from `film.events.json`, or `--events`) and curves, cuts and silences, on
the same ruler as `film sheet` — and `listen.md`/`listen.json`: loudness,
tempo with its alternatives, sections, bars that repeat an earlier one
verbatim, silences, which events have no sound within 40 ms (next to how
often chance would), each cut's offset to the nearest onset, and the film's
tempo, key and kick pattern beside those of earlier films' scores (counts
only — most of those sat near 120 BPM). With
`--stems <dir>` it says which stem rises at each event and how far over the
rest, and `--clips` writes each stem solo and muted. `--vs <previous.wav|mp4>`
sets it beside an earlier version on the same film time: loudness, tempo,
onsets and section boundaries in one and not the other, which events gained or
lost a sound, the 1 s stretches where the two differ most (seconds) beside
what the median stretch differs by (encoding alone leaves a little
everywhere), and `vs/` clips of those moments from each plus `aba.m4a`
(this, previous, this; levels as they are, not matched). The events file's
`credits` are printed as written. Every line says
whether it is measured, estimated or not detected; none is a grade.

`film check` reports measured defects with times — a frame that repeats inside
motion, motion updating at a lower rate than the film, black frames inside the
film, true peak above −1 dBFS, clicks (single-sample jumps in the waveform) —
and what it finds worth a look: a flash (a few frames unlike both sides — a
clip cut on a transition frame), a shot that starts on blank frames. With
`--page film/index.html` it also plays the page and reports text over text,
text running into a painted element and text cut by the frame's edge, each
with its times, and the smallest text on screen; text drawn turned, skewed
or mirrored, or inside a frame tilted in perspective, is named for you to look
at, not measured. A flash or a blank that is meant is marked in the page and
reported as such:

```js
window.__film = { duration: 42.5, marks: [{ at: 21.4, until: 21.5, what: "white flash" }] };
```

A mark covers what lies inside it, give or take 0.1 s; whatever runs past it
is still reported. It judges nothing about taste.

## Sound

The soundtrack is a WAV you make — `__film.audio`, or `--audio <file>`.
Compose it however suits the film: a script that synthesizes and mixes it
(it can follow the same timeline the page draws from), sounds you bring, or
both. `film check` measures what is hard to judge by ear alone: integrated
loudness, loudness range, true peak, silences, and clicks; `film listen`
shows where the sound's onsets, beats and sections fall against the page's
events and cuts.

A take recorded with `make` also keeps the product's own sound when the page
made any: `<name>.take/product-audio.wav` is what it sent to its speakers, on
the capture's clock (sample 0 is the zero of every event `tMs`;
`product-sound.json` says how it was placed), and the audio files the page
fetched are listed there, the smaller ones saved in `product-sounds/`. `load`
reads either, and `play` can put any slice of them on a real event.

## Cutting on the music

A long take and fast cuts are not modes of a film: each boundary hands over
its own way — carried by a move, cut, cut to the same place, bridged by a
sound — and a cut can sit on a beat, an onset, a word, or off them on
purpose.

```sh
npx open-take film beats track.mp3     # → track.beats.json (a film.mp4 works too)
```

`film beats` reads music as a grid: tempo (with its confidence and the
half/double readings), beats, downbeats and bars, sections with their energy,
drops, onsets — each field labelled measured, estimated or not detected.
`kit/cut.js` reads it:

```js
import { grid, matchCut, cuts, density } from "./kit/cut.js";
import { throughCamera } from "./kit/media.js";
const g = grid(await (await fetch("music.beats.json")).json());
// or a pulse of your own: grid({ bpm: /* the music's */, offset: /* s */, beatsPerBar: /* its meter */ })
g.bar(4); g.beat(8.5);               // when bar 4 starts; the "and" of beat 8
g.snap(3.1, { to: "onset", within: 0.08 });  // to: beat | half | quarter | bar | onset | section | drop
g.between(8, 12, { to: "bar" });     // the bar lines in [8, 12)
```

- `matchCut(fromBox, toBox, { width, height }, { fit })` frames the next
  shot so its copy of the subject lands where the last shot left it: a view
  `{ cx, cy, w }` for `cam.cut(view, t, { keepInside: false })`. `fromBox` is
  where the subject showed in the picture — `throughCamera(box, cam, t)`;
  `fit` is `"area"` (default), `"width"`, `"height"`, `"contain"`, `"cover"`.
- `cuts(tl, times, { grid, to, within })` declares each as `tl.event(t,
  "cut")` (snapped onto the grid when one is given), so the events file and
  the score have them.
- `density(g, [{ from, to, intent }])` is one way to turn "this part holds,
  this one bursts" into cut times on the grid: `intent` a word from `PACE`
  (`hold`, `calm` 8 beats, `steady` 4, `pulse` 2, `burst` 1, `flurry` ½), a
  number of beats, or `{ every: [4, 0.5] }` for a pace that changes across
  the section; `on: "onset"` lands each on a nearby onset. Change what it
  gives or place every cut by hand.

A track can be edited by whole bars in the score's script (`audio.mjs`):
`cutToBars(sound, beats, [{ from, to, times }], { xfade, fadeIn, fadeOut, at })`
joins bars with an equal-power crossfade that ends on the bar line, and
returns `{ sound, map, joins, beats }` — `beats` is the edit's own grid, to
write out for the page's `grid()`. `landOn(beats, { bar, at, start })` gives
the lead-in so source bar `bar` sounds at film time `at`:

```js
const edit = cutToBars(load("track.mp3"), beats,
  [...landOn(beats, { bar: 40, at: 16 }), { from: 40, to: 46 }]);
play(music, edit.sound, 0);
writeFileSync("music.beats.json", JSON.stringify(edit.beats));
```

A track you did not make needs a licence that covers the film.

## Material from the real product

One moment of the product comes three ways from one `make --states`
recording, on one clock: the **recording** (the real action at its real
speed), the **saved screen** (the interface itself — sharp at any size, its
parts separable) and the **real output** (what the product actually made,
which can become the next shot's subject). A film can go from one to another
— the real action, its real result lifted out, the result where it is used —
as one continuous shot or as cuts on the music.

- The product's own assets: its fonts, colours, logo and illustrations are in
  its repository — use them rather than lookalikes.
- `npx open-take shoot shoot.mjs --out shots` runs your own capture script in
  open-take's browser and keeps the log: `s.open(url)` (loaded, hydrated,
  settled), `s.still(name)`, `s.click` / `s.type(…, { each: true })` /
  `s.drag(…, { every: 4 })` (real input, then a 2× still), `s.track(selector)`.
  `shots/shots.json` holds every still with the cursor, the scroll and the box
  of everything tracked or acted on — read it, never copy coordinates by hand.
  For what the helpers do not cover, `s.cdp` is the page's CDP session,
  `s.wsEndpoint` lets Puppeteer or Playwright connect to the same browser, and
  `s.inject(js)` runs before the page's own scripts. Stills are taken between
  inputs while the product's own clock keeps running: its animations play
  faster across them — record the real thing (`make`) where speed matters.
- `npx open-take make --plan plan.json --out takes/x.mp4 --states --no-render`
  records the real app (no polished master — a film only needs the material)
  and saves the interface itself at every settled moment:
  `takes/x.take/states/s3/state.html` is a self-contained copy of the page as
  it was (scripts inert). Put it in an `<iframe>` and it is the real UI, sharp
  at any scale (to push slowly into it, push a picture of it — see the moving
  text above); same-origin, so your page can reach into
  `iframe.contentDocument` to hide, restyle or animate single elements — what
  moves inside a frame, your page moves (a frame runs its own timers and
  animation frames only where it is put on the page).
  `npx open-take states takes/x.mp4 --state s3 --json` outlines it — its
  regions and the parts worth naming, each with an id and a box —
  and `states/s3/index.json` beside the saved page lists every element.
- The recording itself (`takes/x.take/capture.mp4`) plays as a `<video>` on
  film time, frame-exact, and `capture.json` holds every click, keystroke and
  cursor position with its time — and, measured off the recording, when each
  action's result showed and when it stopped changing (`result.atMs`,
  `doneMs`, its box) and when the page went quiet (`settledMs`). A click and
  its result are often not one moment: a result measured 1.5 s after its
  click is not rare, and a film whose cuts follow the click times cuts away
  before the result shows. `open-take states <take> --measure` adds
  these readings to a take recorded before them; `open-take states` prints
  them.

`kit/media.js` joins the three on the film's clock:

```js
import { screen, readTake, clip, clipEvents, seam, lift, isolate } from "./kit/media.js";
import { morphRect, smooth } from "./kit/motion.js";
import { tl } from "./timeline.js";                     // your timeline (kit/time.js)
const s = screen(document.querySelector("#app"));      // states/s3/state.html in an iframe
const c = clip({ at: 0, from: 12.0, to: 16 });          // film 0 s shows the recording's 12.0 s
const card = lift(s, "e126", { around: "clear" });      // the part the app just produced
const rest = isolate(s, ["e126"]);                      // the rest fades into the page
let T = Infinity;
const took = readTake("../takes/x.take/").then((take) => {
  T = clipEvents(take, c, { tl }).find((e) => e.kind === "result" && e.action === "a2").t;
});
window.__film = { duration: 6, ready: Promise.all([took, card.ready, rest.ready]), ...tl.hooks() };
window.__render = (t) => {
  rest.set(smooth((t - T) / 0.4));
  card.place(morphRect(t, T, T + 0.6, card.rect, { x: 0, y: 0, w: 1920, h: 1080, r: 0 }), { fit: "cover" });
};
```

- `readTake(url)` reads a take's `capture.json` (`fromLog(log, base)` for
  one in hand): its actions, its recording, its saved states.
- `clip({ at, from, to, speed })` — or `clip({ keys: [[film, rec], …] })`, a
  clip that slows down round a click and hurries through the waiting — maps
  film time onto the recording: `toCapture(t)`, `toFilm(c)`, `videoTime(t)`.
- `clipEvents(take, clip, { tl, kinds })` turns the actions inside the clip
  into film events — the input, and apart from it `"result"`,
  `"resultDone"` and `"settled"` — each `basis: "measured"` or
  `"estimated"`, a result after the clip's end `"outside the clip"`, none
  found `"not detected"`; with `tl` they are declared for the score too.
- `seam(take, clip, "s3", { video })` says when the saved screen shows the
  same thing as the recording (`window`, in film time) and where to put it
  so it lands on the video (`transform` — for a positioned box at the
  stage's 0, 0 holding its iframe; on the iframe itself `lift`, `isolate`
  and `box` cannot measure through it), with what `make` measured between
  the two (`residual`). Measured on a rendered swap (test/film-seam-e2e):
  nothing moves at the swap frame, and it differs from the frame before by
  no more than `residual`; on macOS the recording's darks show lighter than
  the saved screen's (a dark green 76 → 87 of 255) — the recording is
  tagged with BT.709's curve, which Chrome on macOS shows through Apple's
  gamma. A part lifted inside that box moves with it, so its `rect` and
  `place()` are in the state's px: a stage box `b` is
  `((b.x − offset.x) / scale, (b.y − offset.y) / scale, b.width / scale,
  b.height / scale)` there — full frame is the stage's size only at scale 1
  (checked on a 2× stage: the plain stage box carries the card twice too big).
- `lift(screen, part, { around, into, pad, radius, background, css, fit })`
  lifts one real part — a selector, an index id (`"e126"`), an element or a
  box — as a layer of its own, sitting exactly where it was, live DOM so it
  stays sharp at any size. `box`/`rect` are where it sat (what `morphRect`,
  `hop` and the other handoffs start from); `place(rect, { opacity, fit })`
  moves it; `restyle(css)` changes only the copy. `around: "clear"` keeps the
  part alone, see-through around it.
- `isolate(screen, parts, { color, opacity, blur })` fades everything but
  those parts; `set(p)`, 0 to 1.
- `throughCamera(box, cam, t)` is a box under a camera as it shows in the
  picture — to carry a part out of a moving layer, or into `matchCut`;
  `fitTransform(from, to, fit)` the transform from one box onto another.

## The product's look

```sh
npx open-take film look takes/x.take --out film/look --page film --fonts film/fonts
```

`film look` reads the look off the product's real interface — a take's
saved screens, one state, or a URL: every colour with how much of the screen
it paints and where (and its CSS variable names), an estimate of the roles
(bg, surface, text, muted, accent, on-accent, border) with the reason and
the alternatives, the families the text is set in with their actual font
files, type sizes, radii, shadows, and the motion timings its CSS declares
(declared, not necessarily played). It writes `look.json`, `look.css` (the
product's `@font-face` rules and `--look-*` colours) and `look.png`, a
specimen at film size in the product's fonts and words. With `--page` (the
film's page) or `--text` it checks every character of the film's words
against those font files, at each weight used, and names what none of them
has; `--fonts <dir>` writes the files cut down to those words, with a
`fonts.css`. Roles are estimated, the rest measured; none of it is a preset.

`kit/look.js` executes type and colour at film scale:

```js
import { fitText, contrast, readable, palette, loadLook, fontsReady } from "./kit/look.js";
const look = palette(await loadLook("look/look.json"));   // look.bg, look.text, look.accent, look.font()…
await fontsReady(look.font(), "800", words);
const f = fitText({ width: 1500, height: 420 }, words, { font: look.font(), weight: 800, lines: 2 });
title.style.font = f.font; title.innerHTML = f.lines.join("<br>");
contrast(look.text, look.bg);   // the WCAG ratio
f.readable.on[0];               // how big that size shows on an upright phone, px and mm
```

`fitText(box, text, { font, weight, min, max, lines, lineHeight,
letterSpacing, balance })` returns the biggest size that fits and its lines
(`fits: false` when even `min` does not): CJK broken by phrase and never
before a closing mark, Latin at spaces, lines balanced. `breakLines`,
`measurer` and `readable(px)` are there on their own.

## Cases

[`cases/README.md`](cases/README.md), beside this guide (in the installed
skill, `references/cases/`), takes apart films a viewer said they would post —
and the one human-made launch film he liked best — segment by segment: what
moves, what holds, how each part hands over, what the sound does, the
material, and the comment the film got, quoted. It is indexed by what a
segment wants to say ("show a result appearing from an input", "let it
breathe"). Each case is "this film got this comment" — one viewer, one film,
another product's material — not a template or a rule.

## Numbers that are facts, not taste

- A 43 s film with measured blur rendered in 6–12 minutes on a 10-core Mac;
  the same film as a `--draft` took about 40 seconds — look at drafts, render
  the master when the film is done. More workers do not render faster
  (Chrome's screenshot path is the shared bottleneck); the default is 2. A
  Chrome that dies mid-render costs only the few seconds it was rendering.
- Online video platforms normalise to about −14 LUFS; −16 is a safe master.
