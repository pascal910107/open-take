## The kit and lib/

`film init` copies `kit/` and the starter's `lib/` into the film's folder.
Both are plain functions — `kit/` much of it what twelve films without it
each wrote again, and often got wrong; `lib/` the helpers the liked films
wrote for themselves, and those that do what the measured launch films do
(START.md, "What the measured films do"), each one call with the measured
numbers as its defaults and the film and second they came from in a
comment. Nothing keeps time: every call is a function of film time `t`. The
page `film init` starts from imports only `time.js` and lists the rest. It
is the film's code from then on: read it, change it, drop it for any scene.

### kit/

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
  next: `film gallery` draws `iris`, `zoomThrough`, `gather`, `hop` and
  `matchCut` on your material, and the guide's core shows a few in code.
- `time.js` — named moments and an optional pulse in one module that the
  page and the score both import; no tempo unless you give one. For the
  score: `tl.event(at, kind, { x, y, force, label })`, `tl.curve(name,
  (t) => n)` (`speed(fn)` turns a position into px a second, each shot on
  its own with `{ cuts: tl.events }`); `window.__film = { …,
  ...tl.hooks() }` hands them to the renderer, which adds the picture's own
  change a frame as the curve `picture.energy`. `scenes({ result: [7.2,
  16.8] }, { tl, seams })` shows each scene in its span by visibility and
  declares its cuts (shown is `inherit`, hidden is `hidden`, as the seams
  write it too: a child that sets `visibility: visible` itself shows through
  its hidden scene — give it `inherit`, or hide it yourself); `tl.segment(from, to, { label, hold, handoff, carry,
  subject, sound })` is the beat sheet (step 4), written into the events
  file and read back by `film render` and `film probe`. `tl.credit({ what, by,
  licence, url, text })` keeps what the film uses that someone else made;
  `tl.source(label, { ref, field, url, note, text, selector })` where a
  value on screen comes from (`skill film material`).
- `media.js` — a saved screen's parts measured where they are now
  (`screen(iframe).box("#search")`), shot stills played by film time, their
  boxes and cursor read from the shoot's log; a take's recording mapped onto
  film time with its actions and the moments their results showed, the seam
  where a saved screen can stand in for the recording, one real part
  lifted out of a saved screen as a layer of its own and moved as one body
  with others (`group`, `arrange`, `carry`), and the parts' real values
  read from `components.json` (`readValues`, `partValues`)
  (`skill film material`).
- `draw.js` — marks and light: a pen's stroke round a part, drawn on and
  drawn off (`scribble`, `stroke`), a leader out to a label (`leader`), the
  rest dimmed round one part (`spotlight`), an after swept over a before
  (`sweep`), a band of light uncovering a screen (`lightSweep`), a flash on
  a beat (`flash`). In `motion.js` beside them, a figure landing: a line out
  of random glyphs (`scramble`), digits rolling (`odometer`), a split-flap
  board (`flap`).
- `map.js` — places: longitude and latitude into the frame as web maps
  project them (`fit`), places switching on one after another (`switchOn`),
  a line travelling between them with its tip and length (`along`,
  `pathOf`).
- `cut.js` — cutting on the music (`skill film cutting`): the
  music's grid, a match cut's framing, cuts declared for the score. Nothing
  in it cuts on its own.
- `seams.js` — one scene handing over to the next, measured on launch films
  (numbers in `skill film craft`): by name `"curve"`, `"whip"`, `"depth"`,
  `"inverse"`, `"push"`, `"dip"`, `"cut"` (a hard cut on purpose) — or a
  name they go by (`"pushCut"`, `"into the lens"`) — as a segment's handoff
  with `scenes(…, { tl, seams })`, or in one list, `seams(tl, [{ at, from,
  to, kind }])`;
  `waterfall`, `matchText`, `morph`, `parallax` are calls of their own. A
  side at rest is left with no transform or filter. `film probe` names a
  hard cut where neither side moves and nothing crosses.
- `stage.js` — the product's parts as slabs in depth, each the size of its
  part with its own perspective, so tilted text stays sharp: tilted with
  its content live (`slab.to`), lifted apart and back (`explode`,
  `together`), dropped or piled (`drop`, `stack`), turned over (`flip`),
  the layout turned into a table (`st.turn`), the lens past one slab
  (`st.dolly`); it can follow the camera. `st.adopt(el)` makes a slab of
  what the page already has — a picture, a player, a video — where it is,
  untouched until it moves. No angle unless a film sets one.
