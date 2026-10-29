## How launch films were shot

Launch and explainer films made in code — HTML, canvas, three.js — that
people shared widely, taken apart frame by frame and, where their source was
open, read in their source. What they did, with the numbers measured, and
how to build each move on a page; the kit has the ones that are easy to get
subtly wrong (`film gallery` draws them on your material). They are ways,
not steps: each heading is
a question a film meets, and under it several answers that worked. A film
uses a few, chosen for what its own product has.

What these films had in common, set against films that read as flat (a pan
or zoom over a screenshot, many words, a hard cut to an unrelated angle, an
end that just stops):

- a scene left through something in it — the thing clicked, circled or
  counted became the next scene;
- one camera that kept moving, its moves overlapping, never stopping dead;
- the product's own things — its cards, pins, prices, badges — taken out of
  the screen and moved as objects; the full screen shown for one proof, and
  then staged (tilted, lit, focused on one part), not laid flat;
- few words, landing one at a time, held still once landed;
- an ending that closed the film: back to the first frame, or a pull-back
  that showed every shot had been part of one picture, held still 2–3 s.

### Getting from one scene to the next

A cut lands where the eye already is. In these films most seams were carried
by an object; hard cuts were kept for punctuation, on the beat.

- **The thing clicked becomes the next frame.** The camera tracks to the
  button (≈0.6 s, blurred while it moves), then the button grows from ≈8 %
  to ≈250 % of the frame in 0.35 s on a strong ease-in; its fill is the next
  scene's ground. `zoomThrough` (kit/motion.js) is one scale about a fixed
  point.
- **An object becomes the world.** A card, chip or search field grows past
  the frame in ≈0.65 s, ease-in-out, its corner radius shrinking to 0; what
  surrounds it blurs ≈15 px and fades in 0.3 s; the next scene is already
  inside it, fading in from halfway. `morphRect` + `rectClip`, or animate the
  element's own box. A search field becoming the results, a card
  becoming its page.
- **A round thing becomes the iris.** A map pin, an avatar, a ring chart's
  hole, a dot the last word collapsed into: the next scene sits in
  `clip-path: circle(r at x y)` whose centre and starting radius are the
  object's; r grows to `hypot(W, H)` in 0.3–0.5 s, a thin rim at r. The
  circle drawn round something (a hand-drawn mark) can be the aperture too.
  `iris`.
- **Carried across.** The scene shrinks (1 → 0.6, or down to a thumbnail)
  with blur peaking ≈6 px mid-move and lands inside the next container as it
  builds round it: a result going into a list, a page into a "saved" strip.
  `carry`, `hop`, `gather`.
- **Same shape, new world (match cut).** One shape keeps its place and size
  across a hard cut while everything round it changes — a circle that is a
  wheel, then a pupil, then a logo; a chip in a title, then the same chip in
  the interface. The incoming shot is still moving (arriving from ≈2.5×
  zoom, settling) so the cut lands on motion. `matchCut` (kit/cut.js).
- **The layout is the cut.** Several real screens as cells; cells re-tile
  (rects interpolated over ≈0.34 s, ease-in-out), new cells open from an
  edge with a 0.2 s border flash; toward the payoff the grid tightens (1 →
  2 → 4 → 9) and at the moment itself every cell flies to its tile of one
  full-frame shot (≈0.4 s) under a warm flash. Tension made by the layout.
- **Before → after on the same picture.** A glowing line (2–4 px) sweeps
  across in ≈0.45–0.6 s, ease-in-out; behind it the changed state:
  `clip-path: inset(0 calc(100% - var(--x)) 0 0)` on the after layer. The
  viewer sees both states, so the change cannot be missed. An empty map
  filling with places; a price before and after; a filter off and on.
  `sweep` (kit/draw.js).
- **One action sorts everything.** Clutter on screen; one press; a ring
  spreads from the press (≈2600 px/s) and as it passes each item, the item
  flies on a curved path (quadratic Bézier, bend ≈0.2 × length, same side
  for one kind) into its slot of a tidy grid or list, overshooting slightly
  along its path and settling; the camera pulls out over one beat so press
  and result land together. Before and after in one motion.
