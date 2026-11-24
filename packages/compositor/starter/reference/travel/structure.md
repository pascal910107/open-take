> What this is: frame-by-frame measurements of six launch films by one maker
> of generative-video tools, posted to social video between September and
> November 2026 — their sections to 0.1 s, every shot and how it hands over
> to the next, the story they share, what changes from one to the next, and
> which seconds were generated or rendered offline. It sits beside
> `../structure.md`, which measures one film that holds its camera; these six
> almost never stop. Grammar only: the films are named here by their subject,
> and their brands, colours, wording and characters are not for copying; the
> words on their screens are described, not quoted, except a word or two
> where that is how to find a moment. These are measurements of six films,
> not a rule for a new one.
>
> Marks: [verified] = measured on the file or read in consecutive native
> frames; [inferred] = follows from measurements without direct evidence;
> [uncertain] = not found, or the measurement is not enough to conclude.
> No statement about sound comes from listening: every one is from spectra,
> onsets, band energy and loudness set against picture events. §1 says which
> tool each comparison was measured with and what `open-take film study`
> reads on the same files. `motion.md` beside this
> page has the transitions, camera moves and on-screen words by kind;
> `sound.md` has the sound.

# Six launch films that never stop: structure (story / shots / what varies / what was generated)

## 0. Summary

- **Six films, 41–85 s, each the launch of one tool; in five of them the tool
  works inside a chat assistant.** All six tell the same story: a title card
  → a request typed into a prompt box → sent → a status line naming the step
  being done → the thing built in stages → a result → the result in the real
  world, with a one-line call to action [verified]. In five the title card
  names two parties and the prompt box is a chat; the manga's card names one
  maker and its prompt is typed in that maker's own interface [verified].
  What changes between them is the surface: how bright, how long, how
  fast, what is carried through (§4, §5).
- **They change picture 11–29 times a minute and hard-cut far less.** Counted
  as every frame-checked change of picture (hard cuts, one-frame scale jumps,
  designed transitions): 28, 19, 11, 27, 14 and 29 a minute in the order of
  the table in §1 (the manga 36 if every whip to a new framing counts)
  [verified]. Counted as hard cuts only, the app film has 9
  in 59.6 s while it changes picture 27 times [verified]. Picture changes
  that are not cuts are mostly designed moves of 0.05–0.5 s (`motion.md` §2).
- **The picture almost never stops.** The share of the film an event
  detector calls a hold (almost no change frame to frame) is 11–19% in the
  six; 91 other launch films measured with the same detector have a median of
  40% [verified]. `film study` reads other holds on the same six files
  (4–17%); compare a new film with these numbers only through one tool (§1).
  The camera or the whole picture is travelling 47–82% of the time,
  depending on the film and how travel is counted (`motion.md` §1).
- **One thing is carried through.** In five of the six one object or person
  crosses most boundaries: a wing from sketch to flight, a truck from rust to
  backflip, a fly and its app, a set of mascot characters, a boy and his
  manga [verified]. In the app film something visibly crosses 16 of 27
  picture changes [verified].
- **Words are on screen nearly all the time and pinned to the screen, not to
  the camera:** status chips, typed prompts, captions under the lead,
  labels on worker cursors, counters. 121–280 readable words per film,
  2.9–4.7 a second where counted [verified] (`motion.md` §6).
- **19–46% of each film is generated video, live action or offline
  rendering** that a browser page cannot make without an account; generated
  video and live action alone are 11–35% (§6, the E and D columns). The
  rest — interface, title cards, real-time 3D, transitions — was rebuilt on
  a page and measured back within a few pixels or percent where tried
  [verified].

## 1. The six films

