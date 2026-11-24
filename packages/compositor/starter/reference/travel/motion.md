> What this is: how the six films in `structure.md` move — how much of the
> time the picture travels, every kind of transition they use with its
> length and what it carries, the camera's grammar with distances, speeds
> and curves, layers and depth, the motion of things inside the frame, and
> the words on screen. Frame numbers are native frames of each film (24 fps
> unless the film is marked 30 fps); pixel distances are in that film's own
> frame size (1276×718 for the fly, the game and the flying machine;
> 1920×1080 for the app, the manga and the truck). Same marks as
> `structure.md`: [verified], [inferred], [uncertain]. Grammar only.

# Six launch films that never stop: motion (travel, transitions, camera, words)

## 0. Conclusion in one paragraph

Where `../motion.md`'s film keeps the camera still half the time and lets
content build, these six keep the picture travelling and hold only to let
something be read. They change place mostly with designed moves of
0.05–0.5 s, and where they hard-cut, the cut sits on the fastest frame with
the motion continuing across it, or something — light, blur, an object, a
sentence — is the same on both sides. Long distances inside one interface
are not flown: the camera accelerates, jumps 1.45–4× in one frame, and
settles. A tour of several stations in one take accelerates for 5–6 frames,
decelerates for 10–12 and dwells 3–8 frames without reaching zero speed.
Most of the "3D" is 2.5D: separate layers scaled separately. Words sit on
the screen, not in the world, and are there nearly all the time.

## 1. How much the picture moves

Three measures, each counting something different [verified]:

