> What this is: frame-by-frame measurements of how the same launch film moves —
> every transition, its motion vocabulary and curves, speeds and durations, and
> when its camera holds — translated from sections 0–4 of a research report
> (section 5 onward is left out), with the parts that only made sense on the
> researcher's machine removed. The marks say how each claim stands:
> [verified] = backed by a measurement or frame-by-frame images,
> [inferred] = derived from measurements but not measured directly,
> [uncertain] = could not be found, or the method is limited.

# Frame-by-frame breakdown: "Introducing Claude Whiteboards, Sheets, and Data" (transitions, motion, camera)

Source: "Introducing Claude Whiteboards, Sheets, and Data", YouTube channel
"Claude", uploaded 2026-11-10; 1920×1080, 24 fps, 1386 frames, 57.75 s. Measured
2026-11-12.
Scope: only "how things move". Story, rhythm structure and sound were covered by
another researcher.

Marks: **[verified]** = there is a measurement output or frame-by-frame image to
back it; **[inferred]** = derived from measurements but not measured directly;
**[uncertain]** = could not be found, or the method is limited.

---

## 0. Conclusion in one sentence

Apart from the 2.2 s of T16, the film is entirely **2D** (about 96% of its
length): a virtual camera that only pans and zooms (no rotation, no perspective
tilt, no handheld shake, **no motion blur at all**), moving through **one
continuous world**; the whole film has only **3 hard cuts**, and all three fall
on the frame of fastest motion (cut on the motion). What makes it "look as if it
is always moving" is not the camera but **content that keeps being built while
the camera holds**: the camera is completely still in 48.5% of frames (counting
only frames whose features are reliable), yet only about 10% of frames show no
change at all (9–14% depending on the threshold), and the longest stillness is
only 10–17 frames (0.42–0.71 s). The signature move is "Claude's cursor is flung
into frame (peak 8600 px/s, exponential deceleration), and objects stamp into
place in a single frame where it arrives (1.19× → 1.0 in just 1 frame)".

---

## 1. Method and limits

| Item | Method |
|---|---|
| Overview | Contact sheets of every 12th and every 3rd frame |
| Frame-difference curve | Per frame at 480×270 greyscale: mean\|Δ\|, share of changing pixels, phase-correlation translation |
| Camera | Per-frame ORB features at 960 px wide + RANSAC similarity-transform fit (scale/rot/tx/ty), segmented into "moves" with easing fitted to each |
| Elements | Segmentation by color / darkness at full resolution (1080p), measuring bbox, minAreaRect angle, centroid |
| Motion blur | Full-resolution Sobel directional-gradient ratio (horizontal blur lowers gx/gy) + visual check of full-resolution crops |
| Cross-check | This tool's own `film probe` run on the same film |

Limits (stated honestly):
- This is YouTube's 24 fps version; the master's frame rate is **[uncertain]**.
  Every frame is a distinct image (no duplicated frames in the moving
  stretches), so I infer the master is 24 fps, but this cannot be proved.
- The ORB similarity transform assumes "most features are on the same layer"; it
  is unreliable when the content is sparse (only grid lines) or when large areas
  of new content appear (e.g. f355–f359, where only the periodic grid is left,
  and f1100–f1154, the logo burst with depth-of-field blur). For those stretches
  I used element tracking instead, or only looked.
- The KPI numbers were **read by eye** from full-resolution crops; the last
  digit is mid-roll, so the readings carry an error on the order of ±1%.
- Element displacements such as "text rises 45 px" are inaccurate in the first
  1–2 frames, while another layer covers the element; the tables exclude these
  or say so.

---

## 2. Transition catalogue (every scene handoff in the film)

Timecode = frame number / seconds (24 fps). "Duration" means the visible change.

