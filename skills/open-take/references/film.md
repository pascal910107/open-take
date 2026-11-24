# Films you write yourself

A launch or promo film is yours to make: what it shows, what it says, how it
moves and how it sounds. Write it the way you would build anything for the web
— a page, with HTML, CSS, SVG, canvas, WebGL, any library — and let open-take
do the parts that are plumbing: playing the page frame-exactly, motion blur,
encoding, measuring what you cannot see or hear.
open-take adds no look of its own: the story, the type, the colours, the
motion and the music are the film's author's, and so is how good the film is.

## One way to work

`film init` writes `START.md` into the film's folder: what films made with
this tool were liked and disliked for, by one viewer; what seven
launch films people shared were measured doing — the picture seldom held,
layers moving apart, every change of picture carrying something or hidden
in a move, words pinned to the screen, the sound turning on the reveals —
each with its numbers, its call and what it looks like done badly; and an
order to work in. Beside it a plan to fill (`PLAN.md`), measurements of
those films (`reference/`, `reference/travel/`), the helpers that do those
things (`lib/`) and recorded instruments (`samples/`). Read START.md, fill
PLAN.md and read one reference, and a first draft can be built; on what the
film is and how it is worked on, START.md holds over this guide. The steps
below are its order with the tool's verbs beside them; any of them can be
done another way, and nothing checks that it was followed.

1. **Use the product.** Something of your own put through it, every menu
   opened, each thing it does run once, the numbers it gives kept. What it
   says about itself — headline, copy, images, the pages it links to — is
   in `materials.json` (`film init --url`); a capture script of your own
   that keeps stills, boxes and saved screens is `shoot`; a recording of
   one action is `make` (`skill film material`).
2. **`PLAN.md`, before building**: everything the product does; the film
   that comes to mind first; then the film to make — its shape, the thing
   followed, its trouble and its number, each function in (its stretch) or
   out (why no viewer will miss it), and a table of stretches: the layers,
   what crosses each boundary, where the picture travels and where it
   holds, the words on screen, the sound's moment (`skill film story`). Its
   length follows from how much the product does, set beside the references'.
   Then one of the two references, the nearer to the product (START.md, step
   3).
3. **The thing followed, acting, first.** What comes first tends to become
   the film: a capture script, a film of its steps; stills, a film of
   cards. So one live element of what the film follows — rebuilt as the
   film's own HTML in the product's fonts and colours (`film look`) with
   its real values, a part from `parts/`, or one lifted from a saved screen
   (`lift`) — the cursor doing one real thing to it, the result showing: a
   few seconds, `film render --draft`, watched. The rest grows from it, a
   stretch at a time, each brought in by something of the one before.
4. **A beat sheet**, if you keep one beside the plan: `tl.segment` in
   `time.js` — what each stretch is meant to do, what moves, what holds,
   what is heard, and what crosses into the next: a sentence on what of
   this scene lives on and what it becomes there, or "cut" for a hard cut
   on purpose ("hidden-cut" for one inside a move, "lift" for a layer lifted
   off the rest — `skill film render`). `carry` names that thing (a selector; for a canvas, a
   function of t giving its box): the render follows it across and says
   what it did, with a strip of every boundary. Free words; nothing grades
   them.

   ```js
   tl.segment(0, 6.2, { label: "…", handoff: "<what lives on, what it becomes>", carry: "#…" });
   tl.segment(6.2, 9, { label: "…", handoff: "cut" });   // a hard cut, on purpose
   ```
5. **Drafts** — `film render --draft` (half size, no blur, about half a
   minute), then `film sheet` and `film still`: look at every one before
   going on. A render ends with a few lines measured on the film
   (`--no-report` leaves them out).
6. **Look and listen** — `film probe`, `film listen`, `film check`: what the
   picture and the sound did, beside what the page declared, each line
   measured, estimated or not detected (`skill film checking`).
7. **A first-time viewer** — `film viewer film.mp4`: an agent that has
   seen nothing of how the film was made watches it and says where it would
   scroll on, and why (`skill film viewer`). A draft is enough for it.
8. **Change it**, and go round 5–7 again, a new viewer for each new cut:
   the liked films took 3 to 8 drafts and 2 to 4 complete rounds. Each
   round starts by finding every change the last one asked for on the new
   draft, at its second (PLAN.md, "Checks"). The reports and the viewer are
   there to see by, not to satisfy. Where a stretch is called slow, the
   first answer is the next thing the product does, happening there;
   cutting is for what repeats.