| Film | Length | Frames | Shots / changes of picture | Median shot | Hard cuts | Picture held still (event detector's hold share, below) |
|---|---|---|---|---|---|---|
| The fly (a fly asks a chat assistant to animate its map app) | 59.6 s | 1430 @ 24 fps, 1276×718 | 29 / 28 | 1.92 s | 14 (+1 match, 1 dissolve, 12 same-plane jumps) | 13.3% |
| The game (cloud GPUs and several workers build a game) | 85.0 s | 2039 @ 24 fps, 1276×718 | 28 / 27 | 1.85 s (one shot is 23.8 s) | 11 (+7 scale or jump cuts, 9 others) | 11.7% |
| The flying machine (an old flying-machine design finished, failed, redesigned, flown) | 73.5 s | 2206 @ 30 fps, 1276×718 | 15 / 14 | 2.67 s (one shot is 13.0 s) | 13 (+1 morph) | 16.8% |
| The app (mascot workers research, design, build and publish an app overnight) | 59.6 s | 1787 @ 30 fps, 1920×1080 | 28 / 27 | 1.65 s | 9 | 13.9% |
| The manga (a story idea becomes a manga page) | 62.9 s | 1510 @ 24 fps, 1920×1080 | 39 / 38 boundaries of framing | 1.42 s | 15 changes of picture | 11.4% |
| The truck (a rusty pickup becomes a monster truck) | 41.3 s | 990 @ 24 fps, 1920×1080 | 21 / 20 | 1.62 s | 17 (incl. 3 one-frame scale changes) | 19.3% |

[verified: probe and consecutive native frames.] Shots, medians and hard
cuts were counted by hand in frames; no tool here reproduces them, and
`film study` finds fewer (26, 26, 11, 15, 19 and 16 shots in the order of
the table), so compare shot counts only within one way of counting.

Which tool each comparison comes from [verified]:

- **Hold share**: the sum of every hold an external event detector
  (hyperframes 0.9.7, `measure events --map`) reports, over the film's
  length. That tool is not part of open-take. 91 launch and product films
  measured with it have a median of 40% (p25 22%, p75 57%); launch
  announcements alone 32%.
- **`open-take film study` on the same files** reads a different hold:
  12.7, 5.6, 17.2, 11.1, 4.4 and 13.1% for the six, and a median of 42%
  (p25 28%, p75 62%) for 67 of the 91 catalogue films (where the external
  detector gives 41%, p25 24%, p75 56%). The gap holds with either tool;
  the numbers do not cross between them. To compare a new film, run
  `film study` on it and set it beside the `film study` figures.
- **Travel**: `film study` reads 39.2, 45.7, 37.9, 49.7, 38.8 and 34.9% of
  each film as travel, against a median of 17% (p25 8%, p75 27%) for the 67
  catalogue films. The 47–82% in `motion.md` §1 comes from each film's own
  optical-flow and registration readings and is not on this scale.

`../motion.md`'s film holds its camera still in 48.5% of frames.

How shots were counted: every candidate boundary was checked in consecutive
native frames; automatic cut detectors missed between 3 and 16 real
boundaries per film — cuts hidden in motion blur, white-to-white changes,
one-frame scale jumps, dissolves behind a title [verified]. The manga's
count includes whips of 8 frames or less that land on a different framing;
counted only at changes of scene it has 18 shots, median 1.62 s [verified].

## 2. Film by film

Codes for the kind of picture: **A** interface rebuilt as motion graphics,
**B** screen recording, **C** 3D that renders in real time, **D** offline 3D
render, **E** generated video or live action, **F** title card. "Ends" says
how the shot hands over and what crosses the boundary.

### 2.1 The fly (59.6 s)

| Act | Time (s) | What happens | What is carried |
|---|---|---|---|
| I Title and request | 0.0–10.2 | title → the fly says it has an app → wants a video → hands over a PDF → a plugin command → send | the same sentence; the same PDF |
| II Work starts | 10.2–21.9 | desktop → the compositing app opens → layers grow → the map assembles → a request to animate the pins → pins and cards | layer names match map parts; the captioned word for the map lands on a map |
| III 3D icon | 21.9–36.6 | a request for a 3D fly icon → send → generating → import → a small fly flies the route | the same sentence; the 3D fly becomes the small fly on the map |
| IV Reviews and packshot | 36.6–50.6 | a request for reviews → review cards on a tilted 3D map; a request for a packshot → packshot built layer by layer | the same map, now tilted in 3D |
| V Localise and close | 50.6–59.6 | a request to localise → every word rewritten → batch rename of layers → call to action | the same packshot, rewritten |

| # | Time (s) | Picture | Camera | Ends |
|---|---|---|---|---|
| 1 | 0.000–2.042 | top view of a tiny fly on a trackpad; title built in five moves | slow push 1.037 over 1 s → 12-frame accelerating roll-dive (~35°, ~1.6×) | 6-frame dissolve hidden behind the still title |
| 2 | 2.042–4.958 | fly at desk height; a caption naming its app | crane down 8 frames, then locked; the fly lunges 1.5× at the lens | hard cut; the same sentence continues typing in the chat box |
| 3 | 4.958–6.500 | chat page, an opening question + typing | truck 0.154 W in 0.58 s, ease-in-out; held 0.75 s | hard cut |
| 4 | 6.500–7.583 | macro side view; a PDF pops from the fly's foot in 3 frames | near locked | match cut: the PDF icon at the same screen position becomes the attachment |
| 5 | 7.583–8.125 | prompt box with the PDF; a tool chip inserts and the sentence reflows | slow push to 1.066, accelerating at the end | one-frame scale jump 2.2× |
| 6 | 8.125–9.375 | a slash command | pushed to 1.16–1.19, hovering | one-frame jump sideways to the end of the line |
| 7 | 9.375–10.208 | send button + pixel burst | moves down 34 px, accelerating | one-frame pull-out to the whole desktop |
| 8 | 10.208–11.042 | desktop: chat window fades, the app flies out of the dock | 0.976→1.032 | one-frame scale jump ~3× |
| 9 | 11.042–13.375 | 22 named layers grow, one every 2 frames | push 1.10 + down, then 7 frames tilt + push 1.21 | jump to another panel of the same window |
| 10 | 13.375–14.875 | the map assembles by category | slow push | hard cut 0.12–0.23 s after the low end returns (`sound.md` §1) |
| 11 | 14.875–17.292 | the fly's face; captioned request to animate the pins | locked | hard cut; the last captioned word, map → the map |
| 12 | 17.292–21.875 | map, three stations: pins, card, card | locked → push 1.64× in 8 frames → drift → whip + 20° turn → drift | hard cut |
| 13 | 21.875–24.292 | fly, medium shot; captioned request for a 3D icon | locked | hard cut; the sentence continues in the interface |
| 14 | 24.292–25.708 | small prompt box in a white field, typed one character a frame | slow move 63 px | one-frame scale jump ~4× |
| 15 | 25.708–26.708 | send button black → blue + burst | 8-frame settle, then accelerates | two frames of white |
| 16 | 26.708–30.875 | generating → dark panel rises → 3D fly on a turntable | locked, pan, tilt, locked; accelerates upward at the end | speed ramp + one-frame 1.5× jump |
| 17 | 30.875–32.792 | logo, an import question, YES pressed | slows → sideways whip-out 0.79× → drift → flicks upward | hard cut; the upward motion continues |
| 18 | 32.792–33.458 | project panel; the model file slots in as the first row | still moving up, slowing; then accelerates + push 1.055 | jump to the map composition |
| 19 | 33.458–34.083 | the map inside the app | upward, slowing → push accelerating | speed ramp + one-frame 1.45× jump |
| 20 | 34.083–36.625 | full map; the small fly flies the route past five pins | decelerates to 2.07× → three whips → held 14 frames → 4 frames out of focus | defocus → cut → 9-frame focus in |
| 21 | 36.625–39.250 | fly on the palm rest; captioned request for reviews | focus pull → follow whip → still → whip-out | the fly flies out of frame → cut |
| 22 | 39.250–44.250 | tilted 3D map; five stations of review cards | in → push 1.41× → three asymmetric whips → accelerating push 1.48× | cut at the fastest frame of the push |
| 23 | 44.250–44.500 | the fly far off before a bookcase; keyboard slides out of foreground | rising | jump cut (fly 1.4× bigger) |
| 24 | 44.500–47.625 | captioned request for a packshot | still → pan following → the fly walks into the lens | hard cut |
| 25 | 47.625–50.583 | packshot pops in 13 times; a blink | locked | hard cut |
| 26 | 50.583–52.167 | fly walks into a close-up in 3 frames; captioned request to localise | locked | hard cut |
| 27 | 52.167–54.000 | three lines rewritten | linear drift up 1 px a frame | jump to the layer list |
| 28 | 54.000–57.375 | a wave of renames down the layer list | constant scroll 4.6 px a frame | hard cut |
| 29 | 57.375–59.583 | darkened live shot; one line of call to action; the fly jumps twice | locked | end; sound leaves 0.55 s before the picture |

[verified] 16 boundaries change subject or space (14 hard cuts, 1 match
cut, 1 dissolve); 12 are the same interface plane changing scale or
position within one frame (scale jumps 1.45–4×, panel jumps, a sideways
jump, two white frames, a jump cut). Counting only changes of space: 17
shots, median 2.92 s.

The fly is the lead and has no cursor anywhere: a push-in stands for a
click, and every action has a visible result [verified]. First and last
frames are the same fly on the same laptop with one line of type: at the
start a high angle, the fly small and the tools named large; at the end at
the fly's height, darkened, the line a command for the viewer to type
[verified].

### 2.2 The game (85.0 s)

| Act | Time (s) | Shots | Inside cuts | Median shot | What it says |
|---|---|---|---|---|---|
| 1 Hook / name | 0.0–7.0 | 1 | 0 | 7.04 | a city being built in flight; title |
| 2 Ask / provision | 7.0–17.8 | 4 | 3 | 2.02 | prompt, connect, choose model, count, rent |
| 3 Proof in a 3D app | 17.8–33.8 | 9 | 8 | 1.38 | the app running in the cloud, step by step |
| 4 Game + claim | 33.8–41.1 | 2 | 1 | 3.67 | the character in the game; claim card |
| 5 Fix and learn | 41.1–64.9 | 1 | 0 | 23.83 | one take: an error → fixed → the model learns |
| 6 Speed | 64.9–76.9 | 7 | 6 | 1.67 | an estimate of days becomes minutes; the build |
| 7 Payoff + CTA | 76.9–85.0 | 4 | 3 | 1.67 | drop, the animated result, one line of CTA |

| # | Start (s) | Length | Picture | Camera | Ends | Kind |
|---|---|---|---|---|---|---|
| 1 | 0.000 | 7.04 | grey city with worker labels → textured → wheel → defocus + title | FPV forward, yaw, roll, never stops | RGB split 5 frames, cut to white light (bright to bright) | C→D, F |
| 2 | 7.042 | 2.50 | a prompt box grows out of white light; prompt typed | still, last push 4% + blur | push blur 3 frames, cut to black (forward) | A |
| 3 | 9.542 | 1.33 | a connecting line | slow push and drift; whip left 4 frames | whip cut (blur both sides) | F |
| 4 | 10.875 | 5.33 | 3D carousel picks a model; the card becomes a slot; count 1→6 | stepping across; still 1.62 s while counting; push +13% | push blur 4 frames (accent colour + light) | C+A |
| 5 | 16.208 | 1.54 | a discount pill; rays | still; the pill rushes the lens | through-the-lens cut (bright to bright) | A |
| 6 | 17.750 | 2.00 | a tilted glowing screen, a line saying where it runs | low angle along the screen | jump closer to the same screen | B+A |
| 7 | 19.750 | 3.33 | 3D app window straightens; scene built; status chips | window straightens and pushes + a camera inside the scene | match cut (composition + chip) | B+A |
| 8 | 23.083 | 1.38 | the lit render | held 0.96 s, ease-in pull-out | blur cut | D→B |
| 9 | 24.458 | 5.42 | bokeh → 2×5 grid of characters → scatter → the hero's window | fly in, still, ease-out push | one-frame jump (same character) | B (D) |
| 10–13 | 29.875 | 0.04, 0.04, 0.25, 0.08 | add menu, rig, seamless backdrop, camera view | — | a one-frame jump (29.917), two scale cuts (29.958, 30.208), a match cut into the render (30.292) | B |
| 14 | 30.292 | 3.46 | render; a rigging chip; posed; push to the face 5.6× | out 1.27×, hold, 10-frame push to face, slow push | accent flash cut (character + chip cross) | D |
| 15 | 33.750 | 3.67 | the same character in the game, HUD | follows; stops ~0.9 s | hard cut bright → dark, nothing carried | E |
| 16 | 37.417 | 3.67 | claim cards | type scales in, linear drift, flip | blur to blur | F |
| 17 | 41.083 | 23.83 | one take: ball → error → freeze → prompt → pulled back to a plane → grid → globe → three data panels → push until a panel is the frame | never stops except the freeze | 4 frames out of focus, cut (blur to blur) | E→C→E, A over |
| 18 | 64.917 | 2.00 | a card about speed | type scales in | carried by upward motion | F |
| 19 | 66.917 | 2.33 | third prompt | still 1.29 s | hard cut; orange carries | A |
| 20 | 69.250 | 0.50 | star + a large estimate line | recentres | jump to 0.35× (same line) | F |
| 21 | 69.750 | 1.67 | the estimate, in hours | recentres; exits rising, accelerating | carried by upward motion | F |
| 22 | 71.417 | 1.00 | frame corner rises; a slash command typed slowly | rises 5 frames, stops | jump to the send button of the same box | A |
| 23 | 72.417 | 1.00 | send pressed; dot-matrix light wave | in drifting left and slowing; out sinking and accelerating | carried by downward motion | A |
| 24 | 73.417 | 3.50 | status list, the estimate now in minutes, a generating chip | moves on the plane, two whips, push through the words | glow, cut at the brightest frame (the drop) | A/F |
| 25 | 76.917 | 1.71 | warp tunnel → pixel reveal → animated wide shot (held 1 s) | forward, slowing as it forms | hard cut (same girl, wide → medium) | E+C |
| 26 | 78.625 | 1.25 | the girl lowers her sword | still | hard cut, reverse shot | E |
| 27 | 79.875 | 1.63 | the monster grins | slow push 1.00→1.10 | hard cut, cause and effect | E |
| 28 | 81.500 | 3.46 | charge, leap; one line of CTA | follows, tilts up, slows to a freeze | end | E+F |

[verified] 26 of 27 cuts have something caught on both sides: light
(bright to bright), blur (blur to blur), the same object, motion in the
same direction at a similar speed, or the same colour. The one that does
not is 37.417 (game → claim card, bright to dark). No fades, no dissolves.
The first frame is the city half built; the last is the finished animated
city: the first result comes before its prompt (a hook), the last after its
prompt (the payoff) [verified].

### 2.3 The flying machine (73.5 s)

| Act | Time (s) | Shots | Share | What it does |
|---|---|---|---|---|
| I Promise | 0.0–5.5 | 1–3 | 7.5% | the brand drawn on parchment; the model list; free to try |
| II Attempt | 5.5–40.3 | 4–9 | 47.2% | request → research → blueprint → 3D → finished machine in flight → it was a window → simulation → failure |
| III Redesign | 40.3–58.6 | 10–13 | 24.9% | the turn → the integration switched on → generate → choose → rig and test flight → files → Download |
| IV Made real, terms | 58.6–73.5 | 14–15 | 20.4% | live flight + launch line → trial terms → blank paper |

| # | Time (s) | Picture | Camera | Ends | Kind |
|---|---|---|---|---|---|
| 1 | 0.000–0.967 | guide lines grow on parchment, then an outline is traced | near still | one-frame scale cut: the same outline 1.9× smaller, still tracing | F |
| 2 | 0.967–3.300 | lockup + promise; outline → staggered fill; wing sketch | pull-out 1→0.726, strong ease-out; held 1.13 s; card rises 85 px, 8 frames accelerating | momentum cut upward on the fastest frame | F |
| 3 | 3.300–5.533 | wheel list of models + the promise in one accent | continues up, stops within 8 frames; wheel steps 3 times; card falls 69 px | momentum cut downward; paper becomes a white interface | F |
| 4 | 5.533–13.900 | chat: greeting → typing → send → bubble → a starting chip → pulled back to a desktop → sketch wall, research cursors, status chip | one continuous flight: drop 195 px, push 1.37×, right 350 px, background 1.51→0.90, push (window 2.4× / background 1.5×), push peaks 12.10 / 12.78 / 13.37 | scale cut ~3× (grid close-up → window wide) | A |
| 5 | 13.900–20.733 | editor: scanned wing dissolves into vector (16.0), filled blue, dimensioned; a status chip for the drafting step | push, one-frame punch-in ×1.28, 3-frame fast push, pull-out, whip 1→0.624 in 6 frames, 3D window rises, background slow push 1.00→1.33 | scale cut ×1.43 into the 3D window | A |
| 6 | 20.733–23.267 | grey parts fly in and assemble; 16 named worker cursors; a status chip for the 3D step | pushed to full, near still; pushes through the interface frame at 22.6–22.8 | match cut: same pose, grey becomes wood | C in A |
| 7 | 23.267–25.633 | on black, wooden parts reassemble | dolly + yaw accelerating 1→33 px a frame from 24.47, never stops | hard cut hidden in motion blur | D/E |
| 8 | 25.667–27.233 | low angle: gilded strut, a spar sweeps past the lens, canvas over ribs | arc + truck + roll, peak 68 px a frame | hard cut hidden in blur; ribs on both sides | D/E |
| 9 | 27.267–40.233 | nine stations: under the wing → slows to real time on the finished machine → pulled back: a window on a desktop → 0.3 s → the simulation window lifts → a simulation chip → wing breaks → stillness → a failure card with three running numbers | see `motion.md` §3 | hard cut, dark to bright (grey difference 0.768) | D/E → A → B/C |
| 10 | 40.267–47.900 | one light board, six contents: the verdict → a line about a new version → the integration switch → prompt → 2×2 generated images → choice → push in | follows the text sideways; 2-frame whip pull-out at 41.233; push ×1.15; tile 0.47→0.72 W; push to full at 47.73 | pose-matched morph, 10 frames | F → A |
| 11 | 47.933–54.733 | white wireframe on black over a teal light pool; side panels slide in; rig controls; skin; a flight-test chip; flaps and rises | always moving: descend, push + tilt 155 px / 0.6 s, orbit 45–60°, rise 179 px | hard cut, black to white | C |
| 12 | 54.767–57.400 | a reply that it works, with three file rows | text layer 0.5→1.0 in 17 frames, background still; last 0.4 s accelerates upward | hard cut; the upward motion carries into the button | A |
| 13 | 57.433–58.533 | the Download button | rises, pressed, released, held 2 frames, 8-frame accelerating push 1.55× | hard cut on the fastest frame of the push, into live action | A |
| 14 | 58.567–66.567 | golden hour on a ridge: the machine glides, takes off, leaves, reappears; two launch lines | still 6 frames → orbits ~90° → locked from 60.3 | hard cut, dark to bright paper | E+F |
| 15 | 66.600–73.533 | trial terms on parchment; a four-point star wipes, swaps, clears; blank paper 0.77 s | still | end | F |

[verified] All handovers but the morph are 0 frames; no dissolves between
shots, no white flashes. The failure sits at 50–55% of the film; the product
being launched first appears at 42.5 s, 58% in — the failure sets it up
[verified]. First and last frames are the same parchment: blank at the
start, blank again at the end after the promise has come back as the terms
[verified, frames 2183–2205 are blank paper].

### 2.4 The app (59.6 s)

| Section | Time (s) | Length | What happens |
|---|---|---|---|
| Joint card + fly-through | 0–3.2 | 3.2 | card assembles → through the × between the names → white corridor |
| Request (live action) | 3.2–8.8 | 5.6 | a man types two lines at night, sends, shuts the laptop, lies down |
| Research | 8.8–24.8 | 16.0 | chat → worker list → posts → card stack → close-up → a searching line → a found line |
| Evidence | 24.8–33.4 | 8.6 | reply thread → wall of posts → one post → a line naming the demand |
| Analysis + blueprint | 33.4–40.3 | 6.9 | app screen → 3D stack + 7 chips → push → a ready line with the plan |
| Build | 40.3–51.0 | 10.7 | build → characters gather and collapse → generate media → phone app → publish |
| Payoff (live action) | 51.0–56.6 | 5.6 | the same man, recommended; a row of users filming themselves |
| Brand close | 56.6–59.6 | 3.0 | the opening card again, held |

| # | Time (s) | Picture | Camera | Ends (length; what crosses) | Kind |
|---|---|---|---|---|---|
| 1 | 0.000–2.500 | joint card + six characters | still to 2.20; push ×1→×3.05 in 0.30 s, accelerating (per frame 1.02→1.39) | fly-through 0.33 s; the camera axis passes through the × | F |
| 2 | 2.500–3.200 | white 3D corridor, characters flying past | dolly forward, true perspective | ~4 frames; a live-action card at the vanishing point | C |
| 3 | 3.200–8.800 | night room: typing, lying down | card 976→1888 px wide in 0.433 s, power1.out; then the footage's own push and tilt | hard cut | E (A over) |
| 4 | 8.800–10.400 | white chat, close | slow drift ~5.5 px a frame | one-frame pull-out to ~0.7 + 6-frame settle | A |
| 5 | 10.400–11.933 | whole chat window | settled | flicks up 4 frames (7, 17, 31, 43 px) into blur; same interface | A |
| 6 | 11.933–15.500 | the worker list | follows the list down ~11.8 px a frame | blur dissolve 2–3 frames | A |
| 7 | 15.500–17.000 | chat: research + comments | scrolls up | defocus out / in ~5 frames | A |
| 8 | 17.000–21.367 | a post card → 3D card stack → collapsed | cards tilted on Y; stack backs off and returns ~18 px a frame | one-frame push ~2.5×; the same post | A in 3D |
| 9 | 21.367–22.367 | close-up of the post's image + chip | drifts up | hard cut; next content fades in over 3 frames | A |
| 10 | 22.367–23.967 | a searching line | still | one-frame push ~2.4× | A |
| 11 | 23.967–24.767 | a found line | still | hard cut with vertical blur on the first new frame; the same post heads the thread | A |
| 12 | 24.767–28.200 | dark reply thread | scrolls one reply at a time, 7–71 px a frame | 0.23 s slide: thread drops, wall rises | A |
| 13 | 28.200–30.733 | wall of post thumbnails | two pull-outs 1→0.70, hold, →0.53; ±1.6° rotation | vertical whip 4–5 frames; one post from the wall | A |
| 14 | 30.733–32.367 | one post | drops in, slowing, ~11 px a frame | hard cut | A |
| 15 | 32.367–33.400 | a line naming the demand | slow drift | whip 0.27 s: chat blurs up, app screen rises | A |
| 16 | 33.400–34.100 | full-frame app screen | settles; pull-out 0.833→0.387, slowing, starting to tilt | 0.3 s; the board becomes the stack's front card | A |
| 17 | 34.100–37.267 | 3D stack + 7 status chips | stack turns ~2.4 px a frame | push 0.53 s; the front card | C |
| 18 | 37.267–38.100 | push into the front card | front card 60% → 75% → 100% of frame at 37.6 / 37.7 / 37.8; straightens only in the last frames | slides up 0.4 s; the screen becomes a banner | C |
| 19 | 38.100–40.333 | a ready line + document | slow drift ~4 px a frame | blur dissolve through white ~3 frames | A |
| 20 | 40.333–42.000 | a building line | slow drift | 0.27 s; a grey character moves to centre, grows | A |
| 21 | 42.000–42.700 | two large characters | still (objects move) | burst 2 frames; the two characters | F |
| 22 | 42.700–44.133 | 16 → ~30 characters | still | collapse 0.3 s: radial blur → ball → dot; the dot becomes an avatar | F |
| 23 | 44.133–47.300 | a generating line + a phone appears | still | 0.6 s; the phone | A |
| 24 | 47.300–49.500 | phone app | phone x 560→928 in 0.533 s, power2.inOut | 0.33 s; the phone | A |
| 25 | 49.500–51.033 | play card + a publishing chip | push and scroll up | whip 3 frames | A |
| 26 | 51.033–54.300 | live action: the same man | card y 704→576 in 0.167 s, sine.out; width 1352→1888 in 0.4 s | hard cut | E |
| 27 | 54.300–56.600 | a row of vertical self-filmed videos | left, 78 → ~17 px a frame; falls from 56.0 | falls 2 frames | E |
| 28 | 56.600–59.567 | the opening card again | still | end | F |

[verified] 9 hard cuts in 59.6 s (1.5 per 10 s, median 4.82 s between them)
against 27 changes of picture (4.5 per 10 s). The same live-action man opens
the middle and closes it; the same card opens and closes the film (their
held frames differ by 12 grey levels of background light) [verified].

### 2.5 The manga (62.9 s)

| Section | Time (s) | What happens | Kind |
|---|---|---|---|
| Hook | 0.000–4.042 | cafeteria live action with comic symbols drawn over; a glitch; a ball hits his face — match cut into the drawn version | E |
| Title | 4.042–5.583 | drawn title card; the name written by a streak of light | F |
| Request | 5.583–9.958 | interface typing → live action head in hands → one word retyped → style chosen | A+E |
| Process | 9.958–23.583 | a 3D sphere of cubes + four step banners; script; cast (a photo swept into a character card); generate | D+A |
| Result | 23.583–44.583 | one manga page develops panel by panel in 14 framings; a chip names features bottom left; publish | C |
| Spread | 44.583–54.250 | corridor live action, holographic pages in the air; publish page with a view count | E+A |
| Close | 54.250–62.917 | one long take: he leans in, a volleyball knocks him out of frame; the frame darkens; end line | E + type |

| # | Time (s) | Picture | Camera | Ends |
|---|---|---|---|---|
| 1–3 | 0.000–4.042 | cafeteria; the girl; his frown | tilt/pull 0.42 s, then near still; slow push; locked | hard cuts; 3.875–4.0 glitch (inverted blocks, a negative frame); match cut: the live ball-in-the-face becomes the drawn one |
| 4 | 4.042–5.583 | drawn title card | slight push | one-frame dissolve |
| 5 | 5.583–7.000 | dark interface: prompt typed at ~43 characters a second | slow drift −27 px / 1.3 s | hard cut |
| 6 | 7.000–7.750 | head in hands | locked | hard cut |
| 7 | 7.750–8.583 | the word selected, deleted, retyped | push 1.000→1.0115 in 0.625 s | downward whip 4 frames |
| 8 | 8.583–9.958 | style menu; one chosen | drifts after the whip | 2-frame fade through black |
| 9–12 | 9.958–15.917 | ~90 cubes fly in (0.38 s) and form a sphere; a banner line types in 0.29 s; the sphere turns and pushes ~1.6×; a scale jump inside the spin blur while **the banner stays put**; four step lines | locked, then spin + push 0.29–0.33 s each | hard cut to black |
| 13 | 15.917–17.333 | script chapters | slow scroll up | scroll-whip 4 frames |
| 14 | 17.333–18.167 | cast and world | drifts after the whip | fast push 3 frames |
| 15 | 18.167–20.625 | one cast card; a sweep of light turns the photo into a drawn card (19.67–20.10) | pushed, then drifts | fast pull 5 frames |
| 16 | 20.625–22.625 | 3×3 cards swept one after another (21.2–22.0) | settles at 20.79 | hard cut |
| 17 | 22.625–23.583 | the generate button pressed; a ring bursts out (22.96–23.25) | drifts up | hard cut into an almost all-accent frame (brightness 0.17 → 0.90) |
| 18–31 | 23.583–44.583 | the page, 14 framings of 0.7–2.7 s: each new panel enters with a 3–4-frame sideways blur of the whole page and develops two-tone → second tone → black and white in ~10 frames (26.33 → 26.75); speech bubbles word by word, newest word in the accent; the chip swaps text every 0.9–1.2 s | whip to each panel (3–6 frames), settle, slow drift | whips; one panel pushes up to the lens; a flash sweep over the last panel, hard cut |
| 32–35 | 44.583–50.208 | corridor; holographic pages rise with scan lines (47.79–48.0) | hand-held follow; still; locked; slight push | hard cuts |
| 36–38 | 50.208–54.250 | publish page; view count 4.4K → 26.2K | slow push; whip-push 4 frames; downward whip; accelerating push (type 119 → 182 px over 1.5 s) | hard cut as the count tops out |
| 39 | 54.250–62.917 | the long take; ball at 59.46; darkens 60.0; end line 60.04, appears without animation | slow push ~1.3× over 5 s [inferred] | end |

[verified] Shot medians by section: 1.40, 1.48, 1.42, 1.46, 1.42 s, then
the 8.67 s long take. The page section changes most: 32.4 mean grey-level
change per 0.1 s against 10.0–18.8 in the other sections. The basketball
at 4.0 s comes back as the volleyball at 59.46 s.

### 2.6 The truck (41.3 s)

| Section | Time (s) | Length | Shots | Job |
|---|---|---|---|---|
| Brand | 0–3.71 | 3.71 | 1 | joint card |
| Problem | 3.71–5.33 | 1.63 | 2 | the rusty truck (its bumper falls off) |
| Request | 5.33–9.08 | 3.75 | 3–4 | typing, sending |
| Understanding | 9.08–20.08 | 11.00 | 5–13 | status lines, exploded 3D, parts board, three measurements |
| Build | 20.08–27.04 | 6.96 | 14–16 | verdict, 3D build |
| Choose | 27.04–34.46 | 7.42 | 17–18 | four variants, final model |
| Deliver | 34.46–37.42 | 2.96 | 19–20 | yes/no, download |
| Payoff | 37.42–41.25 | 3.83 | 21 | the real backflip + CTA |

| # | Time (s) | Picture | Camera | Ends (what crosses) | Kind |
|---|---|---|---|---|---|
| 1 | 0.000–3.708 | joint card | still (1.006→1.0096 over 1.5 s) | 0.625 s dissolve through a heat-map version of the truck | F |
| 2 | 3.708–5.333 | rusty pickup; bumper falls | slow drift | 3-frame overexposed flash + the photo shrinks to a thumbnail in 0.25 s (the photo) | E |
| 3 | 5.333–7.625 | white chat box: thumbnail, PDF, prompt typed ~53 characters a second | near still, then accelerates left −2 → −167 px per 0.25 s | one-frame scale change, first frame blurred (the card and its leftward speed) | A |
| 4 | 7.625–9.083 | model menu + send button | keeps moving left ~313 px, slowing to a stop | hard cut to white; a grey card corner lingers at the right edge | A |
| 5 | 9.083–10.667 | star + two status lines | rises 175 px (ease-out), then drifts up accelerating | one-frame swap to another pair of lines | F |
| 6 | 10.667–12.417 | a checking line | drifts up accelerating; last 0.2 s ~455 px/s, vertical blur | hard cut to 3D on a full-band hit | F |
| 7 | 12.417–14.250 | grey 3D truck → exploded → an analysis tag | slow orbit | one-frame scale change into the tag (the tag) | C |
| 8 | 14.250–15.042 | the tag close | slow drift | one white frame, cut | C |
| 9–12 | 15.042–18.458 | board of ~100 parts; then three areas, each with a box, a condition label, 67% / 16% | locked; drift ±40–50 px/s | one-frame scale change; two hard cuts to other areas of the same board, ~0.84 s apart | D + overlay |
| 13 | 18.458–20.083 | the frame, Condition 96% | push accelerating 1.006 → 1.075, last 0.24 s up 72 px | hard cut (the frame → the verdict) | D + overlay |
| 14 | 20.083–21.500 | a verdict on the frame | decelerates in, near still, accelerates out (~560 px/s at the end) | drifts up and fades; 2 white frames | F |
| 15 | 21.500–23.042 | tool chip + a line about calculating the geometry | drifts up accelerating | hard cut on a full-band hit (the word geometry → the 3D chassis) | F |
| 16 | 23.042–27.042 | seamless white: chassis → roll cage grows → monster truck | slow orbit; fast ~45° at 24.4–24.6 | hard cut to white | D |
| 17 | 27.042–30.708 | a ready line → 2×2 variants; green chosen | drifts up; text shrinks to a header in 2 frames; push 1.10 in 0.25 s | hard cut to white (the chosen green) | F→D |
| 18 | 30.708–34.458 | a building line → dark window, truck red → green, turntable | text shrinks to the corner in 2 frames; window opens from the left in 0.54 s | hard cut to white | F→D |
| 19 | 34.458–36.417 | a yes/no question offering a guide; Yes pressed (no cursor) | shrinks to 0.96–0.98, drifts up | hard cut; the download card enters blurred (the result of Yes) | A |
| 20 | 36.417–37.417 | download card | push 1.057 → 1.073; zoom blur out | hard cut to live action (the green truck becomes real) | A |
| 21 | 37.417–41.250 | arena: the green truck takes the ramp, leaves the ground at 38.0, flips; CTA throughout | follows (generated footage) | no end card; stops mid-air, sound out 40.9–41.3 | E |

[verified] Understanding is the longest section (27%) and the most cut.
One object is changed in every section: wreck → thumbnail → 3D truck →
parts → the frame at 96% → 3D chassis → monster truck → four variants →
green final → the real backflip.

## 3. The story they share

[verified, all six except where a step names the exception; positions from
71 prompt-then-result films in a catalogue of 286 launch films]

1. **A title card** in the first 0–5 s. In five it is a joint card naming
   both parties; the manga's, at 4.04 s, is its title and one maker's name.
   In the catalogue only 26 of 286 films open on a brand.
2. **A request typed into a prompt box**, one short sentence or a slash
   command and a goal: turn this object into that one, make me a thing. In
   five the box is a chat with an assistant; in the manga it is the maker's
   own interface. In the fly film the sentence is first captioned under the
   fly (whether a voice speaks it is uncertain, §7) and finishes typing in
   the box after a hard cut.
3. **Send**, shown on the button, never as a pointer travelling to it: a
   push-in to the button, a press of 2–6 frames, a burst of light or pixels.
4. **A status line in the present tense** for each step, three or four
   words led by a gerund and often a count, with an icon, in a fixed corner
   or under the work.
5. **The thing built in stages**, one stage per shot or station, more and
   more laborious: the fly's last two functions are rewriting every word and
   renaming dozens of layers.
6. **A check or a choice**: a yes/no question, a 2×2 of variants with one
   outlined, a failure card with three numbers, an error alert.
7. **The result in the real world** (a flight on a ridge, a backflip in an
   arena, users filming themselves, the fly on the laptop) with **one line
   of call to action**, white capitals, small (0.028–0.049 H), appearing
   without animation. Three of six end on that live shot with no logo card;
   two end on a card that repeats the opening; the manga ends on its long
   take with an end line.

Position in the film (catalogue, 71 prompt-then-result films, median length
40.8 s): first prompt at 13% of the length, first result at 46%, a wall of
results at 72%; 59 of 71 end on a brand section, median 3.4 s [verified].
The six put the first prompt at 7–13% (app 4.13 s of 59.6; flying machine
6.2 s of 73.5; fly 4.96 s of 59.6; game 7.5 s of 85.0; manga 5.96 s of
62.9; truck 5.33 s of 41.3) [verified].

**One thing carried through media changes** [verified]:

| Film | What is carried | Media it passes through |
|---|---|---|
| Flying machine | one wing / the machine | scan → parchment → vector (16.0 dissolve) → blueprint → grey model → wood (23.267 same-pose match cut) → simulation → generated photo → wireframe (47.933 pose-matched morph) → files → live flight |
| Truck | the truck | photo → thumbnail → 3D → parts → the frame → chassis → monster truck → variants → final → real |
| Game | one character; one clip | grid → 3D app → render → face → game; clip ↔ plane in space ↔ clip (46.167 / 61.667) |
| App | a post; an app screen; the characters | card → stack → close-up → head of the thread; board → front card → banner; centre → crowd → dot → avatar |
| Fly | a sentence; a PDF; the map | captioned → typed (4.958, 24.292); foot → attachment (7.583); layer names → map parts |
| Manga | the boy, the girl, her photo | live → drawn (match cut on the ball); photo → character card → heroine → the page she reads |

**What drives each film forward** [inferred]: asked, and the next shot is
done (fly: seven rounds, no explanation between); a result first, then how
it was made (game: the hook at 0 s is explained from 7 s); it fails in the
middle (flying machine at 50–55%); he sleeps while the work happens (app);
material turns into the product in the frame (manga: develop, sweep, flash
cut); one object changed in every section (truck).

## 4. What varies between the six

[verified unless marked]

| | Fly | Game | Flying machine | App | Manga | Truck |
|---|---|---|---|---|---|---|
| Length | 59.6 s | 85.0 s | 73.5 s | 59.6 s | 62.9 s | 41.3 s |
| Picture changes / 10 s | 4.7 | 3.2 | 1.9 | 4.5 | 6.0 framings, 2.4 changes of picture | 4.85 |
| Longest unbroken take | 5.0 s | 23.8 s | 13.0 s | 5.6 s | 8.7 s | 4.0 s |
| Frames with mean grey ≥ 180 / ≤ 70 | 39.5% / 14.6% | 0% / 59.9% | 48.5% / 27.2% | 60.3% / 5.8% | lum 109, sd 67.7 (black and white alternating) | 80.2% / 9.8% |
| Main picture kinds | A 53.6%, E 34.7%, C 11.7% | C 26.9%, E 22.8%, F 14.2%, A 14.0%, B 13.9%, D 8.3% | A 35.6%, F 20.0%, C 12.3%, D/E 11.2%, E 10.9%, B/C 9.6% | A 60.6%, E 18.7%, F 12.8%, C 7.9% | C 33.4%, E 30.3%, A 24.4%, D 9.5%, F 2.4% | D 32.4%, F 31.7%, A 16.3%, E 13.2%, C 6.4% |
| Lead | a fly (live action) | a city, a character | an object | mascots + a man | a boy | a truck |
| Cursor | none | worker labels only | one user pointer once (7.467–8.0); named worker cursors | worker characters | a pointer in the menus | none |
| Ending | CTA over darkened live shot | CTA over a near-freeze, no logo | blank parchment 0.77 s | opening card again, held | long take, darken, end line | stopped mid-flip, no card |
| Integrated loudness | −14.1 LUFS | −5.4 | −6.9 | −7.5 | −8.5 | −7.5 |
| Cuts on the beat | not significantly more than chance | not significantly more than chance | not significantly more than chance | not significantly more than chance | not significantly more than chance | 8 of 20 on a 68 BPM grid (chance 1.9) [uncertain tempo] |

What stays: the template in §3; a status line naming each step; a new
picture every 1.4–2.7 s (median shot, §1); the picture held still only
11–19% of the time by the event detector of §1; 6–9 worlds of colour per film (manga 8, flying machine 9)
[verified]; one saturated accent marking the thing acted on while the
rest stays neutral [inferred]. What varies is brightness, length, the
camera's vocabulary (whole-frame drift and one-frame scale changes in the
truck; window pushes in the flying machine; 3D flight in the game; hard cuts
between live action and interface in the fly), and how much is generated.