| # | Time | Duration | Type | What "crosses over" | Both sides moving at once? | Blur |
|---|---|---|---|---|---|---|
| T0 | from f0 | — | Moving from the start: the "New in" capsule is already rising at 11 px/frame on frame 0 and decelerates to a stop within 0.46 s; the Claude cursor (orange I-beam + name pill) enters and types "Artifacts" | — | Yes | None |
| T1 | f60–f96 (2.50–4.00 s) | 36 frames / 1.5 s | **Morph in place: the letters are replaced one by one with product icons**. Left to right, every ≈2 frames (83 ms) one letter disappears and one line icon draws on (each ≈6–8 frames); the row re-centers; "New in" fades out | The positions and baseline of the letters | Yes (staggered) | None |
| T2 | f115–f164 (4.79–6.83 s) | ≈2.0 s | **Dragged in by collaborator cursors**: the icons are deleted one by one from right to left (≈1.5–2 frames each, like backspace); meanwhile the "Plan it out with" text box is dragged in by a cursor from the left edge, tilted 21°, and 0.625 s later "Claude Whiteboards" is dragged in by another cursor from the lower right (−11.6°). Then the whiteboard grid draws on line by line at f160–f200 | The product's meaning itself (a multiplayer whiteboard); the ground (light beige) does not change | Yes | None |
| T3 | f229–f261 (9.54–10.88 s) | 1.33 s | **Camera pushes in to the part in use**: an avatar pops in, the comment input unfolds from behind the avatar (≈8 frames), camera ×1.44 + pan 559 px | The same world | Yes (pop + push-in) | None |
| T4 | f331–f377 (13.79–15.71 s) | ≈1.9 s | **Camera whips across the canvas**: once the message is typed, the camera whips right across the empty canvas (ease-in p³ 1.0 s, last frame 165 px/frame ≈ 4000 px/s); 4 frames of grid only; the Claude cursor is "flung" in from the right edge (peak 358 px/frame ≈ 8600 px/s, exponential deceleration, settled in 0.63 s, overshoot ≈10 px) | The canvas grid (the world itself) + the cursor becoming the new lead | Yes | **None** [verified] |
| T5 | f380–f449 (15.83–18.71 s) | 2.7 s | **Pulling out while building, revealing that it is inside the app**: sticky notes stamp in within one frame, illustrations draw on, the timeline path draws; the camera pulls out ×0.566 (easeOutCubic); at f404–f420 the app frame (title, avatars, toolbar) comes in from the edges of the frame | The same world; the thing being made | Yes | None |
| T6 | f522–f552 (21.75–23.00 s) | 0.92 s + 0.4 s | **Slide-out reveal (the outgoing scene is itself the wipe)**: the whiteboard window accelerates out to the left with ease-in p³ (1419 px / 0.92 s, last frame 260 px ≈ 6250 px/s); where its right edge sweeps past it reveals the chapter title, which was **already in place**; the title's two lines each rise 37–56 px, grey → ink, the second line 3 frames later; the chapter icon draws on (0.375 s); the spreadsheet grid lines fade in | The ground (beige); no object crosses | Only the outgoing scene moves sideways; the title only rises in place | None |
| T7 | f612–f668 (25.50–27.83 s) | ≈2.3 s | **Focus shift + a vertical cut on the curve**: Claude's reply "You got it." appears in orange → ink, and the title behind it goes out of focus within 5 frames (0.21 s); then the chat bubble and the reply accelerate upward (≈220 px, last frame 93 px ≈ 2230 px/s) → **hard cut at f649** to the Sheets app, the same conversation already in the left chat column, the incoming picture still moving upward and decelerating (34→1 px/frame, ≈0.8 s) | The conversation's content (continuity of meaning; position and size do not line up) | Yes, same direction | Defocus blur (not motion blur) |
| T8 | f693–f720 (28.9–30.0 s) | 1.17 s | Within a scene: inside Sheets, pan 832 px + pull-out ×0.913 (in-out) | — | — | None |
| T9 | f766–f800 (31.92–33.33 s) | 0.79 s + 0.6 s | Same as T6 (second time): the Sheets window slides out with ease-in p³ (1329 px / 0.79 s, last 268 px/frame ≈ 6400 px/s), revealing "Share a story with Claude Data"; this time grey → ink is slower (≈10 frames), rise 35 px | The ground | Same as T6 | None |
| T10 | f800–f878 (33.33–36.58 s) | 3.25 s | **Title and product in the same world**: a card grows from a capsule into a card (≈5 frames), the KPI counts up in 0.875 s, the line draws, table rows appear staggered; the camera pans 1056 px (1.62 s) so the title leaves on the left, and new cards grow only as the camera reaches them; finally a move downward brings out the app frame (f864–f876) | The same world | Yes | None |
| T11 | f891–f921 (37.13–38.38 s) | 1.25 s | Push-in ×1.82 to the top-right toolbar; the cursor moves to Design; the Design panel pops open | — | Yes | None |
| T12 | f933–f953 (38.88–39.71 s) | 0.83 s | **Cross-dissolve during a pull-out (reverse depth)**: click on Scrollyteller; the newly generated presentation appears at ≈1.85× and shrinks back to 1× (×0.539, in-out, peak at 0.6); the old UI fades out within ≈6 frames (0.25 s) | Nothing (triggered by the click) | The new one shrinking, the old one fading | **None** |
| T13 | f975–f1034 (40.63–43.08 s) | 2.5 s | Within a scene: the presentation really scrolls (scrollytelling), two scrolls overlapping: the speed drops to 10 px/frame at f1004 but picks up again without stopping | — | — | None |
| T14 | f1043–f1075 (43.46–44.79 s) | 1.33 s | **Jump cut inside a push-in (or a speed change)**: push in toward Share, ease-in p⁴ (×1.38, 0.83 s); at f1063 ×1.43 within one frame; then ease-out quint (×1.44, 0.5 s) | The same UI | Yes, same direction | None |
| T15 | f1090–f1108 (45.42–46.17 s) | 0.75 s | **Hard cut on the click + burst**: the cursor stops on Share, the camera accelerates its push-in (f1096–f1099) → **hard cut at f1100** to empty ground; integration logos burst out from a point, ≈4 frames (0.17 s) to complete 90% of the spread | Nothing (triggered by the click) | Yes | None |
| T16 | f1108–f1160 (46.17–48.33 s) | 2.2 s | **Flying through the logo cloud (the only 3D)**: the camera moves forward, near logos grow, go out of focus by depth and pass the lens; as the last few big blurred color blobs go by, the line behind them, "Plan at the speed of thought", appears grey → ink | The ground | Yes | Depth-of-field blur |
| T17 | f1184–f1244 (49.33–51.83 s) | 2.5 s | **Word swap in place (a product action: select + replace)**: the Claude cursor selects "Plan" (the highlight appears in 1 frame); one word is swapped every 14 frames (0.583 s), Build → Share → Work, replaced instantly, the whole line reflowing instantly; f1244 deselect | The sentence itself | No (instant) | None |
| T18 | f1245–f1310 (51.88–54.58 s) | 2.7 s | Named collaborator cursors (Mia, June, Rosa, Dev) are flung in from the frame edges and add stickers and reactions on the sentence; finally the whole line accelerates upward and leaves (29→48→101 px/frame) | — | Yes | None |
| T19 | f1306–f1385 (54.42–57.75 s) | 0.8 s + 2.4 s hold | **Gathering into the brand mark**: a dot in the center grows into the Claude spark (65→116 px, holds 5 frames, swells to 146–160 px, then back to 120 px), slides 218 px left to make room, and "Claude" types on letter by letter (≈5 frames for the 6 letters); holds 2.4 s, the spark's rays keep changing **on twos (12 fps)** | — | — | None |

