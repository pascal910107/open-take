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
  A still keeps the interface too: each `s.still()` and the still an action
  ends on also writes a saved screen to `shots/states/<id>/state.html` with
  its `index.json` — the same capture and fidelity check as `make --states`
  below; `<id>` is the still's name (`home-2` when a folder of that name is
  already there), and the still's `state` field in `shots.json` names it,
  with `states.items` saying how each re-rendered (`fidelity.ok`). The stills
  on the way (a keystroke's with `each`, a drag step's with `every`) keep
  none; `state: true` or `state: false` on a call says it for every still
  that call takes, and `--states` / `--no-states` (or `runShoot({ states })`)
  for the whole shoot. A screen costs about 0.3–0.5 s; one that cannot be
  read keeps the still without it, with a line saying why. In the page,
  `stills(log).state("home")` (by index, name or id) is that screen's URL and
  `screen(iframe, url)` shows it, so `lift` and `isolate` take it as they are:

  ```js
  const st = await stills("shots/shots.json", document.querySelector("#still"));
  const home = screen(document.querySelector("#home"), st.state("home"));
  const total = lift(home, "#total", { around: "clear" });
  ```

  `film init --url <url>` keeps one the same way, of the product's page, in
  the film's `states/home/`.
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
  at any scale (to push slowly into it, push a picture of it — moving text in
  `skill film render`); same-origin, so your page can reach into
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

- `screen(iframe, src)` shows a saved screen in an iframe of its viewport's
  size — one already in the iframe's `src`, or `src` (a take's or a shoot's
  `state.html`); `box(selector | id)` is where a part of it is now.
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
