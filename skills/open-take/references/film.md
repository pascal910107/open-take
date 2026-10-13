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

1. **What the product is, and for whom.** What it makes — a file, a
   picture, a page, a number it works out, a sound — and what it says about
   itself: its headline and copy (`materials.json` from `film init --url`),
   its About page, repository, store listing, changelog, the people who use
   it. A launch film gives someone who has never heard of the product a
   reason to care and the proof of it; a walkthrough teaches a task. Both
   are films you can write; they need different things on screen.
2. **The main line** — what someone who has never seen it should come away
   with, in one sentence.
3. **A rough film you can look at, before the long capture.** The key
   moment of each stretch as a still, in the product's own fonts, colours
   and words, with plain blocks where the material is not there yet; then
   `film sheet` on it. The capture then gets what the rough film asks for.
   The first thing that can be run tends to become the film — a capture
   script written first usually turns into a film of its steps
   (`skill film story`).
4. **What shows it.** For each thing the film says, what on screen makes it
   believable: what the product made, at a size that reads; one of its parts
   doing something; a real action and the result it gives; its own words and
   pictures. The interface is material for this step: what can be recorded
   (`make`), saved as a screen (`make --states`, `shoot`), each part a saved
   screen holds with its values and what an action changed
   (`components.json`). In earlier films the pace often followed the
   material more than the plan (`skill film material`).
5. **A beat sheet**, if you keep one: `tl.segment` in `time.js` — what each
   stretch is meant to do, what moves, what holds, how it hands over to the
   next, what is heard. Free words; nothing grades them.
6. **A draft** — `film render --draft`, `film still`, `film sheet`. A render
   ends with a few lines measured on the film (`--no-report` leaves them out).
7. **Look and listen** — `film probe`, `film listen`, `film check`: what the
   picture and the sound did, beside what the page declared, each line
   measured, estimated or not detected (`skill film checking`).
8. **The seconds that matter, as the master will show them** — a handoff, a
   whip, a burst of cuts: `film render --from --to`, blurred, alone.
9. **Change what you decide to change**, and go round 6–8 as often as it
   helps. The reports are there to see by, not to satisfy.
10. **The master.**

## What's there for…

Capabilities and where each is described; none of them is a step.

- a screen with more text than a viewer reads → one real part on its own:
  as a layer (`lift`), with the rest faded (`isolate`), or the camera on one
  box (`cam.frame`) — the three ways just below — `skill film material`
- one thing of the product's on its own — a button, a number, a card, a tab,
  a line of its text — big enough to read, with something happening to it →
  three ways, none of them the default: **in place** on the real screen,
  with what acts on it and what it changes (a tab and its panel), the camera
  on it (`cam.frame`), the rest faded (`isolate`); **lifted out** as a layer
  of its own, live (`lift`, `group`, `arrange`, `carry`, and inside it
  `count`, `assemble`); **rebuilt** as the film's own HTML at film size, in
  the product's fonts and colours (`film look`) with its real values
  (`readValues`) — `skill film material`
- what parts each saved screen holds, their values in full, what an action
  changed → `components.json` (`shoot` and `make --states` write it;
  `open-take components <dir>`; `film init --from <dir>`); it lists, it does
  not pick — `skill film material`