**Count [verified]**: 3 hard cuts (f649, f1063, f1100), all on the frame of
fastest motion; the other 16 handoffs are continuous.

**Cross-check [verified]**: this tool's `film probe` reports "no hard cut" for
this film, because its cut detector requires the frame's change to be 2.5 times
the second-largest change nearby; but both sides of these three cuts are moving
fast (f649 diff 10.4, neighbors 5.4 / 4.9 / 4.4, a ratio of about 2; f1100 17.9,
the frame before 18.7), so they are not detected. This is exactly the effect of
"a cut hidden in the action", but it also means probe undercounts cuts when it
measures reference films.

---

## 3. Motion vocabulary

### 3.1 Entrances and exits

| Move | Numbers measured | Basis |
|---|---|---|
| **Cursor fling** | f359–f374: x 1834→370.5 (1464 px) in 15 frames (0.625 s); peak 358 px/frame (≈8600 px/s, at f361); after that the speed falls by about ×0.72–0.78 per frame (time constant ≈0.14 s); it overshoots by ≈10 px at f374 and is back at f377; y slides slightly downward the whole way (a slightly curved path); fitted cubic-bezier(0.15, 0.33, 0.06, 1.00). The cursor at the end of T16 enters from below: the same exponential deceleration, decaying more slowly (≈×0.85/frame) | Cursor tracking and a Bézier fit [verified] |
| **Object stamp** | A sticky note appears at f382 at 419×361 and is already 351×304 at f383 (1.19×→1.0, **in just 1 frame, 42 ms**), with no bounce; the frame it appears in shows a curled-up paper corner | Element tracking [verified] |
| **Dragged-in objects** | "Plan it out with": center (420,649)→(879,420), ease-out (fitted cubic-bezier(0.17,0.84,0.53,0.98)), ≈0.6 s; **tilt** 21.0°→0 (f124→f140.5, 0.67 s) → overshoots to −5.06° (f145, about 24%) → back to level; on release, f147→f148, it "snaps" to its layout position in one frame (the center jumps 59 px / 39 px). "Claude Whiteboards" enters 15 frames (0.625 s) later from the right edge, x speed 93→128 px/frame (peak ≈3070 px/s), then decelerates; angle −11.6°→+2.1° (≈18% overshoot), snaps at f162 | Element tracking [verified]; "like a damped pendulum spring, ζ≈0.4, ≈0.6 Hz" is estimated from the overshoot ratio and the time of the peak [inferred] |
| **Chapter titles** | The two lines rise separately: in T9 the first line rises 35 px (≈14 frames, ease-out), the second line 3 frames (0.125 s) later, rising ≈23–30 px; grey → ink: fast in T6 (2 frames), slow in T9 (≈10 frames, grey level 171→33). The title's x does not move at all | Element tracking and the rise measurements above [verified] |
| **Exit of the outgoing scene** | Always to the left, ease-in, accelerating until it leaves the frame, never a fade: T6 p³ 0.92 s, T9 p³ 0.79 s, T4 p³ 1.0 s, T14 p⁴ 0.83 s (fit RMS 0.028–0.039) | Easing fits [verified] |
| **Burst** | From f1100 the logos spread out from a point, bbox half-width ≈250→707 px (4 frames) → 784 (6 frames), then turning into a slow, continuing expansion (the start of the fly-through) | Element tracking [verified] |
| **The closing mark** | Dot → spark 65 px → 116 px (4 frames) → holds 5 frames → swells to 146–160 px (≈+35%) → back to 120 px; meanwhile it slides 218 px left (f1317–f1326, 0.375 s, in-out with the peak in the middle) | Element tracking [verified] |
| **Whole-line exit** | In T18 the whole line accelerates upward (29→48→101 px/frame) and leaves, while the center dot appears | Camera tracking, f1302–f1308 [verified] |
| **Cross-dissolve** | Only one, at T12, ≈6 frames | Full-resolution frames, by eye [verified] |

