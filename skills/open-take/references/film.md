# Films you write yourself

A launch or promo film is yours to make: what it shows, what it says, how it
moves and how it sounds. Write it the way you would build anything for the web
— a page, with HTML, CSS, SVG, canvas, WebGL, any library — and let open-take
do the parts that are plumbing: playing the page frame-exactly, motion blur,
encoding, mixing and mastering sound, measuring what you cannot see or hear.
Nothing below is required; use what helps.

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

Bring any WAV you made, or write a score and let open-take play it. A score
places every sound yourself — nothing is added for you:

```json
{ "version": 1, "durationS": 42.5,
  "tracks": [
    { "name": "pad", "gainDb": -2, "duck": { "under": "ui", "depthDb": 4 },
      "events": [ { "at": 0, "note": "warm-pad", "pitch": ["D3", "F#3", "A3"], "dur": 4, "gainDb": -18 } ] },
    { "name": "drums", "events": [ { "at": 8, "drum": "kick-long", "gainDb": -6 } ] },
    { "name": "ui", "events": [ { "at": 18.4, "sound": "key.brown", "gainDb": -14 },
                                { "at": 21.0, "sound": "whoosh.deep", "dur": 0.8, "gainDb": -10 } ] } ] }
```

```sh
npx open-take sound instruments   # drums and tuned instruments (pitch "F#3", MIDI, or a chord)
npx open-take sound palette       # recorded sounds (real keyboards, clicks, whooshes) and what each feels like
npx open-take sound render score.json --out score.wav
```

An event is one of `drum`, `note` (+ `pitch`, `dur`), `sound` (a palette id)
or `file` (your own WAV); `gainDb` is its peak level (default −12 dBFS), `pan`
−1…1, `seed` varies a hit. The mix is mastered to −16 LUFS with a −1.5 dBTP
ceiling (`"master": { "lufs": -14 }` to change it, `false` to leave levels as
written). `sound render` prints each track's peak and loudness — the balance
you would otherwise judge by ear. Sounds of real things (keys, clicks) should
be recordings from the palette; synthesized imitations of them read as fake.

## Material from the real product

- The product's own assets: its fonts, colours, logo and illustrations are in
  its repository — use them rather than lookalikes.
- `npx open-take make --plan plan.json --out takes/x.mp4 --states --no-render`
  records the real app (no polished master — a film only needs the material)
  and saves the interface itself at every settled moment:
  `takes/x.take/states/s3/state.html` is a self-contained copy of the page as
  it was (scripts inert). Put it in an `<iframe>` and it is the real UI, sharp
  at any scale; same-origin, so your page can reach into
  `iframe.contentDocument` to hide, restyle or animate single elements.
  `npx open-take states takes/x.mp4 --state s3 --json` lists every element
  with its box.
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