- `world.js` — the same slabs and moves in WebGL (three.js, beside the kit):
  pictures, not live DOM, for a cleaner tilt, light, and a laptop, phone or
  browser window round a picture (`w.device`); each slab names its source.
  `window.__render = (t) => w.apply(t)`, returned (a video's frame is
  waited for). `film gallery --blocks seams,stage,world` draws them on your
  material.
- `look.js` — type and colour at film scale (`skill film look`):
  the biggest size a text fits a box at and where its lines break, contrast,
  how big a size reads on a phone, the product's colours by role.
- `audio.mjs` — for the score's Node script: buffers and a mix, an envelope
  that releases from the level it reached (one that releases from the
  sustain level clicks), `osc` (a saw or square that does not alias),
  filters that stop and name their track when they blow up, a reverb, a
  sidechain, seeded numbers, a WAV writer; `normalize` lands the mix on
  −16 LUFS with its true peak under −1 dBTP, measured as BS.1770 measures it (films that guessed from peaks shipped at −12.2 and
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
  and `landOn` edit a track by whole bars (`skill film cutting`). On a
  moment: `subIn(bus, at)` brings the band under 80 Hz in 18.3 dB,
  `dropOut(bus, at)` takes it 19.4 dB down for 1.4 s (`full: true`: the
  whole bus, 22 dB), `filterOpen`/`filterClose` sweep the top; `hitOf` and
  `play(…, { align: "hit" })` find a sound's fastest rise, and
  `diagnose(…, { transients })` leaves clicks put there on purpose alone.

### lib/

- `lib/anim.js` — the shared base the others take their eases, `clamp`,
  `lerp`, `prog` and seeded `rng` from: keyframes (`keys`, `track`), the
  reference film's curves (`ease.*`, `bezier`), `stamp`, `spring`,
  `fling`, `rise`/`exit`, `typeOn`, `count`, a cursor's path and press
  (`pointer`, `press`), a 2D camera (`cam2d`); eases by purpose (`arrive`,
  `leave`, `resume`, `step`, `pop`, `settle`, `drift`), `staggerGrid`,
  `accelStagger`, `split` (chars, words or lines, with a mask; call it
  once, at build), `springs` (a value retargeted again and again),
  `anticipate`, `follow` (a hanging tag's swing). Any ease option takes its
  names and GSAP's (`"power2.out"`, `"back.out(1.5)"`; `named(e)` fails on a
  name it does not know).
- `lib/moves.js` — 2.5D moves on DOM layers, each returning a pose `{ x, y,
  s, …, css, origin }` that `apply(el, pose)` writes: `windowHop` (out of one
  window to the desk, a beat, the next window lifts toward the lens while the
  desk only slides), `pullbackReveal` and `stations`/`station`, `momentumCut`,
  `rampJump`, `exitDrift`, `arrivalShake`, `blurBridge`, the carries
  `zoomThrough`, `toThumbnail`, `implodeTo`, `develop` (duotone to
  finished), `remap`/`freeze`/`onTwos`. A move that cuts returns `cutAt`,
  between two frames at the rate the film is drawn: `tl.event(m.cutAt,
  "cut")`, or `"hidden-cut"` for one inside a move; a `windowHop`'s span is
  `tl.segment(a, b, { handoff: "lift" })` (`skill film render`).
  One take is one camera `{ x, y, s }` on one element: `stations`,
  `windowHop`, `pullbackReveal` and `rampJump` each take the camera the take
  is on as `from` — as a function of t when it is still moving, and the next
  move then starts at its place and its speed — and give one back
  (`rampJump(…).cam`, `pullbackReveal(…).cam`, `stations(…)` itself;
  `camPose(cam)` is its pose for `apply`). A `stations` leg takes 16.5
  frames of 24: 5.5 to its fastest, 11 slowing, then a creep of 0.1–0.5 px a
  frame until the next leaves — written 0.75–1.08 s apart, as measured, the
  camera travels most of the time; further apart, it sits (`stationTimes`
  says how long each station is held). `momentumCut` carries a whole scene
  110–190 px off its place: `apply` paints a flat scene's own colour past
  its edge meanwhile, draws a pictured one larger by what is uncovered, and
  leaves a card alone (`cover`, `ground`); keep applying the cut's poses
  until the new scene has landed, which is when `apply` takes the paint
  off. `rampJump`'s `shift` is px of the
  frame on screen.
- `lib/hud.js` — the words kept on screen, in a screen-space `layer()` that
  the camera never moves, so a chip stays put across a cut: `chip` (dot to
  capsule, text from the middle out, changing in place or sliding across a
  cut; `avoid` takes the product's rects and it keeps clear of them, a step
  at a time), `counter` (a count or a clock that changes in place, only the
  characters that changed moving; `clock(minutes)`; a number can run to its
  next value), `statusLine`, `voice` (an orb and a caption word by word; its
  `chars(t)` is where the next shot's `prompt` carries on typing), `typeAt` /
  `inkHtml` (fast-then-slow typing in fresh ink), `prompt` (press, wave,
  pixel `burst`, closing in), `agent` cursor labels pinned with `pinTo(el)`
  or to a 3D point, `detect` (label, outline, count), `title` out of blur.
  Their colour is the film's: `layer(parent, { accent })`, or
  `--hud-accent` in the page's CSS, gives the mark, fresh ink, send button,
  wave, burst, orb and labels; with none they are drawn in the ink, a grey
  and near white — never in the colours of the films they were measured on.
  Each is made once; `draw(t)` writes it and returns the same numbers
  `at(t)` gives without a page.
- `lib/handoff.js` — changes of scene, one call each: `whip` with one thing
  `carry`-ed to its place in the next scene, `panel` rising in, `through`
  what was clicked into the view it opens; on `seams.js`, unblurred (the
  master's shutter blurs). `carryAlong(t, places)` takes the one thing a
  film follows through every place it sits — `[{ at }, { from, to, at }, …]`,
  each `at` a rect or a function of t (`() => box(el)`, a point of a 3D
  stage) — for one element laid out once. `through` uses the part of the
  rect inside the frame and never draws the scene short of the frame's
  edges; over a 3D canvas, give the rect as the lens sees it when the push
  starts and hold the lens there.
- `lib/devices.js` — `laptop`, `phone`, `computer` round a live screen
  element, drawn from a pose each frame (`lap.draw({ x, y, rx, ry, scale,
  open })`, `open` the lid's angle, 0 shut), lit, sharp; the screen stays
  DOM. `at(pose).toFrame(x, y)`. A face turned from the lens is not drawn
  (`at(pose).faces` says which face that is), so a `computer` turned to show a side
  keeps its top.
- `lib/swarm.js` — a team of agent cursors building the product's screen:
  boxes dragged out with corner handles and a size, copy typed in with a
  text cursor, rules drawn, pictures wiped down, a repeated label copied from
  where it has landed, until the real screen stands untouched. A style some
  launch films use when the story is many agents at once (after
  github.com/thefullctx/swarm-animation, MIT; written again as functions of
  film time), not a default. `swarm(root, { agents, seed, start, duration |
  speed, labels, colors, assign, holds, lift, constantSize })` reads the
  layout once (after `await document.fonts.ready`), with the transforms above
  `root` set aside, and puts its overlay inside `root`, so a layer scaled by
  a 2.5D camera or tilted in CSS perspective carries the cursors; `lift`
  floats them above a tilted surface, `constantSize` keeps them their size
  under a camera's scale (draw after the camera). `data-swarm-agent="3"` or
  `assign: (item) => row` gives an agent its own row; shared items before
  them in reading order (a header) are taken by whoever is free. A hold `{
  agent, from, to, color, label }` stops that agent where it is — the
  cursor, tag and selection in the hold's colour — and it carries on at
  `to`. `sw.draw(t)` hides everything before `start` and leaves the page as
  it was after the last cursor leaves; `sw.end`, `sw.events` (`box`, `type`,
  `line`, `wipe`, `copy`, `done`, `hold`, `resume`) for the score's hits and
  the camera, `sw.agentsAt(t)` in root px. Over a recorded or saved screen,
  `swarmBoxes(img | video | canvas, boxes, { size: [w, h] })` reveals each
  box through a mask of its own (a shoot's boxes are in the still's CSS px);
  a box inside another is covered in the colour round it until its own agent
  builds it. Layout is never moved (text split with an invisible twin, paint
  taken off with `!important`, opacity and clip-path); the cursors are moved
  elements the master's shutter blurs. On a `space.js` slab it builds inside
  the slab's element at the cost of a texture redraw every frame; that was
  not tried under a render.
- `lib/space.js` and `lib/solid.js` — a 3D stage on three.js for the few
  shots where the lens itself moves in space: live DOM windows as slabs in
  depth (HTML-in-Canvas, text sharp up close), a rig of shots (`via`
  points, `fly`/`station` eases, focus pulls, handheld), one accumulation
  loop for depth of field, motion blur and anti-aliasing whose shutter never
  crosses a cut, and `st.film()` for `window.__film` with its own `motion`
  and cuts. `solid.js` makes objects by code — distance functions to meshes,
  turned parts with ribs, brushed, spun and circuit-board surfaces, a
  backdrop, studio light, bloom and a grade. The page imports three from
  `kit/` and hands it in: `space({ three: THREE, canvas })`, `solid(THREE)`.
  - Ready objects, so a laptop on a table is a few lines and not sixty:
    `S.laptop({ screen: [1440, 900], open: (t) => … })` (a keyboard half, a
    lid on a hinge, `open` its angle from film time; `lap.screen` is where
    the live slab goes: `st.slab(el, { parent: lap.screen, shadow: false
    })`), `S.desk({ color, look: (t) => ({ color, sky, sun, sunColor }) })`
    (a ground that fades into the scene's colour, a sky light and a sun) and
    `S.contact(w, d)` (the soft shadow under a thing). `scene.add(it)` puts
    one in and runs it with the scene.
  - A slab rides on another slab or on any three object (`parent:` a lid, a
    `THREE.Group` you turn). `slab.point(x, y, t)` is a point of its element
    (its own CSS px) in the space and `slab.toFrame(x, y, t)` in the frame —
    before the first draw too, wherever the lid is at `t` — for a label or a
    cursor on it (hud's `agent({ at: (t) => slab.toFrame(x, y, t) })`;
    `st.toFrame(p, t)` for any point). `slab.station(rect, { share, yaw,
    pitch })` is the lens that frames a part of it, as `moves.js`'s
    `station(rect)` is the 2D camera that does.
  - What an object is at `t` belongs to the stage, not to `__render`: a
    frame is several samples across the shutter, each at its own time, and
    only what the stage is given as a function — a slab's `move`, a ready
    object's `open` or `look`, `scene.animate((t) => …)`, the scene's
    `update` — is placed again for each. A lid turned from `__render` shuts
    without blur. The scene's ground colour is the same: `st.scene("main",
    { clear: (t) => … })` once, not a call a frame.
  - The lens moves as `lib/moves.js` moves a 2D camera, on the same maths
    and measured numbers, so a 3D stretch and a 2.5D one are timed alike: a
    shot `{ stations: [{ t, to }, …] }` (quick to leave, long to slow, still
    moving when the next leg leaves), `{ momentum: "up", from, to }` (starts
    on a `momentumCut`: the shot before runs out faster every frame, this
    one carries on and slows) and `{ jump: t, to }` (a `rampJump`). The
    stage declares the momentum cut as a cut and the jump as a hidden cut
    through `st.film()`. A momentum cut falls between two frames, half a
    frame before its shot's `start`: what changes with it (the ground, a
    row's state) asks the lens which side a time is on — `const lens =
    st.shots([…])`, then `lens.pose(t).shot` — rather than comparing `t`
    with the start.
- `lib/physics.js` — rigid bodies baked once at load and read in
  `__render(t)` (`bake`, `sample`), with the engine the film brings in its
  own folder (Rapier's deterministic build or ammo; `engine(url)` loads it);
  `publish` puts one hash of every bake on `window.__bake.hash`; `explode`,
  `byLayers`, `landings`, `snap` are the assembly that hangs still and lands
  in pairs. `node lib/physics-seeds.mjs scene.mjs <engine>` bakes 20 seeds
  twice each and says which came to rest clean.
- `lib/palette.mjs` (for the score's Node script) — `bed` (the sub
  foundation), `hit`, `hits(bus, moves)` on camera-move starts and
  landings (each 4.8 dB over what its bus already holds, or over `over`;
  `over: []` keeps the gains as given), `build` into `drop`, `whoosh`; `measure` and `score` set a mix
  beside a card measured from the films' soundtracks (`node lib/palette.mjs
  score.wav`). LUFS is listed, not scored: the kit masters to −16. The low
  band's moves are `kit/audio.mjs`'s `subIn`, `dropOut`, `filterOpen` and
  `filterClose` (above).
- `lib/sampler.mjs`, `samples/` — recorded instruments for the score's Node
  script: `S.note(bus, "piano", n("C4"), at, { vel, dur })`, `S.hit(bus,
  "pk_kick", at)`, `S.credits()`; 23 instruments, CC0 except the piano
  (CC BY 3.0, credited with `tl.credit`) — `skill film sound`.