### 3.2 Typical durations (frames @ 24 fps)
- "Settling" actions (stamp, highlight, word swap): **1 frame**.
- Pop-ins, cards growing from a capsule: **4–8 frames** (0.17–0.33 s).
- Text grey → ink: **2–10 frames**.
- Cursor arrival: **15 frames** (0.63 s) + 3 frames of bounce-back.
- Camera push-in: **30–32 frames** (1.25–1.33 s, but 90% done at 0.5–0.6 of the
  move, i.e. within ≈0.65–0.8 s).
- Pull-out: **65 frames** (2.7 s).
- Slide-out exits: **19–24 frames** (0.8–1.0 s).
- Each bar of a bar chart: **≈19 frames** (0.8 s).

### 3.3 Easing character [verified: curve fits to the tracked motion]

| Move | Closest curve | Where speed peaks |
|---|---|---|
| Push-in (T3, T11) | cubic-bezier(0.48,0.08,0.07,1.02) / (0.55,0.05,0.00,1.12), RMS 0.004 / 0.010 | 0.30–0.31 |
| KPI count | cubic-bezier(0.32,0.15,0.39,1.06), RMS 0.002 | 0.30 |
| Pull-out (T5) | easeOutCubic (RMS 0.048); bezier(0.25,0.06,0.10,0.91) | 0.15–0.17 |
| Shrink-back during the cross-dissolve (T12) | cubic-bezier(0.89,−0.10,0.35,0.97), ≈inOut3 | 0.60 |
| Slide-out exits, first half of the whip | ease-in p³ (T14 p⁴) | 1.0 (accelerating to the very end) |
| Cursor fling, dragged-in objects | Exponential ease-out | 0.0–0.08 |
| Bar growth | Ease-out with a soft start (fastest on frame 2), then ≈×0.85 per frame | ≈0.1 |