Rhythm across a film [verified]: the flying machine is dense first and
sparse after its failure (camera moving 58% of the first half, 38% of the
second; 8% in its last act). The manga is fullest in the middle (the page
section at 32.4 against 10–19 elsewhere; its loudest music section 29.95–42.93
s falls inside the page section 23.58–44.58 s). The game alternates dense
cutting (its 3D-app act 9 cuts in 16 s; speed act 7 in 12 s) with a 23.8 s take.

## 5. How long, and how much is shown

- Each film shows its product's steps one per shot or station: the game
  about 15 feature points in 85 s, one per station or shot; the flying
  machine 16 steps from model list (3.3 s) to trial terms (66.6 s); the fly
  about 15 from chat (4.96 s) to call to action (57.4 s) [verified].
- The longest section is where the product works, not where it is
  introduced: the truck's understanding section 27%; the flying machine's attempt
  47.2%; the app's research 16.0 s [verified].
- Readable words: fly ~195, game ~126 (89 a minute), flying machine 232 (3.2
  a second; its closing terms 53 words in 6.93 s), app ~280 (4.7 a second),
  manga ~193 (about 76 read), truck ~121 (2.9 a second). Words used as
  texture (layer names, interface lists) are counted apart: fly ~160 more
  [verified, counted by eye ±10%].

