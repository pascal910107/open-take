# Films you write yourself

A launch or promo film is yours to make: what it shows, what it says, how it
moves and how it sounds. Write it the way you would build anything for the web
— a page, with HTML, CSS, SVG, canvas, WebGL, any library — and let open-take
do the parts that are plumbing: playing the page frame-exactly, motion blur,
encoding, measuring what you cannot see or hear.
open-take adds nothing anyone sees or hears: the story, the motion and the
music are the film's author's, and so is how good the film is. Nothing below
is required; use what helps.

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

The directory served is the working directory when the page is inside it
(`--root <dir>` otherwise); a file the page asks for that is not there fails
the render by name. Motion blur is measured, not guessed: every frame's
shutter (180°) is probed for how far anything visible moves and gets one
sample per 3 px of travel, averaged in linear light — still frames pass
through untouched. The master is H.264 High, yuv420p, BT.709, 60 fps, with the
soundtrack as AAC. `<audio>` elements on the page are not recorded — the
soundtrack is `__film.audio` (or `--audio <file>`).

Text that moves slowly — a slow push or drift across an interface — steps a
pixel at a time, because Chrome places each glyph on a whole pixel. Push a
picture of the screen, not the live screen: shoot it once at twice the
pixels, show that picture at the screen's size, and render with
`--supersample 3`. A page that shows a saved screen at twice the pixels:

```html
<iframe src="takes/x.take/states/s3/state.html" style="position:absolute;left:0;top:0;width:1920px;height:1080px;border:0;transform:scale(2);transform-origin:0 0"></iframe>
<script>window.__film = { duration: 1, width: 3840, height: 2160 };</script>
```

`npx open-take film still shoot.html --at 0 --size 3840x2160 --out shots`
shoots it. Measured on a saved screen pushed from 1× to 1.6× in 4 s (six
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
```

`film check` reports measured defects with times — a frame that repeats inside
motion, motion updating at a lower rate than the film, black frames inside the
film, true peak above −1 dBFS, clicks (single-sample jumps in the waveform).
It judges nothing about taste.

## Sound

The soundtrack is a WAV you make — `__film.audio`, or `--audio <file>`.
Compose it however suits the film: a script that synthesizes and mixes it
(it can follow the same timeline the page draws from), sounds you bring, or
both. `film check` measures what is hard to judge by ear alone: integrated
loudness, loudness range, true peak, silences, and clicks.

## Material from the real product

- The product's own assets: its fonts, colours, logo and illustrations are in
  its repository — use them rather than lookalikes.
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
  cursor position with its time.

## Numbers that are facts, not taste

- A 43 s film with measured blur rendered in 6–12 minutes on a 10-core Mac;
  the same film as a `--draft` took about 40 seconds — look at drafts, render
  the master when the film is done. More workers do not render faster
  (Chrome's screenshot path is the shared bottleneck); the default is 2. A
  Chrome that dies mid-render costs only the few seconds it was rendering.
- Online video platforms normalise to about −14 LUFS; −16 is a safe master.
