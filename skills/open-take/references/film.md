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

## A way to work (yours to change)

What separated the films people liked from the flat ones was not the number
of effects: it was that **the motion carried the story** — an object the
viewer follows from one scene into the next, things making room for what
arrives, an interface moving because something was done to it, the music
pulling back before the moment it lands. A way of working that tends to get
there:

1. Before code, a short shot list: for each part, what the viewer should
   understand, which object changes and how, and how the sound carries it.
2. Build it.
3. Review it at the moments that matter — `film review` (below) gathers them.
4. Fix what you find, and review again.

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

```sh
npx open-take film review film.mp4 --page film/index.html   # what to look at and listen to
```

`film review` writes a folder: for every measured problem, every layout
collision it reads from your page (a caption over the interface's own text,
a number growing into a badge, text cut by the frame — inside iframes too),
the longest stretches where nothing cuts or moves fast, and any times you ask
for (`--at`), it saves the real-speed clip with its sound, the WAV and a strip
of consecutive frames, indexed in `review.md` with why each was picked and what
was not measured. Look at the strips; they are what a frame looks like in
motion.

## Sound

The soundtrack is any WAV — one you made, or one open-take plays from a
score. A score is a list of timed events; nothing is added that you did not
place. Write it by hand as JSON, as a program that returns it
(`score.mjs`: loops, chords, the film's own times), or skip it and bring a
WAV.

```sh
npx open-take sound instruments   # drums and tuned instruments (pitch "F#3", MIDI, or a chord)
npx open-take sound palette       # recorded sounds (real keyboards, clicks, whooshes) and what each feels like
npx open-take sound render score.mjs --out score.wav   # or score.json
```

The format: `{ "version": 1, "durationS": 42.5, "tracks": [ { "name": "keys",
"events": [ … ] } ] }`. An event happens `at` seconds and is one of `drum`,
`note` (+ `pitch`, `dur`), `sound` (a palette id) or `file` (your own WAV);
`gainDb` is its peak level (default −12 dBFS), `pan` −1…1, `seed` varies a
hit. A track can sit under another (`"duck": { "under": "ui", "depthDb": 4 }`)
and has its own `gainDb`.

Written as a program, the score can read the same times as the picture: put
the times in one module that both import, and a sound lands on the frame that
shows it.

```js
// times.js — imported by the page and by the score
import { tempo, typing } from "./film-kit.js";
export const T = tempo(96);                                    // if the film has a beat
export const search = typing("World Gym", { at: T.at(3) });    // keystrokes the field shows
```

```js
// score.mjs — the default export is the score (or a function returning it)
import { T, search } from "./times.js";
const keys = search.times.map((at) => ({ at, sound: "key.brown", gainDb: -16 }));
// a pulse is a loop over the grid …
const pulse = [];
for (let i = 0; i < 32; i++) pulse.push({ at: T.at(5) + i * T.beat, drum: "…", gainDb: -10 });
// … and a soundscape is not: a few long notes and sounds where the picture asks
const air = [{ at: 0, note: "…", pitch: ["…"], dur: 12, gainDb: -20 }, { at: 12.4, sound: "…" }];
export default { version: 1, durationS: 42.5,
  tracks: [{ name: "keys", events: keys }, { name: "pulse", events: pulse }, { name: "air", events: air }] };
```

Which of these a film wants — a beat, none, both in turn — is the film's. The
mix is mastered to −16 LUFS with a −1.5 dBTP ceiling (`"master": { "lufs": -14
}` to change it, `false` to leave levels as written). `sound render` prints
each track's peak and loudness — the balance you would otherwise judge by
ear — and `film review` measures the finished film's pulse. Sounds of real
things (keys, clicks) should be recordings from the palette; synthesized
imitations of them read as fake.

## Small helpers (optional)

```sh
npx open-take film kit --out film/film-kit.js
```

copies a short ES module next to your page, yours to change. Pure functions
of time (a score module can import them too): `tempo(bpm)` / `beat(n)` (a beat
grid the picture and the score can share), `reveal(t, { at, dur, kind })`
(entrance and exit styles), `split` + `stagger` (per-character reveals),
`flight(p, from, to, { arc })` (an object travelling between two boxes),
`count(t, …)` (a number counting up), `typing(text, { at })` (when each
character is typed, at a person's pace — for a field filling in and its key
sounds), `frame` / `travel` / `clampView` (a camera over a page: a framing, a
move between two framings that keeps what is framed heading steadily for its
place, no blank past the page's edges), `spring`, `ease`, `bezier`, and
`rand(key)` / `noise(key, t)` — randomness that is the same on every frame
and in every render worker. (In a `__render` page, `Math.random` is reseeded
for each frame from its time; use `rand`/`noise` for values that must hold
still or drift smoothly across frames.) And `openScreen` — the product's
real interface on your stage, below.

## Material from the real product

- The product's own assets: its fonts, colours, logo and illustrations are in
  its repository — use them rather than lookalikes.
- `npx open-take make --plan plan.json --out takes/x.mp4 --states --no-render`
  records the real app (no polished master — a film only needs the material)
  and saves the interface itself at every settled moment:
  `takes/x.take/states/s3/state.html` is a self-contained copy of the page as
  it was (scripts inert), sharp at any scale.
  `npx open-take states takes/x.mp4 --state s3 --json` lists every element
  with its id (`e16`) and box.
- The recording itself (`takes/x.take/capture.mp4`) plays as a `<video>` on
  film time, frame-exact, and `capture.json` holds every click, keystroke and
  cursor position with its time.

### Saved screens on your stage

`openScreen` (in the kit) puts a saved screen on the page as an `<iframe>` and
resolves once it stands as captured — await it in `__film.ready`. What a shot
needs from the interface decides how to use it:

- **The page, and where things are on it** — look at it through a window and
  frame what matters:

  ```js
  const home = await openScreen("takes/home.take/states/s2/state.html");
  home.window({ x: 160, y: 90, width: 1600, height: 900 }, { radius: 24 });
  const all = home.frameOf(), field = home.frameOf("e40");          // framings
  home.view(travel(ease.inOut(progress(t, 4, 1.2)), all, field));    // in __render(t)
  ```

- **Something happening in the interface** — act on it, from film time:

  ```js
  home.type(t, "e40", "World Gym", { at: 5 });     // fills at a person's pace, with a caret
  home.press(t, "e41", { at: 6.4 });               // gives a little and comes back
  home.set(t, "e52", { at: 6.6, attr: { "aria-expanded": "true" } });  // the product's CSS draws it
  home.set(t, "e60", { at: 7, text: count(t, { at: 7, to: 2576 }) });
  ```

  Call them on every frame, without conditions: each sets what it does at t,
  and every new t starts from the page as saved, so a frame comes out the same
  in any order. They change the saved page; the product is not running —
  whatever it would do on its own (a panel opening, a list updating), set
  that too.

- **One thing, on its own** — lift it off the page: with `show`, only those
  parts paint (everything else, the page's background included, is
  transparent) and the part goes wherever you put it:

  ```js
  const card = await openScreen(src, { show: ["e16"] });
  card.place({ box: { x: 1200, y: 300, width: 480, height: 300 } });  // fit into a box
  card.place({ x: 960, y: 540, scale: 1.5, rotate: -4 });             // or a point, a scale, an angle
  const from = card.stageBox();                                     // where it is now
  ```

A lifted part is its own copy of the page: what you typed or switched on the
page, do on the copy too, and it leaves the page seamlessly — start it at the
page's `stageBox("e16")` and hide the original there (`set(t, "e16", { at,
style: { visibility: "hidden" } })`). `openScreen` warns on the console when
a part is not where it was captured (a saved screen that does not reproduce
it lifts as nothing or the wrong thing). `screen.doc` and `screen.$("e16")`
reach into the saved page for anything else. Every open screen follows the
film's clock; `close()` the ones a film is done with.

## Numbers that are facts, not taste

- A 43 s film with measured blur rendered in 6–12 minutes on a 10-core Mac;
  the same film as a `--draft` took about 40 seconds — look at drafts, render
  the master when the film is done. More workers do not render faster
  (Chrome's screenshot path is the shared bottleneck); the default is 2. A
  Chrome that dies mid-render costs only the few seconds it was rendering.
- Online video platforms normalise to about −14 LUFS; −16 is a safe master.