## 6. What was generated or rendered offline, and what a page can do instead

[inferred: each shot classed by where its pixels come from; seconds from the
shot tables]

| Film | Generated video or live action (E) | Offline 3D (D) | Made in a browser page |
|---|---|---|---|
| Fly | 34.7% — the fly's performance | — | ~65% (interface 53.6%, real-time 3D 11.7%) |
| Game | 22.8% — game footage, the ball, the anime | 8.3% — the textured city, rendered characters | 55% (interface 14.0%, real-time 3D 26.9%, cards 14.2%); 13.9% screen recording |
| Flying machine | 10.9% — the ridge flight | 11.2% wooden machine, D or E undecided | ~78% |
| App | 18.7% — the man, the self-filmed users | — | ~81% |
| Manga | 30.3% — cafeteria, corridor, phone close-ups; the drawn panels themselves are generated | 9.5% the cube sphere's look | ~70% motion design |
| Truck | 13.2% — the wreck, the backflip | 32.4% — parts board, white-sweep build, final model | 48% directly (cards + interface); 38.8% more with three.js and 3D assets |

Pieces of each, rebuilt on a page and measured back with the same tools: the fly's ramp-and-jump within 2.0% per frame of scale and 2.9 px of
centre; the flying machine's window lift within 0.6% of scale on its
pull-out; the game's pull-back reveal within 0.03 W over its first 10
frames; the truck's push on its 96% box within 0.2% of scale; the app's 3D
stack push matching 60 / 75 / 100% of frame on the same three frames
[verified]. What did not come close was material: generated footage,
photographic parts, a textured city. Where a film's look rested on those,
the rebuilt grammar read as a diagram [inferred, from the truck's test].
Substitutes: the product's own output or recordings,
three.js with physical materials and an environment map, a stylised
character in place of a live one, a photo with 2.5D parallax for 1–2 s.

## 7. Uncertain

- Whether any of the interface was a scripted recording rather than motion
  graphics: the fly's compositing-app shots (13.5 s) and the flying
  machine's simulation could be either.
- The flying machine's wooden machine: offline render or generated video
  (judged 0.55/0.35 one way and 0.6/0.4 the other).
- Narration: the fly shows captions as if spoken; a pitch tracker found
  no speech-like voiced stretches under them, which does not rule a voice
  out.
- The six are one maker's films. Their shared template may be that maker's
  house style rather than something launch films need.
