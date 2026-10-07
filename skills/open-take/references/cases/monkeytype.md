# Monkeytype — one continuous run, then a burst

A 36 s, 1920×1080 film of monkeytype.com (a typing test), made in October
2026 by Opus 5.5 writing its own film page. For its first 20 seconds it is one
unbroken move — a question typed in the product's own manner, the real site,
a real 15-second test followed by the camera and sped up, the result. Then it
cuts on the beat — four modes, then faster and faster through themes — and
the last cut melts into the end card.

**Brief it was given:** only "a launch film for people who have never heard
of it"; length, style and music were the model's choice (the plain arm of an
experiment whose other arm got the Carbon brief's direction).

**The comment this film got** (blind, one viewer — the project's owner —
four films of the same product; this one ranked first of four, verdict "會"):

> 片 40：會，第 1 名

(Translation: "Film 40: yes, rank 1.") No further words about this film.

## Structure: long continuous opening, accelerating burst, colour-matched end

Measured (scene > 0.30): no hard cut before 25.5 s; then 25.5, 26.0, 26.5,
26.75, 27.5, 27.75 (the mode switches at 20–23 s and the darker themes cut
below the threshold). Five-second counts `0 0 0 0 0 6 0 0`.

| Time | Wants to express | Moves | Holds | Handoff into next | Sound |
|---|---|---|---|---|---|
| 0–3.2 | how fast do you type? | grey text lit up letter by letter by a yellow caret — the product's own typing look | the product's dark background | carry | a key sound per letter |
| 3.2–5.8 | find out in 15 seconds | first line rises and dims; second types, "15" in yellow | — | carry: same background colour | hi-hats thicken |
| 5.8–7.5 | this is the site, and it is simple | title fades, the real homepage appears on the same colour | the colour | carry | **drums enter at 6.0** |
| 7.5–13 | just start typing, no account | camera at 1.75× follows the caret through a real test; a typo turns red and is fixed; the timer counts 15 → 9 | caption | carry | a key sound on every real keystroke |
| 13–16 | every keystroke timed | camera pulls back; the recording ramps smoothly to ~4× ("▶▶ 4×" badge); the timer races to 0 | — | carry | riser |
| 16–20 | instant result: 113 wpm, 99 % | the real result page lands; camera pushes to wpm/acc; swaps to a sharp 2× still | — | cut on the beat | an impact as the result lands |
| 20–24 | different modes | one real mode a second (every two beats): time, words, quote, zen; caption word lights in step | caption | cut | — |
| 24–29.5 | make it yours: 180+ themes | 15 real themes, cuts accelerating from 0.5 s to 0.25 s, slow push, theme name in the corner | framing | the last theme's colour = the end card's | a rising note per cut |
| 29.5–36 | name, URL, free | logo pops; URL types in the same manner; tag line; fade | — | fade | a held chord |

## Material

- **Recording** of one real 15-second test, typed by a script at a human
  pace (~115 wpm, with a deliberate typo), screencast and re-timed to 60 fps;
  every keystroke's time logged.
- **Stills of the real site** at 2×: result page, four modes, 15 themes
  (applied through the site's own theme menu). Theme count (187) counted in
  the menu, so the film says "180+".
- The site's logo SVG and its two fonts.
- Score synthesized from the shared timeline; key sounds placed from the
  logged keystrokes through the speed ramp.

## Techniques worth seeing

- **A speed ramp solved to land on the result.** Real time while typing, a
  smooth ramp up to a top speed, back to real time exactly as the result
  appears; the top speed is found by bisection so the recording's result
  frame arrives on the impact beat:

  ```js
  // solve the top speed so the ramp lands exactly on the results
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (integrate(speedWith(mid), b) < need) lo = mid; else hi = mid;
  }
  ```
  The inverse (`filmTime(v)`) moves every logged keystroke to film time, so
  the key sounds still match the sped-up picture.
- **Cuts that accelerate.** The theme list is plain data:
  `["nord", 24.0], ["dracula", 24.5], …, ["laser", 26.25], ["milkshake", 26.5], …`
  — half a beat apart after 26 s.
- **Handoffs by colour.** The title is typed on the site's own background,
  so the site appears without a visible change of picture; the last theme
  is the one whose colour the end card uses.
- **The follow camera moves every frame.** A caret position that steps per
  key made the camera jump and exposed the recording's repeated frames
  (`film check`: 25 hitches); gliding each letter over 0.08 s and averaging
  over 0.6 s fixed it.

## Known limits (from its own notes)

- The typing recording is 1920 wide; at 1.75× it is softer than the 2×
  stills.
- The site's own ad placeholder under the result was framed out by the
  camera, not hidden.