- **The page dismantles into its mark.** One part of the interface retracts
  per beat (sidebar, header, status bar); the window squashes to a line
  (0.22 s, ease-in), the line to a dot, the dot becomes the caret or the
  logo.
- **Light, not a cut.** On one held shot the light changes: everything dims
  to ≈15 % in 0.25 s, then the new layer is revealed by a soft-edged mask
  spreading from a point. Good for layers of the same map or screen.
- **A band brushes the scene over.** A brand-colour band (≈0.25–0.3 s,
  ease-in-out) crosses the frame; the new scene on one side, the old on the
  other, each carrying its own caption, so the band literally brushes the
  headline over. The films measured kept to one band kind each.
- **Punctuation.** One or two frames of white or inverted picture on a
  beat, the new scene decaying from over-exposed over 0.3 s; or the
  outgoing frame darkened ≈40 % for 3 frames before a hard cut, so the cut
  reads as meant (`flash`, kit/draw.js). A cut placed at the fastest frame
  of a move (both sides blurred, same direction and speed) hides in the
  motion.

Worlds rarely crossfaded into each other; where a plain dissolve was used
the ground stayed and only what was on it changed (out: blur ≈8 px and fade
in 0.13–0.2 s; in: sharpen in 0.13 s).

The same seams, as HyperFrames measured them on its own launch films and
as kit/seams.js gives them (`film gallery --blocks seams` draws each on
your material):

- **Cut on the curve** (`curve`, `waterfall`): out on an ease-in, in on its
  mirror, the cut at the fastest frame — 230 px over 0.30 s each side,
  ≈ 3070 px/s across the cut; word by word, 0.022 s apart out, gaps from
  0.05 s shrinking ×0.84 in. HyperFrames' own default seam.
- **One strip** (`whip`): the next scene docked a frame beyond, the strip
  whipped one frame in ≈ 0.55 s, 3·W/dur at the middle; its films smeared
  for 0.13–0.3 s.
- **Into the lens** (`depth`): out to ×1.2 with blur to 10 px in 0.2 s, in
  from ×0.75 out of the same blur in 0.5 s; inverse for a payoff.
- **One line, one curve** (`matchText`): cubic-bezier(.85, 0, .15, 1) over
  the whole move, the words swapped at its middle.
- **Card into panel** (`morph`): the panel shrunk onto the card and grown
  back in 0.6–1.2 s, the parts both hold moving at their own size.
- **A tile becomes the scene** (`parallax`): the rest of the grid pushed
  outward ≈ 900 px a tile, to 0.6 and gone, over ≈ 2.4 s; reversed, a
  dolly-out in ≈ 1.2 s.
- **A cut on purpose** (`pushCut`, `dipCut`): both sides pushing in
  (1 → 1.04, then on to 1) under a 0.2 flash; or the last 3 frames ≈ 40 %
  darker.

The first six by name on a beat sheet — `tl.segment(from, to, { handoff:
"depth" })` with `scenes(…, { tl, seams })` — are handed over between the two
scenes that meet there (`skill film`, step 6).

### The camera

- **One camera that never stops dead.** Each move adds its own displacement
  onto where the camera is, eased so it starts quickly and settles long; a
  new move begins before the last has settled. Zoom is moved in log space,
  so ×1→×2 takes as long as ×2→×4 and a long zoom does not rush its end.
  `camera()` with `zoom: "log"`; a move is `cam.frame(box, { arrive, dur,
  ease })`.
- **Holds keep moving.** A slow 2–5 % push or a ≈0.2 rad orbit across
  a hold, and a hand underneath: a sum of slow sines, ≤3 px and ≤0.1° roll,
  too small to read as a wobble. `handheld`.
- **Start on the part being used.** 1.5–2.5× on the control, the action
  happens there, then a fast blurred pull-out (≈0.35 s) shows where we are,
  then a push to the next part. Long holds on a whole screen were rare. At 3–5×
  a tiny action — a typed comment, a toggled filter — becomes the shot.
- **Follow the cursor or the caret.** The panel slides so the cursor stays
  near the centre, lagging slightly (a critically damped spring, ≈0.4 s);
  while text is typed the camera keeps the caret ≈60 % across and creeps in
  (1.2 → 1.8) as the rest falls out of focus.