**Pattern [inferred]**: this film uses only three families of curve: (a) "gentle
start, peak at 30%, long settling tail" for **camera push-ins and numbers**; (b)
"pure acceleration until it leaves" for **exits**; (c) "fastest at once,
exponential deceleration" for **things that are flung or dragged in**. Spring
overshoot appears only in "the angle of dragged objects" and "the swell of the
mark"; position itself barely bounces.

### 3.4 Stagger
- Letters → icons: one per ≈2 frames (83 ms); icon deletion: one per
  ≈1.5–2 frames.
- The chapter title's two lines: 3 frames (125 ms).
- Bars: one per 3 frames (125 ms), the last one 4 frames later (f860, f863,
  f866, f869, f873).
- The two dragged-in text boxes: 15 frames (625 ms).
- Word swaps: one per 14 frames (583 ms) (the first after 16 frames).

### 3.5 How text appears
- **Typing** (the opening "Artifacts"): 9 letters done in ≈13 frames,
  ≈15–17 cps, at irregular intervals of 1–2 frames; each new letter is first the
  cursor's orange and turns ink after ≈2 frames [verified: crops of the opening
  and element measurements].
- **The long message in the input box**: ≈107 characters at f273–f319 (≈1.9 s),
  about 45–55 cps; after a 4-frame pause partway through (a line wrap) it
  **speeds up** (ink growth ≈250 → ≈580 px/frame); "@Cl" automatically becomes
  an "@Claude" tag [verified: frame-by-frame increase of dark pixels in the
  input-box region; the character counts are converted, so approximate].
- **Chapter titles**: "rise + grey → ink" in place, line by line (not word by
  word, not a mask reveal).
- **Claude's reply**: "You got it." appears in orange and turns ink within
  2 frames.
- **The tagline**: grey → ink after the fly-through of the logos (2 frames).
- **Word swaps**: replaced instantly after the selection highlight, with no
  transition of any kind.
- **The wordmark "Claude"**: letter by letter, ≈1 frame per letter.

### 3.6 How numbers and charts grow [verified: read from full-resolution crops]
- The card is first a white capsule and grows into a card in ≈5 frames; the
  number appears in grey and turns ink while it counts.
- Readings (thousands): f805 10.4, f806 11.7, f808 16.7, f810 24.3, f812 33.0,
  f814 41.2, f816 47.9, f818 52.8, f820 55.9, f822 57.7, f824 58.35, f825 58.48,
  f826 58.5 → 0.875 s, speed peaking at 30%, the last 0.25 s climbing only 1%.
- The last 1–2 digits roll vertically "odometer"-style (half a digit visible
  above and below); the other digits jump straight to their values.
- The line draws from left to right (≈0.6 s); bars ≈0.8 s each, ease-out (the
  first bar's width 18→68→128→183→229→266…→436 px, f860–f879), staggered by
  0.125 s; the second card's "6,500" counts the same way.

### 3.7 How UI components are "built"
- No screen appears whole. Whiteboard: the cursor arrives → a sticky note stamps
  → text writes in → illustrations, line art first, then color → the timeline
  path extends → date capsules pop in, one item every ≈0.25–0.4 s.
- Dashboard: capsule → card → number counts → line draws → rows appear in order;
  the next card starts to grow only when the camera gets there.
- The background "material of the world" is drawn too: the whiteboard grid draws
  on line by line at f160–f200, and the spreadsheet chapter's grid fades in once
  the title has settled.

### 3.8 Cursors
- There are two kinds of cursor: Claude (orange, name pill "Claude"; it types,
  is flung in, selects words) and a person (black arrow; clicks Design,
  Scrollyteller, Share), plus named collaborator cursors (blue, green,
  magenta-pink).
- The black arrow is normal size, not enlarged into a "character", but every
  click comes with a camera push-in, so it is large enough on screen [inferred].
- By eye, the black arrow's moves are smooth and short; they were not measured
  frame by frame [uncertain].

### 3.9 Mixed frame rates [verified]
- The opening icon row (f100–f114 changes only on even frames) and the closing
  spark (change sequence at f1331–f1385 `1110101010010100…`) are **on twos
  (12 fps)**; the camera and the other elements are 24 fps. The brand mark has
  the rhythm of hand-drawn animation, everything else smooth motion.

---

## 4. Camera

Verified (per-frame camera tracking):

1. **There is a virtual camera, doing only 2D pan + zoom.** On reliable frames
   (inliers ≥300, 1294 frames in all) the median per-frame rotation is 0.002°,
   p95 0.17°; the frames above 0.3° cluster at f126–f163, where the dragged-in
   text boxes are rotating themselves (they are the only things on screen), not
   the camera; a few more frames at f579–f583 and f1024–f1025 reach 0.3–0.6°,
   coming from local elements — **[uncertain]**, but not a camera roll. No tilt,
   no perspective, no parallax between layers (during push-ins a single
   similarity transform has very high inliers, e.g. T3 1300+). The only 3D is
   T16's fly-through of the logos (near large, far small + depth of field).
2. **Depth of field**: in two places — T7's title defocus (0.21 s, isotropic
   blur, gx≈gy, so defocus, not motion blur) and T16's defocused near logos.
