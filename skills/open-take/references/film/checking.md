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
apart, and where the film's words sit over a picture or the subject. When
it has read the page, one line names the stretches where the product's own
words (its saved screens, and text in pictures when macOS reads them) are
most of the frame's text, or their median size reads under 8 px on the
phone (`PHONE_SMALL_PX`; a sample with fewer than 20 of the product's
characters gives no size), beside what acts on part of a screen — `lift`,
`isolate`, `cam.frame` (`skill film material`); `probe.json` keeps each
sample's `productMedian`. Its provenance section ("Where the values on
screen come from") sets each number in the film's own text beside the
sources the page declared (`tl.source`) and the parts' values in
`components.json` — `skill film material`.
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
tempo with its alternatives — and that grid as the page can have it,
`grid({ bpm, offset })` in kit/cut.js (beat 0 is the first beat found, not
necessarily a bar's first; where the tempo is not steady an even pulse
departs from the beats, which `film beats` keeps in a file `grid()` takes) —
sections, bars that repeat an earlier one
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

`film check --page` and `film still` also look through the folder served to
the page (as `film render` serves it, the page not run): when it holds PNG
stills from a `shoot` (`shots.json`) and no saved screen, a `material:` line
says that a still can keep the interface itself (`skill film material`).
`check --json` has it as `material` — the shoot logs found, their stills,
how many name a saved screen, and the count of `state.html` files.