9. **Before the master, the seconds that matter as it will show them** — a
   fast move, a handoff, anything much larger than the frame: `film still
   --at`, or `film render --from --to`, blurred, at full size. A draft
   shows neither blur nor a very large element the full render fails to
   draw.
10. **The master**, started in the background and waited for (earlier ones
   took 3 to 68 minutes), then looked at like a draft. A note names
   seconds: change those and render only them into the film — `film render
   --from 12 --to 16 --into film.mp4` (`skill film render`); the whole
   master again only when the structure moved.

How launch films people shared got from one scene to the next, moved the
camera, landed words and numbers, opened and ended — measured, with how to
build each — is `skill film craft`; `film gallery --with` draws the kit's
blocks on this product's own screen.

## What's there for…

Capabilities and where each is described; none of them is a step.

- a screen with more text than a viewer reads → one real part on its own,
  as just below — `skill film material`
- one thing of the product's on its own — a button, a number, a card, a tab,
  a line of its text — big enough to read, with something happening to it →
  start from it live and acting: a file from `parts/`, **lifted out** as a
  layer (`lift`, `group`, `arrange`, `carry`; inside it `count`,
  `assemble`), or **rebuilt** as the film's own HTML in the product's fonts
  and colours (`film look`) with its real values (`readValues`). Screens
  shown as pictures under a caption read as flat; parts that act, as alive.
  **In place** (`cam.frame`, `isolate`) when the screen round it matters; a
  full screenshot for the moment the whole screen is the proof — `skill
  film material`
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
- another film taken apart — its confirmed cuts with strips of frames, how
  much of it travels, drifts or holds, what crosses each boundary, its
  sound's bed, sub entries, drops and hits → `film study <video>` — `skill
  film checking`
- what the picture and the sound did → `film probe` (its text lane: how big
  the text reads on a phone, and where the product's own words are most of
  it), `film listen` (its grid as `grid({ bpm, offset })` for the page),
  `film check`, `film sheet`, `film still` — `skill film checking`
- a designed thing that moves — a logo, an icon, a title, a figure, a
  lower third, a small diagram — as an animation of its own → a Lottie file:
  the text-to-lottie skill (MIT; `git clone
  https://github.com/diffusionstudio/lottie`, `skills/text-to-lottie/`)
  writes one and checks it in its own player; on the page `lottie-web`
  plays it frame-exact, autoplaying or seeked in `__render` — `skill film
  page`
- how a move should feel — timing, easing, choreography, what a motion says
  → the motion-design skill (MIT; `git clone
  https://github.com/lottiefiles/motion-design-skill`,
  `skills/motion-design/`), written for interfaces; its `director/` notes
  on choreography and narrative are about any motion
- how a scene can hand over to the next, a camera that travels or holds, the
  product's own things moved as objects, words that land, numbers and maps
  that earn their figures, a first second and an ending that closes — as
  widely shared launch films did them, with their numbers → `skill film craft`
- a window lifting off a desk that only slides, stations in one take, a cut
  on the fastest frame, words that stay put while the camera moves, a lens
  moving in 3D, bodies falling and landing, a score's low bed → `lib/`
  (START.md, "What the measured films do") — `skill film kit`
- what makes a film look machine-made — choices that came back across
  agent-made films, each with when it is fine → `skill film tells`
- how the film lands on someone who has never seen it → `film viewer` —
  `skill film viewer`
- a few seconds as the master shows them, a patch into the master, slow
  pushes over interface text without jitter (`film picture`,
  `--supersample`) → `skill film render`
- how the renderer plays a page (`__film`, `__render`, clocks) → `skill film
  page`
- a soundtrack, written or a finished track whose licence allows it, and
  the product's own sound from a take → `skill film sound`

## Start