| Film | Camera or whole picture travelling | Held still (event detector's hold share, `structure.md` §1) | Adjacent frames with the subject not moving |
|---|---|---|---|
| Fly | 46.6% of frames (2 px or 0.4% scale a frame); 59.6% at 1 px; locked 24.2% | 13.3% | 11% |
| Game | 62.6% travel, 25.6% slow drift, 10.5% hold, 1.4% cuts (optical flow; drift 0.05–0.5 px a frame at 320 wide) | 11.7% | 10% |
| Flying machine | 47.8% (first half 58%, second 38%; acts 29 / 62 / 58 / 8%) | 16.8% | 28% |
| App | 75.7% of frames (71% without the shots where only objects move) | 13.9% | — |
| Manga | fast moves 11.9% of the length; 82% of adjacent pairs include a scale change | 11.4% | 5.8% |
| Truck | 82.4% moving (53.6% slow drift of ~10–100 px/s, 28.9% fast), 17.6% still [partly by eye] | 19.3% | — |

Each column is a different tool, and only like with like compares
[verified]. The travel column is each film's own optical-flow or
registration reading (the truck's partly by eye); `film study` reads 35–50%
travel on the same six and a median of 17% on 67 catalogue films
(`structure.md` §1). The hold column is the external event detector of
`structure.md` §1: 91 launch and product films have a median of 40% (p25
22%, p75 57%) on it; `film study` reads 4–17% on the six and 42% on the
catalogue. The last column pairs frames 1/12 s apart with OpenMotion's frame
registration (`register_motion`, not part of open-take, and `film study`
does not report it): 62 catalogue films have a median of 29% (p25 17%, p75
39%) on it. `../motion.md`'s film: camera still in 48.5% of frames, yet only
~10% of frames with no change at all, read another way again.

Where they do hold:

- **To read or count.** The game holds only five times for 0.25 s or more,
  4.75 s in all: while counting (14.125–15.75), as the hero settles
  (29.54–29.875), as a car drives off (35.63–36.54), on the error freeze
  (43.67–44.25), while a prompt types (67.54–68.83) [verified].
- **Once, dead still, on the failure.** The flying machine's only dead
  stillness is 37.80–40.27 (optical flow 0.1–0.2 px a frame), with the
  sound pulled down at the same time [verified].
- **Once in an interface, to see the whole.** The fly's interface really
  stops once: 14 frames (0.58 s) on the complete route [verified].
- **On the payoff, late.** The flying machine's last act moves 8% of the
  time; the truck's title and its parts-board overview are its stills
  [verified].
- **Something always moves inside a hold**: typing, a turntable, a pop, a
  word swap, a blink [verified].

## 2. Transitions by kind

Every kind found, with its length, what crosses, and where [verified unless
marked]. "0 frames" means the new picture is complete on its first frame.

| Kind | Length | What crosses | Where |
|---|---|---|---|
| **One-frame scale jump inside a push** (punch-in) | 1 frame + 6–8 frames ease-out settle; the frame before is the blurred one | the same interface plane; often preceded by acceleration | fly 8.125 (2.2×), 11.042 (~3×), 25.708 (~4×); flying machine 0.967 (1.9× smaller, still tracing), 13.9 (~3×), 15.633 (×1.28), 20.733 (×1.43); app 10.4 (pull to ~0.7), 21.367 (~2.5×), 23.967 (~2.4×); truck 7.625, 14.25, 16.04 |
| **Speed ramp + one-frame jump** | 10 frames accelerating + 1 + 6–7 settling | the same plane, travelling | fly 30.875 (1.5× + ~300 px up), 34.083 (1.45×): see §3.2 |
| **Momentum cut**: the outgoing shot accelerates and is cut on its fastest frame; the incoming continues the same direction and decelerates | out 3–17 frames ease-in; in 5–16 frames | direction and speed | flying machine 3.300 up (−27 → −17.7 px a frame across the cut), 5.533 down (in at 65 px a frame, 3× the last out step of 21), 57.433 (58.567 is the same cut on a push, counted below as the push-through); fly 32.792, 33.458 (three interfaces read as one upward move at 21.5 and 17.4 px a frame); game 66.917 (14 → 16 px a frame), 71.417 (7 out + 5 in), 73.417 down (28 → 24 px a frame); truck before most cuts (last 0.1–0.25 s at 250–560 px/s) |
| **Hard cut hidden in motion blur** | 0 frames | the same object or material at speed | flying machine 25.667, 27.267 (missed by every automatic detector) |
| **Bright to bright / blur to blur** | out 3–5 frames, in 4–12 | light level, or blur | game 7.042 (glitch → white light; 24% of the cut frame pure white), 17.75 (through the lens, overexposed), 24.458 (luma 59 → 31 → 13), 41.083, 64.917 (out 4, in 12: sharpness 52 → 6570) |
| **Defocus → cut → focus** | 4 + 9 frames | the blur itself | fly 36.625 (sharpness 20.2 → 2.8, brightness unchanged); app 17.000 (~5 frames each side) |
| **Accent flash** | rise 4 frames, peak on the last old frame, 3 frames back | the character + a status chip crossing the cut | game 33.75 |
| **Glow / light, cut on the brightest frame** | push 6 + reveal 16 | forward motion, light, the target's colour already in the brightest frame | game 76.917 (the drop) |
| **Push through text into light** | 2.2× in 5 frames | forward | game 76.63–76.83 |
| **Whip cut** | 2–6 frames each side, blurred | direction, blur | game 10.875 (4), app 11.933, 30.733, 51.033 (3–5); manga between framings (3–6); flying machine 41.233 (2-frame pull-out ×0.725) |
| **Carried object** (an element of the old scene becomes part of the new) | 0.25–0.6 s | the object | app 16 of 27 changes; truck photo → thumbnail (0.25 s), tag → frame, chosen variant → final; fly PDF at the same screen point (match cut, 0 frames) |
| **The sentence continues** | 0 frames | a captioned line finishes typing in the interface | fly 4.958, 24.292; flying machine's prompt keeps typing across its morph |
| **Same-pose match cut / morph** | 0 / 10 frames | position and pose, material changes | flying machine 23.267 (grey → wood), 47.933 (photo → wireframe, background 0.78 → 0.08); manga 4.042 (live → drawn) |
| **Pull back to reveal a container** | 14–21 frames | the clip becomes a plane in space; a full-screen render becomes a window on a desktop | game 46.167, 57.458; flying machine 31.50–32.20; app 33.83–34.10 |
| **Push until it becomes the frame** | 1.9 s; 6 frames | the panel or tile becomes the picture | game 59.75–61.667 (area 7% → 83%, edges square at 61.667); flying machine 47.73 (6 frames) |
| **Outgoing scene as the wipe** | 0.23–0.4 s | none; the next is revealed underneath | app 28.200 (thread drops, wall rises), 38.1 (slides up into a banner) |
| **Hard cut dark ↔ bright, as punctuation** | 0 frames | nothing; or one icon | flying machine 40.267 (grey difference 0.768), 54.767, 66.6; game 37.417 |
| **Collapse to a dot / burst** | 0.3 s; 2 frames | the dot becomes an avatar | app 44.133 (collapse: radial blur → ball → dot), 42.700 (burst) |
| **Fade or dissolve** | 6 frames, hidden; 1 frame; 2 frames through black | — | fly 2.042 (behind a still title); manga 5.583 (1 frame), 9.958 (black) |
| **White frames** | 1–3 frames | — | fly 26.708 (2 white); truck 15.042 (1), 5.333 (3 overexposed), 21.500 (2) |

The fly never whips to change place: its whips stay between stations of one
take, and it changes place by hard cuts with motion or content carried
across [verified].

Counts [verified]: the game — 11 hard, 7 scale or jump, 2 match, 2 flash or
glow, 3 blur, 1 whip, 1 through the lens, no fades. The flying machine — 3
scale cuts, 1 match, 2 hidden in blur, 3 momentum, 1 push-through, 3 dark ↔
bright, 1 morph. The fly — 14 hard (4 of them inside motion), 1 match, 1
dissolve, 6 scale jumps, 3 panel jumps, 1 sideways jump, 1 white, 1 jump
cut.

Designed transitions in 13 other launch films, 59 of them read in frames,
have a median length of 0.25 s (p25 0.17, p75 0.40); in those not by this
maker 0.33 s [verified; no tool reproduces this count].

## 3. The camera

### 3.1 The move catalogue

| Move | Numbers | Curve | Where |
|---|---|---|---|
| Slow push at the start | 1.000 → 1.037 in 1.0 s | near linear | fly 0–1 |
| Accelerating roll-dive into a dissolve | ~35° roll, ~1.6×, 12 frames | accelerating throughout | fly 1–2 |
| FPV flight | ~1.5% of frame width a frame (4.9 px at 320 wide); roll 15–25°; never stops | constant, fast | game 0–4.17 |
| Drop-in entrance | 195 px (27% of height) in 0.47 s; 65 px on the first frame | `cubic-bezier(0.1,1,0.95,1)`, all force in the first frame | flying machine 5.533–6.0 |
| Exit with momentum | 85 px, 69 px in 8 frames | `cubic-bezier(0.775,0,0.975,1)`, cut on the fastest frame | flying machine 3.033–3.267, 5.267–5.5 |
| Continuation after the cut | from +57 px, −17.7 → −0.5 px a frame | 8 frames, `cubic-bezier(0.275,0.8,0.675,1)` | flying machine 3.300–3.567 |
| Push while typing | 1.37× in 0.5 s | — | flying machine 6.1–6.6 |
| Follow the pointer sideways | ~350 px (27% of width), peak −57 px a frame, 0.63 s | slow start, long tail | flying machine 7.467–8.1 |
| Background pull-out | 1.51 → 0.90 in 20 frames | on log scale `cubic-bezier(0,-0.05,0.3,1)` | flying machine 10.267–10.933 |
| Push peaks | every 0.6–1.0 s | — | flying machine 12.10 / 12.78 / 13.37 |
| Whip pull-out | 1 → 0.624 in 6 frames, the first two fastest (−0.17, −0.145) | front-loaded | flying machine 19.40–19.60 |
| UI truck + slight pull | 0.154 W, 0.969×, 0.58 s, peak 19 px a frame | ease-in-out | fly 4.96–5.54 |
| Push on a map | 1.64× in 8 frames | accelerate, then decelerate | fly S12 |
| Whip + rotation on a map | +34, +78, +127 px, then 15–20° | accelerating; pins stay upright | fly S12 |
| Sideways whip pull-out | 0.79×, peak 94 px a frame, 14 frames | symmetric ease-in-out | fly S17 |
| Flick upward into the cut | 3 → 22 px a frame over ~10 frames | ease-in; cut on the fastest; the next shot's first frame keeps going up | fly S17, S18 |
| Accelerating push into the cut | 1.48× in 17 frames, 1.32× of it in the last 6 | ease-in | fly 44.25 |
| Hold → accelerating pull-out | held 0.96 s; scale 1.006 → 0.801 in 9 frames, 4 → 31 px a frame | ease-in | game 23.08–24.42 |
| Fast push to a face | 0.059 → 0.330 W in 10 frames (5.6×) | slow-fast-slow, hard landing, no overshoot | game 32.58–33.0 |
| Crop grows faster than its content | frame 0.711 → 0.928 W while content 0.904 → 1.0 | ease-out | game 28.67–29.3 |
| Type receding from the lens | ≥2.4× → 1.0 in ~0.5 s, each frame taking 25–30% of what is left; then −5% a second, linear | exponential, then linear | game 37.42–37.92 |
| Time freeze | 9 frames slowing, 14 frozen (0.58 s), 9 accelerating | — | game 43.29–44.58 |
| Accelerating push | 1.02 → 1.39 per frame, ×1 → ×3.05 in 0.30 s | ease-in | app 2.20–2.50 |
| Decelerating pull-out | 0.833 → 0.387, each step smaller (×0.85–0.97 a frame) | ease-out | app 33.83–34.10 |
| z at constant speed into a card | front card 60% → 75% → 100% of frame on three frames; reads as accelerating | linear in depth | app 37.27–37.8 |
| Whole-frame drift that accelerates before the cut | 10–60 px/s early, 250–560 px/s in the last 0.1–0.25 s | ease-in, about power 4–5 at the end | truck shots 3, 5, 6, 13, 14, 15, 17, 19, 20 |
| Decelerate in, near stop, accelerate out | outline y every 0.125 s: 495, 486, 482, 480, 473, 468, 446, 405, 335 | — | truck 20.08–21.5 |
| Push on a detection box | scale 1.006 / 1.031 / 1.042 / 1.055 / 1.075 at +0.3 / 0.6 / 0.9 / 1.2 / 1.44 s, then up 72 px in 0.24 s | accelerating | truck 18.6–20.08 |
| Text block shrinks to a header | width 1408 → 712 in 2 frames | back.out(1.5) | truck 28.46–28.54, 32.25–32.33 |
| Constant scroll | 4.6 px a frame (110 px/s) for 3.4 s | linear | fly 54.0–57.4 |
| Locked, content moves | scale 1.007 over 67 frames; 1 px a frame | — | fly S25, S27, S29 |
| Accelerating push on a count | type 119 → 182 px in 1.5 s | ease-in | manga 52.7–54.25 |
| Slow push on the payoff | 1.00 → 1.08 in 0.7 s, then to 1.10 | decelerating | game 79.875–81.46 |
| Slow to a freeze | adjacent-frame difference 17 → 3.4 → 2.3 → 0.6 | decelerating | game 82.75–84.96 |

### 3.2 Changing place inside one interface: accelerate, jump, settle

Long distances inside an interface are not flown with one continuous move
[verified]. At the fly's 34.083: the frames before the jump add up to
1.24×, the jump is 1.45× in one frame, the six frames after add 1.13×;
2.03–2.07× in all in 0.83 s. Per frame: ×1.0004 rising to ×1.059 before, the
jump, then ×1.075, 1.026, 1.016, 1.008, 1.003, 1.000 after (these steps
multiply to 2.03×; the chained transform, which also follows the moving
centre, reads 2.07×). In position: 3 → 24 px a frame, jump,
31 → 4.5 px a frame. The motion blur is concentrated on the frame before the
jump; two frames after, the picture is sharp [verified in frames 812–827].

The same ~2.07× as a continuous push in the same 20 frames would need ×1.106
a frame at its peak (the original's largest step outside the jump is ×1.075)
and would already be pushing ×1.026 a frame where the original is at
×1.0002. Rebuilt both ways on a page, the continuous version blurred earlier
(Laplacian variance 89 and 48 on frames 5 and 7 against 223 and 159) and read
as a slow push, not a snap into place [verified measurements; the reading is
[inferred]].

### 3.3 Several stations in one take

[verified unless marked]

- **Asymmetric legs.** On the fly's tilted map (39.25–44.25, five stations),
  each move accelerates for 5–6 frames and decelerates for 10–12, slowing by
  about ×0.73 a frame; peaks 110–187 px a frame; legs of 14–24 frames; a
  small roll of 0.3–1.7° a frame on the way.
- **Dwell without stopping.** Each station holds 3–8 frames at 0.1–0.5 px a
  frame, never zero, then leaves. Stations are 0.75–1.08 s apart, about two
  beats, but the whip peaks are 60–110 ms off the beat.
- **Land every station on the same composition.** The game's three data
  panels each land centred at 0.635 W (810 / 814 / 809 px wide in a
  1276-wide frame); panel 1 lands in ~0.33 s, panel 3 in ~0.9 s, ease-out.
- **How stations connect** in the game's 23.8 s take: pulling back to reveal
  the container (46.167, 57.458), following something that moves (a light
  dot 58.9–59.42, a ball's trail 51.33), a whip (52.17, 8 frames), passing
  under or through an object (a panel at 54.58 in 8–9 frames; particles at
  49.83), pushing in until the object is the frame (61.667). About 21
  stations in 23.8 s, ~1.1 s each. The pull-back at 46.167 and the push at
  61.667 bracket the whole stretch [inferred].
- **The flying machine's 13 s take** has nine stations: under the wing →
  slowing to real time on the finished machine (28 → 7 px a frame over
  1.4 s) → pulled back to a window → 0.3 s on the desktop → the next window
  lifts → orbit a quarter turn in 3.5 s → break → still → result card.

### 3.4 The pull-back reveal: frame width linear, not distance

When the game's full-screen clip is pulled back into a plane in space
(46.167–47.2), the plane's width on screen falls almost linearly: 0.950,
0.892, 0.845, 0.797, 0.761, 0.722, 0.678, 0.642, 0.619, 0.578, 0.547, 0.527,
0.495, 0.472 W on frames 1109–1122 (about 0.037 W a frame), its centre
moving 0.50 → 0.68 W; then about 0.017 W a frame [verified, re-read from the
measurement]. Constant width per frame means the camera's distance is
accelerating. A page that dollied at constant speed shrank too fast early
(0.08 W off by frame 6); setting distance ∝ 1 / (linear width) stayed within
0.03 W for 10 frames [verified]. The three frames before the pull-back carry
a radial zoom blur (1106–1108) [verified].

### 3.5 Window hop: pull out, pause, the next window lifts

The flying machine at 31.5–33.23 [verified]:

1. **Pull out of the render** to a window on a desktop: the window's width
   1276 → 1185 → 680 → 515 (2.5×) in 0.7 s; slow start, the middle three
   frames fastest, a 10-frame ease-out tail.
2. **Pause 0.3 s** on the desktop.
3. **The next window lifts toward the lens**: 430 → 470 → 660 → 780 → 1135
   px wide → full frame (~3×) in 0.7 s, fastest late (one step of ×1.45
   between frames 988 and 990). Meanwhile **the desktop does not scale**:
   0.993–1.043 while it can be tracked; it translates about −50 px, and is
   carried out of frame at ~−40 px a frame only in the last 5 frames. The
   main window keeps its size (285–287 px tall).

A page that scaled the whole desktop instead measured 1.09 → 1.80 desktop
scale and a 1.24× window over the same stretch [verified]. The same film
pushes at 11.4–11.7 with the window at 2.4× and the background at ~1.5×
[verified, low support].

### 3.6 Across cuts

- Direction usually continues across a cut (fly 31.92–33.46: three
  interfaces read as one upward move). Exception: fly 39.25, the fly exits
  right and the map enters drifting left [verified].
- Interface moves carried across cuts run 14–28 px a frame at 1276 wide
  (about 500–1000 px/s at 1080p): a handover, not a whip [verified, game
  64.9–77].
- The truck accelerates into most cuts; a page rebuilt with power 3 over
  70 px was not steep enough (−58 px at +0.79 s against −68.9 at +0.87; last
  ~107 against ~250 px/s) [verified].

## 4. Layers and depth

**2.5D: layers scaled separately** [verified]:

- Window hop (§3.5): the window lifts ~3× while the desktop stays at
  0.99–1.04 and only translates.
- Status chips are outside the camera: during a 3-frame fast push
  (flying machine 17.37–17.53) the chip in the lower left did not move at
  all. Worker labels pinned to 3D points keep their text size as the camera
  pushes (game).
- A banner line stays in place through four changes of picture, including a
  scale jump in a spin blur (manga 9.958–15.917).
- The fly's pins scale with the map (both ~2.1× between frames 812 and 822)
  but stay upright when the map rotates 20°.

**Stacks, back to front** [verified]:

- Fly, live shots: heavily blurred room → desk (sharp front, soft back) →
  the fly (sharp, 0.1–0.5 of the width) → voice orb + caption at 0.86–0.93 H.
  Interface shots: white (or dark grey) → card or panel with a thin border
  and a soft shadow → the one focused element; no depth of field.
- Game: near-black void and vignette → soft, low-contrast far layer (point
  cloud, distant panels, bokeh, fog) → the subject, usually the brightest
  thing → near things heavily motion-blurred (roofs, palms, grid cells,
  passing cards, particle trails) → the screen-space overlay, always sharp.
- App, 3D stack: white → cyan glow → back card (sharpness 19%) → focal card
  (100%) → front card (44%) → chips and connector lines → title. The focal
  plane is in the middle, so the front card is soft as the camera pushes
  into it.

**Real perspective appears only in a few shots** [verified]: the fly's tilted
3D map (tilt-shift bands top and bottom, vignette, chromatic aberration;
cards falling into the blur), the game's tilted glowing screen, the app's
corridor and stack, the flying machine's 3D tool, wooden machine and orbit.

**Depth of field used as a transition** [verified]: whole frame out of focus
for 6 frames and darkened under a title (game 4.17); bokeh circles growing
into a window (game 24.46–25.5); defocus out in 4 frames (sharpness
141 → 16), focus in over 9 (8 → 615); a title defocused in 0.21 s behind a
reply (`../motion.md`); the flying machine's launch title appears in the
same frame as the picture behind it drops to ×0.71 brightness and half its
sharpness (60.300).

A 3D stack rebuilt with CSS on a page had to be pushed away with
`translateZ`, not `scale()`, or the depth flattened; and the stack should
only straighten in the last frames of the push (rotation on power3.in, back
cards fading in the last 20%) [verified].

## 5. Motion inside the frame

### 5.1 Curves: five families

[verified fits; grouping from the catalogue sweep]

| Family | For | Examples |
|---|---|---|
| A. Fastest at once, exponential slowing | things flung, dragged or dropped in; interface entrances | drop-in `cubic-bezier(0.1,1,0.95,1)`; pill x 810 → 646 in 0.375 s, power2.out; `../motion.md`'s pointer fling ×0.72–0.78 a frame |
| B. Pure acceleration to the exit, cut on the fastest frame | outgoing scenes, momentum cuts | `cubic-bezier(0.775,0,0.975,1)`; the truck's last 0.1–0.25 s at 250–560 px/s |
| C. Slow start, fastest near 30%, long tail | camera pushes, counts | `../motion.md`'s push `cubic-bezier(0.48,0.08,0.07,1.02)`; a catalogue film's push in 0.12 s steps of 1.011, 1.029, 1.049, 1.079, 1.527, 1.126, 1.073, 1.025, 1.006 |
| D. Linear | long drifts, slow pulls, scrolls | 4.6 px a frame scroll; −5% a second recession |
| E. Overshoot | rarely: an angle, a mark swelling, a number | input bar `back.out(2.4)`, 10% over in 0.3 s; a tile `elastic.out(1,0.4)`, 14% over in 0.267 s (app) |

A film rarely uses one curve for everything: entrances, exits and the camera
each take a family, and exits often never slow down [inferred].

### 5.2 Durations

[verified]

- Settling actions (a stamp, a word swap, a highlight): 1 frame.
- Element entrances and exits: median 0.33 s in 91 films; 0.27–0.42 s in the
  reels (both from the external event detector of `structure.md` §1, which
  `film study` does not reproduce).
- Status chip: a dot grows to a capsule and the text spreads from the middle
  out in 6 frames; it shrinks to a line in ~10 (game). Typed in at ~125
  characters a second, deleted at ~110, back to a dot (flying machine).
- Button press: shrinks 4 frames, rebounds 3 (fly); 164 → 100 px (0.61×) in
  2 frames, held 4, released 3, no rebound (game); 0.76× in 6 frames,
  released in 6, held 2 (flying machine).
- Pixel or light burst on send: area 1.2% → 11.2–12.8% in 5 frames, fades in
  7–10 (fly, twice nearly identical); rays: 1 dark frame, 5 frames to the
  frame edge, gone in 1 (game).
- Card from a pin: opens 4 frames, closes 3 (fly). Pin drop: one every 3
  frames, born blurred at ~1.4×, falls 0.125 H, set in ~4 frames.
- Window out of the dock: width 0.306 → 0.706 W, steps 0.141 / 0.134 /
  0.103 / 0.022 W, recoil −2.6% (fly).
- Panel rises and darkens: 5 frames, ~40 px (fly). Row inserted into a list:
  3 frames, pushes the rest, no bounce.
- Develop: a new image goes two-tone (magenta-ish), then a second tone, then
  black and white in ~10 frames (manga 26.33 → 26.75; read again on frames
  632–643: first tone to frame 636, second 637–641, finished by 643). The
  whole page blurs sideways for 3–4 frames as each panel arrives.
- Sweep: a band of light crosses a photo and leaves a drawn card behind
  (manga 19.67–20.10; brightness 0.10 → 0.40 → 0.22).
- Generated tiles: 2×2 staggered ~0.1 s, in place in 6–8 frames, two-tone
  first, developed top-left to bottom-right in 0.5 s; selection dot → box →
  fill in 0.5 s (flying machine).
- Detection box: label typed one letter a frame, outline drawn in ~0.25 s,
  percentage counts up one step a frame (truck 18.5–18.8: 3, 48, 60, 72, 84,
  96 on frames 448–453).
- Running numbers on a failure: three counts together, power2.out, 1.07 s
  (flying machine); a card pops 0.55 → 1.0 in 2 frames.

### 5.3 Build-ups get faster

[verified] The fly's packshot pops 13 times at intervals of 1, 2, 3, 6, 4, 8,
4, 1, 1, 2, 2, 2, 1–2 frames, no fade, no bounce; layers grow one every
2 frames; pins every 3. The app's worker list: rows 0.5–0.65 s apart, the
last three in 14.6–14.9. Counting steps 8, 8, 9, 12 frames, the last slowed
(game). Catalogue: a montage at 20 → 4 → 2 → 1 frames a shot; app icons
0.52 → 0.11 s.

### 5.4 The subject moves the camera

Where the camera is locked on a live subject, the subject does the move: the
fly lunges 1.5× in 8 frames and backs off before the cut, walks into the lens
in 3–14 frames, flies out of frame, jumps twice (6–8 frames each) [verified].

### 5.5 Mixed frame rates

The flying machine's interface runs at a true 30 fps while its 3D and live
footage is 24 fps material on a 30 fps timeline (one frame repeated every 5)
and its moves there are slow. The game's anime is on twos, then threes.
`../motion.md`'s brand mark is on twos [verified].

## 6. Words on screen

**Status chips**: one per step, in the present tense, 3–4 words with a
gerund, white on a dark or frosted capsule, 0.03–0.05 H, with a small
spinner or icon. Fixed in the lower left of the screen in the flying
machine; under the work elsewhere. A chip can slide across the frame to
change its text (~990 px in 7 frames) and can cross a cut (game 808–814)
[verified]. The manga's chip lists a feature and changes every 0.9–1.2 s.

**Typed prompts** [verified]:

| Film | Rate | Shape |
|---|---|---|
| Game | 43 characters in 22 frames (~47 a second): 2–6 a frame early, ~0.5 a frame at the end; 60 → 15 and 85 → 23 a second; a slash command ~8 a second | fast first, slow last; the newest 4–10 characters warm-coloured, cooling to white in 4–8 frames; no typing sound |
| Fly | 24–75 a second; the key instruction slowest, one character a frame, set small (0.02 H) in a field of white, then a 4× jump to send | |
| Flying machine | 43 characters at ~59 a second; prompt bar ~120 a second; reply lines 62 and 100 characters a second, soft-edged, left to right | |
| Truck | 42 characters at ~53 a second, accent colour, cooling to grey at 7.04 | |
| App | ~50 a second, the last character in the accent | |
| Manga | ~43 a second; a line in a banner in 0.29 s, the newest word flashing two accents | |

**Captions under the lead** (fly; whether a voice speaks them is uncertain): 0.06 H, white, centred at 0.86–0.93 H,
under a voice orb that grows in 2 frames; each word fades grey → white in 2
frames, words 3–16 frames apart (~2.5 words a second), the line centred on
its final width from the start; 2–8 words, one line per shot; gone one frame
before the cut [verified].

**Titles** [verified]: a line of 30–36 characters appears in 0.10–0.20 s
while rising 19–40 px, then holds 0.8–2.5 s (app; read again on frames
671–679: a hard cut, the line starting 4 frames later and still completing
on 679). Truck cards: an icon, left-aligned text, a soft-edged mask sweeps
each line in 0.2–0.45 s while it rises ~175 px, the brand accent fading to
grey, then an accelerating exit; 1.4–1.75 s each. Game claim cards: type
already moving as it enters (scaling in from ≥2.4×), white-to-grey gradient,
0.039–0.054 H. Game title: letters blur to sharp about 1.5 frames apart, each
sharp in 3–4 frames, done in 0.7 s; exits by glitch in 5 frames.

**Labels**: worker cursors — an arrow, a saturated tag, a task name in bold
(0.017–0.018 H text) — 39 appearances of 28 names in the game, pinned to the
part being worked on and gone when that part is done; 16 named cursors in
the flying machine's 3D tool. They stand for "many workers at once" without
a card saying so [inferred]. Data tags with a leader line follow a ball
(`1425 px/s`).

**Information as numbers and colours** [verified]: three coloured boxes with
three numbers (67 yellow, 16 red, 96 green), the last pushed in on (truck);
three running numbers on the failure (flying machine); an error header and
one line on a dark red panel, 0.13 H (game).

**Call to action**: one line, white capitals, 0.028–0.049 H, centred, no box,
there from its first frame; the picture behind darkens (−20% in 4 frames in
the game; ×0.71 in one frame on the flying machine's launch line) [verified].

**How much is read**: words meant to be read sit large (pushed in until
~0.05 H on screen in the fly); interface text 0.012–0.07 H, layer names and
lists are texture and not meant to be read [verified].

## 7. Uncertain

- Camera paths in 3D shots (orbit angles, lens) were not measured; the
  numbers above are screen-space.
- Registration tools returned confident but wrong numbers on 3D pushes, live
  footage and spinning objects; every number here kept from such shots is
  cross-checked against frames or another measure.
- The truck's motion shares are partly judged by eye.