- **A whip to the next thing.** 0.13–0.45 s, quintic in-out, smearing only
  along the move; it lands on the new subject at the same scale. Motion blur
  belongs to the fast frames; slow pushes stay sharp.
- **Dive, then snap out.** City → district → one place in three pushes that
  get faster (≈0.9, 0.6, 0.6 s), everything but the subject draining to
  grey; then out in one ease-out of ≈1.2 s. While zooming a long way, move
  the target with the zoom so the point fallen toward stays put on screen.
- **Pull back: one becomes many.** One card or pin, then in ≈1–1.5 s the
  camera retreats ×3–6 and it is one cell of a field of others already
  alive (neighbours change state with a delay by distance). Or the whip
  version: from scale 2.2 to ≈1.05 in 1.2 s, then settle to 1.
- **A spotlight on the one promise.** Push in (×1.45 → ×1.85 over 0.8 s)
  while the rest dims behind a soft ellipse
  (`radial-gradient(ellipse … transparent 60%, rgba(0,0,0,.55))`, centred
  on the element's measured box each frame); held ≈1.5 s; released in 0.5 s.
  Often after a beat of silence. `spotlight` (kit/draw.js).
- **Depth.** A screen tilted into space (`perspective: 1600–2800px`,
  rotateY ≈−20…−35°, rotateX ≈20°) with its content still working inside,
  the angle drifting a few degrees during the hold; a flat layout that
  rotates ≈40° into a table of objects with shadows, and back to flat later;
  layers at heights that slide at different rates as the camera moves, the
  ones nearer the lens softer.
- **Its parts as slabs in space.** Each part a flat slab of its own, no
  bigger than what it shows, turned and moved in depth: a card tilted into
  space while its content keeps working; a screen coming apart into its
  parts, layer above layer, and back together; cards lowered onto the stage
  like prints, panels landing on a pile; a card turning over to show the
  next scene on its back; a layout turning into a table; the lens travelling
  past one slab into what lies behind it. `stage` (kit/stage.js):
  `slab.to({ rx, ry, z })`, `explode` / `together`, `drop` / `stack`,
  `flip`, `st.turn`, `st.dolly` — a part of a saved screen through a window
  its size stays live DOM; with the film's camera, the stage follows it.
  A picture, a player of frames or a video the page already shows becomes a
  slab where it is with `st.adopt(el)`, untouched until it moves.
  `film gallery --blocks stage --with <saved screen>` draws each move on the
  product's own screen.

### The product on screen

- **Take its objects out.** The films people remembered rarely showed a
  whole screen. They pulled the product's nouns out of it — cards, pins,
  price chips, status badges, comments — rendered them in its own fonts and
  colours as shapes that can move freely, told the idea with them (many
  notes → pins → spinners → ticks; 200 places → 3 near you → 1 booked), and
  came back to the real screen for one proof, usually by growing one of
  those objects into it. `lift`, `isolate`, `parts/` (`skill film material`).
- **Its parts in the sentence.** A short line with small real pieces of the
  interface set in it like words — "Find [photo] near [pin] from [price]" —
  cycling through variants every ≈0.25 s while the line holds; later one of
  them grows into the next scene. Or one word swaps in a held line and the
  interface pieces round it swap with it. The title is the demo.
- **Freeze and draw.** Play the real interaction at speed; on the beat
  freeze it: a white flash (0.1 s, ≈0.55 alpha), a punch from 1.035 to 1.0
  over 0.35 s, the picture desaturating and cooling, everything outside an
  ellipse darkening over 0.3 s; then, 0.3–0.6 s apart, a ring under the
  subject (who), a line to what it produced (what), one label (the finding);
  a slow creep while frozen; then play on. Marks drawn in the picture's own
  coordinates, inside the same transform, so they ride with it.
- **Hand-drawn marks instead of boxes.** A slightly wobbly stroke drawn on in
  0.3–0.5 s (`stroke-dasharray`/`dashoffset` over `pathLength="1"`), held
  0.5–1 s, then drawn off from its start (not faded); circle, underline,
  arrow, a double scribble round a target. One stroke per beat. A marker
  sweep under a line of text (`background-size` 0 → 100 % in ≈0.6 s).
  `scribble` and `stroke` (kit/draw.js).
- **Labels on leaders.** A dot on the real element (a ring pulsing 3 → 9 px),
  a leader drawn diagonal-then-flat by length in ≈0.38 s, then the label
  slides 10 px and fades in, in a free column beside the subject (shift the
  stage to make the column rather than covering it); labels stack one every
  ≈0.16 s and leave before the next move. `leader` (kit/draw.js).
- **A light sweep reveals it.** The screen sits at ≈7 % brightness; a soft
  diagonal band of light crosses it in ≈1.3 s and leaves it lit, a glint
  riding the front, while the window turns from ≈−24° to 0° in perspective.
  Two copies: a dim one, and a lit one under
  `mask-image: linear-gradient(115deg, #000 calc(var(--p) - 700px), transparent var(--p))`
  — `lightSweep` (kit/draw.js) gives both masks.
- **Arrivals with weight.** Menus open on a back-ease (≈0.25 s, overshoot
  ≈1.8) and close plainly in 0.15 s; panes grow by width (back 1.3, 0.45 s);
  cards and screenshots are lowered onto the stage like prints — scale 1.25
  → 1, the shadow tightening from wide and soft to close and sharp, a 3 %
  bounce — and a pin snaps onto them.
- **The interface working.** Skeleton first (grey blocks at the real
  elements' rects), then content per block with a ≈60 ms stagger; a list
  re-ranking by stepping each row down one slot rather than swapping;
  streamed words arriving grey and darkening over ≈0.27 s; typing with a
  human rhythm (per character `(1/cps)·(0.55 + 0.9r)`, a little more after a
  space and after punctuation, cps 9–15).
- **The cursor as someone.** Bigger than a real cursor, travelling on a
  slight arc (20–40 px), arriving decelerating, pressing for ≈0.08–0.1 s
  (scale ≈0.85–0.96); a payoff click can carry a ripple. Without
  a mascot, the product's mark or its core object (a pin, a card) can play
  the part.

### Words

- **Few, one at a time, still once landed.** Most lines small (≈2.5–4 % of
  the frame height); a few words at hero size. A line held
  ≈0.5 s + 0.3 s a word (Chinese: characters ÷ 4.5 + 1.5 s after it lands);
  the last line at least 2 s. In these films text stayed still once it had
  landed.
- **How a word arrives.** Out of its own line (a mask, `translateY(110%)` → 0
  on `cubic-bezier(.7,0,.2,1)`, ≈0.125–0.35 s, lines 0.1 s apart); grey to ink
  per word, 0.07–0.1 s apart, nothing moving; a 6 px blur resolving in 0.13 s,
  words 0.067 s apart; typed with a caret; letters of a name 0.04–0.1 s apart;
  slammed along one axis and landing on the sixteenths. The accent word last,
  or in the accent colour.
- **A caption that holds while the pictures change.** One line stays put
  while the picture under it cuts every 0.25–0.65 s. Speed without
  re-reading.
- **The key word stays.** The other words blur out leftward (0.05 s apart),
  the key word turns the accent colour and holds — and can shrink to the dot
  that opens the next scene.
- **A line that changes state.** Scramble: characters cycle through random
  glyphs and lock left to right, each ≈0.05 s after the last (seeded per
  frame, so any frame renders the same — `scramble`, kit/motion.js); a
  handwritten line rewritten into set type; one word swapping in a held
  sentence.

### Numbers and data

- **A number lands with what it counts.** The counter is computed from how
  many things have landed — pins, plates, rows — so it stops exactly when
  the motion stops, rather than a separate tween that finishes early. Or an
  ease-out with a long tail (the last values crawl), weight growing thin →
  black with a variable font, tabular figures, a small source line under it.
  `count`.
- **Odometer, split-flap, glyph noise.** Digit columns rolling with blur by
  speed and landing left to right ≈0.15 s apart with a slight overshoot; a
  split-flap where the old value's top half folds down and the new one's
  bottom half folds open (0.26 s, tiles 0.2 s apart) — before/after prices;
  digits cycling through glyphs and locking one per sixteenth, each landing
  with a damped bounce. These films gave it to the headline number and let the rest count.
  `odometer`, `flap`, `scramble` (kit/motion.js).
- **The number becomes the header.** It lands big, shrinks to header size,
  and a small dashboard builds round it (bars growing 0.3 s, 0.05 s apart, a
  dot matrix, a ring) — then the header re-rolls to the next figure every
  ≈0.4 s while the dashboard stays. Six facts in three seconds.
- **A real figure dives out of the page.** The camera dives into a tiny
  number where it really sits in the product, then cuts to the same number
  full frame, scrambling into place.
- **Isotype.** Icons popping one per sixteenth into a silhouette that means
  the quantity.

### Maps and places

- **Lights out, then the places switch on.** The map dims; places light
  one by one in an order that means something (by year, by distance), each
  fading in over ≈0.22 s with a short white flash; the spread accelerates
  (1.0 → 0.9 → 0.75 s per group) while a counter rolls with it. `fit`
  projects longitude and latitude into the frame the way web maps do;
  `switchOn` times each place and says how many are lit (kit/map.js).
- **The hole.** Light a radius round every place; the parts of the city
  left dark draw themselves — what is not covered is the shape.
- **Distance, earned.** Mark the destination, draw a ticked line from here
  to there with the camera chasing its tip and a counter rolling with it
  (0 → 420 m), then pull back to show the whole distance; the route drawn
  slightly ahead of whatever travels it. Three strokes with the same path —
  a wide glow, a core, a thin bright thread — on slightly different eases.
  `along` gives the tip, its heading and the length drawn (kit/map.js).
- **Colour only on the subject.** The map and everything else desaturated;
  the one place keeps, or regains on the beat, its colour.
- **City to street.** A push from ≈0.92 to ≈2.1 over ≈3 s (expo in-out),
  settling with a small overshoot, a scribbled circle drawn round the target
  and a sticker popping from its tail — the annotations placed where the
  target lands after the zoom.
- **Pins pop in clusters** (back-ease, ≈0.08–0.12 s apart, sized by
  something real), the map's fill the brand's colour or pattern, tilted
  ≈40°; or the map folds flat to a line that becomes the list of places.
- A real place reads as a place on real imagery; a drawn outline reads as a
  diagram. Both are choices.

### The first two seconds

None of these films opened on a logo or "Introducing". They opened on:
the product already doing its job, mid-action; one living element on an
empty stage (a blinking caret, a pen) that then makes the title; the page
blurred and dimmed with one part sharp, which flies to its home as the page
resolves; one small object, then the context it sits in; a question typed
with the product's input inside it; a clock already running.

### The ending

- **Bookend.** The last shot returns to the first framing with the state
  changed — the empty search box, now filled; the blinking cursor that
  opened the film.
- **Everything was one picture.** Design the final composition first (all
  the screens, the map, the prices, the logo), shoot every earlier shot as a
  crop of it, keep one zone free; end on a long log-zoom pull-back to the
  whole and one last piece landing in the free zone.
- **The system becomes the mark.** The route, the pins, the loop collapse
  into the logo's shape; the wordmark writes on letter by letter, the line
  under it word by word, a link pill pops last.
- **Claims along the way, the mark at the end.** None of these films closed
  on a list of what the product does: each claim had landed earlier, one at
  a time, on the shot that showed it, and the end held the mark, one line
  and where to go.
- Then the frame holds 2–3 s with one small motion (a ×1.06 push, a glint).
  The failures were both ways: a film that just stopped, and one with 13 s
  of alternating logo cards.

### Rhythm

- Scenes of 2–4 s with something changing every 0.25–0.5 s inside them;
  shots of ≈1.8–3 s on average; a held demo of one framing 7–10 s while the
  interface acts in it. Change density, not cut density.
- Bursts between holds: one run of 8–12 cards at ≈0.2 s each, then a calm
  continuous shot. Related items at half length (three cards at 0.5 s
  each); acceleration by subdividing (quarter notes → eighths → sixteenths),
  not by changing tempo.
- A breath: a beat of near-silence before the turn, the first
  sound after it the key action.
- Each kind of thing arriving its own way — files drop, photos fling,
  notifications slide, windows pop — 0.2–0.3 s each; in these films only
  captions simply faded.
- Where the films had a pulse, every landing sat on it (`skill film
  cutting`); where real material had its own events — a click, a page
  load — the change sat there instead.