- each part as a file of its own — its elements with their styles inlined,
  in the product's fonts, opening alone at any size → `parts/` (`film init
  --url`, `shoot`, `make --states`; `partFiles()` in kit/media.js) — `skill
  film material`
- one part as one reference through every screen and the camera — framed,
  clicked, dragged in step with the saved steps, lifted, covered or not →
  `product()` in kit/media.js — `skill film material`
- what the product made — a file, a picture, a drawn shape, a result — as
  material of its own, at any size → `s.save` in a `shoot`, read with
  `st.output(name)` — `skill film material`
- what the whole page holds, top to bottom — its images with alt, largest
  source and a saved copy, its headings and copy, the other pages it links
  to (its About, docs, repository), a sheet of it → `materials.json`
  (`shoot`, `film init --url`; `open-take materials <dir>`)
- where a number or a string on screen comes from → a part's values, a live
  URL, or a note that it is demo data: `tl.source`; `readValues(url, { tl })`
  says it for what it reads; `film probe` sets the film's numbers beside
  them — `skill film material`
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
- launch films taken apart, segment by segment → `skill cases`

## Start

```sh
npx open-take film init film/     # kit/ and a page to start from
npx open-take film init film/ --url https://the.product/   # also its page as a saved screen and its look
npx open-take film init film/ --from shots                  # also a shoot's or a take's components.json
```

With `--url` (and `--size`, `--profile` for a signed-in page) `film init`
first keeps the product's page as a saved screen in `states/home/` and reads
its look into `look/` (`film look`); the page it starts from names both in a
comment. The page is kept once nothing it builds itself from is still
arriving and what it shows has stopped growing; a page that needs something
more says so with `--ready "<selector or text=name>"`, and `--timeout <s>`
gives it longer. A kept screen with no parts, no pictures and hardly a word
is pointed out. Either one failing is a line, and the init goes on. With `--from`
it measures that shoot's or take's `components.json` where it is missing
and prints where it is; the page it starts from stays the same. Every verb
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
  about a fixed point, `gather`, `hop`); contact (`press`, `impact`); a
  number running in the product's own format (`count`, `readNumber`,
  `writeNumber`); parts arriving one after another (`assemble`). Every
  default is an option of the call; any move can be written by hand instead.
  A handoff is whatever two scenes share, so it differs from one to the
  next; a few, none of them the default (`film gallery` draws the others —
  `iris`, `zoomThrough`, `gather`, `hop`, `matchCut` — on your material):

  ```js
  import { rise, morphRect, rectClip, count } from "./kit/motion.js";
  const w = rise(t, 2.0);                          // { x, y, opacity, p }
  // a control grows into the page it opens
  const r = morphRect(t, 4, 4.5, buttonBox, pageBox);
  page.style.clipPath = rectClip(r, { width: 1920, height: 1080 });
  // a value carried on: one lifted part, from its place here to its place there
  carry(totalHere, totalThere, t, 6, 6.5);         // media.js; both in one layer
  totalThere.text(count(t, 6.2, "4,212", "4,466").text);
  // a plain cut, on the beat
  cam.cut(nextBox, g.beat(16));                    // g = grid(…), cut.js
  // a part leaves its page
  const card = lift(screen(iframe), "#card", { into: stage });
  card.place(cardRect(t));
  ```
- `time.js` — named moments and an optional pulse in one module that the
  page and the score both import; no tempo unless you give one. What happens
  in the picture and how fast it moves can be said there too, for the score:
  `tl.event(at, kind, { x, y, force, label })`, `tl.curve(name, (t) => n)`
  (`speed(fn)` turns a position — `cam.at` too — into px a second; with
  `{ cuts: tl.events }` — or `cam.moves` for the camera's own `cam.cut`s —
  each shot is measured on its own, so a hard cut is not read as a jump of
  thousands of px a second), and
  `window.__film = { …, ...tl.hooks() }` hands both to the renderer.
  `scenes({ calc: [7.2, 16.8] }, { tl })` shows each scene in its span by
  visibility (so what is in it keeps its layout) and declares its cuts. A beat
  sheet can live there too: `tl.segment(from, to, { label, hold, handoff,
  subject, sound })` (moments' names or seconds; `handoff` is how it hands
  over at `to` — `"carry"`, `"cut"`, `"matchcut"`, `"sound"` or your own
  words; `subject` a CSS selector or a subject's name). Every field is
  optional; `film render` writes the sheet into the events file and `film
  probe` sets it beside what the picture did. What the film uses that
  someone else made can be kept there as well: `tl.credit({ what, by,
  licence, url, text })` (or a plain `window.__film.credits` list) goes into
  the events file as `credits` — a record for whoever publishes the film,
  nothing checks it. Where a value on screen comes from, the same way:
  `tl.source(label, { ref, field, url, note, text, selector })` → `sources`
  (`skill film material`).
- `media.js` — a saved screen's parts measured where they are now
  (`screen(iframe).box("#search")`), shot stills played by film time, their
  boxes and cursor read from the shoot's log; a take's recording mapped onto
  film time with its actions and the moments their results showed, the seam
  where a saved screen can stand in for the recording, one real part
  lifted out of a saved screen as a layer of its own and moved as one body
  with others (`group`, `arrange`, `carry`), and the parts' real values
  read from `components.json` (`readValues`, `partValues`)
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

- `skill film story` — the film before its material: a rough film you
  can look at first, then the capture it asks for
- `skill film material` — material from the real product: one part shown
  three ways, saved screens, recordings, `shoot`, `components.json`,
  `kit/media.js` (`lift`, `isolate`, `seam`, `clipEvents`, `readValues`),
  where values come from (`tl.source`)
- `skill film page` — the page: `__film`, `__render`, clocks, size
- `skill film cutting` — cutting on the music: `film beats`, `kit/cut.js`, bar edits
- `skill film look` — the product's look: `film look`, `kit/look.js`
- `skill film checking` — look at it: still, sheet, check, listen, probe, gallery
- `skill film render` — render: draft, master, `--from --to --into`, motion
  blur, the events file, moving text
- `skill film sound` — the soundtrack and the product's own sound
- `skill film cases` — where the cases are (`skill cases` prints them)
- `skill film numbers` — render times, loudness