3. **The camera holds completely still**: in 48.5% of frames the camera does not
   move at all (|ln s|<0.0005 and translation <0.3 px). There are 18 holds
   longer than 0.5 s; the longest are 3.33 s (f442–f521), 3.0 s (f259–f330),
   2.71 s (f165–f229). **No handheld drift, no slow push.**
4. **But the picture almost never stops**: measured with two thresholds — (a)
   whole-frame mean change <0.02 grey levels (at 480 px): still 10.2%, longest
   11 frames (0.46 s); (b) mean change of any 18×16 block <1 / 2 / 4 grey
   levels: still 9.0% / 10.3% / 14.2%, longest 10 / 16 / 17 frames
   (0.42–0.71 s). (b) is not affected by encoding noise or frame size, and the
   conclusions agree. Within the 3.33 s camera hold, 0 of 80 frames are still
   (the whiteboard keeps being built).
5. **Whether moves overlap**: the camera's moves mostly come one after another,
   with content actions often filling the gaps; the true overlaps are T13's two
   scrolls (the speed drops to 10 px/frame and picks up again) and the ≈9 frames
   between the end of T4's whip and T5's pull-out. Content actions, on the other
   hand, overlap the camera almost all the time (the cursor arrives as the
   camera decelerates; objects keep stamping in during the pull-out).
6. **Size and duration**:

| Move | Frames | Duration | Size | Peak speed | Curve |
|---|---|---|---|---|---|
| T3 push-in to the input box | f229–f261 | 1.33 s | ×1.44 + 559 px | 64 px/frame | peak 0.30 |
| T4 whip (first half) | f330–f354 | 1.00 s | 1392 px | 165 px/frame (3960 px/s) | ease-in p³ |
| T5 pull-out | f384–f449 | 2.71 s | ×0.566 | 3.2%/frame | easeOutCubic |
| T6 window slide-out | f521–f543 | 0.92 s | 1419 px | 260 px/frame (6250 px/s) | ease-in p³ |
| T8 inside Sheets | f693–f720 | 1.17 s | 832 px + ×0.913 | 125 px/frame | in-out |
| T9 window slide-out | f766–f785 | 0.79 s | 1329 px | 268 px/frame (6420 px/s) | ease-in p³ |
| T10 dashboard pan | f839–f878 | 1.62 s | 1056 px | 137 px/frame | peak 0.22 |
| T11 push-in to the toolbar | f891–f921 | 1.25 s | ×1.817 | 11.7%/frame | peak 0.32 |
| T12 shrink-back in the cross-dissolve | f933–f953 | 0.83 s | ×0.539 | 12%/frame | inOut3, peak 0.62 |
| T13 scroll | f975–f1034 | 2.5 s | ≈1700 px (tracking breaks off in the later part) | 94 px/frame | two overlapping scrolls |
| T14 push-in + jump | f1042–f1075 | 1.38 s | ×1.38 → ×1.43 in one frame → ×1.44 | — | p⁴ → jump → quint out |

7. **No motion blur at all [verified]**: at 92–165 px per frame in T4,
   150–260 px per frame in T6 and 358 px per frame for the cursor, the
   full-resolution horizontal/vertical gradient ratio stays at its still-frame
   level (T4: still 1.23, at its fastest 1.20–1.30; T6: 1.03–1.10), and by eye
   the full-resolution frames are completely sharp; at 358 px/frame the cursor's
   bbox is still 212–213 px wide, not stretched.