```sh
npx open-take film init film/     # START.md, PLAN.md, reference/, lib/, samples/, kit/ and a page to start from
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
wrote again, and often got wrong; `lib/` beside it, helpers of the kind the
liked films wrote for themselves and those that do what the measured films
do. The page `film init` starts from imports only `time.js` and lists the
rest; its length is a placeholder. One line each here; what each call takes
and returns, with its measured defaults, is `skill film kit`.

- `kit/camera.js` — say when to see what (`cam.frame(box, { arrive })`, a cut
  `cam.cut(box, t)`), on the take camera's measured path; a hand, a shake,
  a layer at its own depth (`cam.depth`).
- `kit/cursor.js` — where it clicks, types or drags, at the take cursor's
  pace.
- `kit/motion.js` — moves as functions of t: a closed-form spring,
  entrances and exits, handoffs where one picture becomes the next, a
  press, a number running in the product's format, parts arriving.
- `kit/time.js` — named moments, events and curves the page and the score
  share; the beat sheet (`tl.segment`); credits (`tl.credit`); where a value
  on screen comes from (`tl.source`).
- `kit/media.js` — saved screens, shot stills and a take's recording on film
  time; a real part lifted out as a layer (`lift`, `group`, `carry`); its
  real values (`readValues`).
- `kit/draw.js`, `kit/map.js` — a pen's stroke, a leader, a spotlight, a
  sweep, a flash; places projected, switched on, a line travelling.
- `kit/cut.js`, `kit/seams.js` — the music's grid and cuts on it; one scene
  handing over to the next, measured, by name.
- `kit/stage.js`, `kit/world.js` — the product's parts as slabs in depth,
  live (DOM) or as pictures (WebGL).
- `kit/look.js` — type and colour at film scale.
- `kit/audio.mjs` — for the score's Node script: buffers, buses, a mix,
  oscillators that do not alias, `load`/`play` for recordings, the low band
  in and out on a moment (`subIn`, `dropOut`), filters opening, `normalize`
  to −16 LUFS, `diagnose`, `cutToBars`.
- `lib/anim.js`, `lib/moves.js`, `lib/hud.js` — keyframes and measured
  curves; 2.5D camera and cut moves on flat layers (a window hop, stations,
  a momentum cut, a one-frame jump, carries, speed ramps); the words kept
  on screen (a status chip, a prompt typed and sent, cursor labels).
- `lib/handoff.js`, `lib/devices.js` — a whip with one thing carried, a
  panel, a push through; a laptop, a phone, a box computer round a live
  screen.
- `lib/space.js`, `lib/solid.js`, `lib/physics.js` — a 3D stage on three.js
  with depth of field and motion blur; objects made by code; rigid bodies
  baked once.
- `lib/palette.mjs`, `lib/sampler.mjs` with `samples/` — the score's low
  bed, hits, a build into a drop, a card of six soundtracks' figures;
  recorded instruments.

A handoff is whatever two scenes share, so it differs from one to the next:

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
// a push that speeds up, jumps in one frame and settles: a cut the report counts as meant
const j = rampJump(t, 8.1);                      // lib/moves.js
tl.event(j.cutAt, "hidden-cut");
```

It is the film's code from then on: read it, change it, drop it for any
scene. The renderer only ever reads `__film` and `__render`. One flat layer
per camera; depth with `stage.js`, layers each with its own pose
(`lib/moves.js`), `lib/space.js`, or read `cam.at(t)` and project it
yourself.

## The rest of this guide

Each prints on its own; `skill film --all` prints the whole guide in this
order. The files are under `film/` beside this one.

- `skill film story` — what the film follows; that thing acting first,
  then the capture it asks for
- `skill film craft` — how launch films were shot: getting from one
  scene to the next, the camera, the product on screen, words, numbers,
  maps, openings, endings, rhythm — the moves, measured, and how to build them
- `skill film tells` — what makes a film look machine-made: the choices
  that came back across agent-made films, and when each is fine
- `skill film material` — material from the real product: a part that
  acts, saved screens, recordings, `shoot`, `components.json`,
  `kit/media.js` (`lift`, `isolate`, `seam`, `clipEvents`, `readValues`),
  where values come from (`tl.source`)
- `skill film page` — the page: `__film`, `__render`, clocks, size
- `skill film kit` — every file of `kit/` and `lib/`: what each call takes,
  returns and defaults to, and where its numbers come from
- `skill film cutting` — cutting on the music: `film beats`, `kit/cut.js`, bar edits
- `skill film look` — the product's look: `film look`, `kit/look.js`
- `skill film checking` — look at it: still, sheet, check, listen, probe, gallery
- `skill film viewer` — a first-time viewer watches it: `film viewer`
- `skill film render` — render: draft, master, `--from --to --into`, motion
  blur, the events file, moving text
- `skill film sound` — the soundtrack and the product's own sound
- `skill film numbers` — render times, loudness
