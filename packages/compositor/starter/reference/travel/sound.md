> What this is: what the sound of the six films in `structure.md` does —
> tempo, loudness and make-up of each score, where its structure turns and
> what is on screen when it does, whether cuts land on the beat, the effects
> layer, and where it goes quiet. No statement comes from listening: each is from
> spectra, onsets, band energy, loudness and an on-device sound classifier,
> on mixed tracks with no stems, encoded at 48–86 kbps with nothing above
> 16 kHz. Same marks as `structure.md`. Grammar only: no score here is to be
> imitated note for note. The band balance, sub, crest, centroid, flatness,
> stereo and loudness figures of the three films measured in detail are what
> `lib/palette.mjs` reads (`node lib/palette.mjs score.wav` puts a new score
> beside them). Its onset detector differs: 9.9, 8.4 and 6.7 a second for the
> fly, the game and the flying machine, against 11.0, 5.9 and 9.4 in §1.
> `film study` reads the sub on its own scale (2.9, 9.0 and 5.3 dB below the
> total; present 81, 95 and 78% of the time). Its defaults come from here:
> `hit` and `hits` stand 4.8 dB over what their bus already holds (the
> smaller of the fly's impacts, §3; `over: [buses]` names what to stand
> above, `over: []` keeps the gain as given), `subIn` brings the band under
> 80 Hz in 18.3 dB and `dropOut` takes it 19.4 dB down (the fly at 32.792 s),
> or the whole bus 22 dB with `full: true`.

# Six launch films that never stop: sound

## 0. Summary

- **Cuts are not on the beat** in five of the six: about as many land on
  a beat as cuts placed at random would, never significantly more
  [verified]. The sixth (the truck) has 8 of 20 picture
  changes within one frame of a beat on a 68 BPM grid against 1.9 expected,
  but its tempo is unsettled and its effects may sit on its cuts and pull the
  beat tracker there [uncertain].
- **The structure of the sound turns where the story turns**: low end in on a
  reveal or a change of world (+9 to +28 dB) or out (−19 dB), once a drop of
  the whole mix (−21.9 LU for 1.3 s) just after a launch line, a filter
  opening or closing, a build that drops on the cut that reveals the
  result, a single hit at the start or landing of a camera move [verified].
- **A continuous bed with a sub foundation**: energy under 60 Hz only 4.5–10
  dB below the total, present 71–90% of the time; 6–11 onsets a second; a
  "dirty" mid and top (spectral flatness 0.023–0.14) [verified, three
  films].
- **Loud**: five of six at −5.4 to −8.5 LUFS integrated with true peaks
  above 0 dBFS; one at −14.1 LUFS [verified].
- **Sound leaves before the picture does**, or the film stops mid-action
  with it; there is no digital silence before the last second in any of
  them [verified].
- **The loudest moments are not the busiest.** In the fly, the game and the
  flying machine, the five loudest half-seconds and the five busiest
  half-seconds do not overlap at all; in the truck, one of five [verified].

## 1. Each film's score

[verified unless marked; tempo from three trackers that agreed except where
said]

| Film | Tempo | Loudness (integrated / range / true peak) | Make-up [classifier, inferred] | Sections (s) and what is on screen |
|---|---|---|---|---|
| Fly | 130 BPM, 4/4, bar 1.846 s; the steadiest grid of the six (beat confidence 0.82) | −14.1 LUFS / 3.3 LU / −2.4 dBFS | synth, scratching, keyboard; possible voice under the captions; the densest effects layer | intro 0–7.37 (−16.4 dBFS; low end pulled out 2.5–4.9 under the first caption) · first drop 7.37–11.06 · low end gone 11.06–14.65 while the app builds layers and assembles the map, back by 14.76, 0.12–0.23 s before the cut at 14.875 · main 14.76–42.45 (−11.4 dBFS) · late 42.45–59.56 (−13.3 dBFS) |
| Game | 120 BPM (119.2–120.0), kick about once a second | −5.4 / 1.4 / +4.3 | electric guitar, bass: "a wall" (1 s loudness p95−p10 only 2.5 dB) | low-passed intro 0–1.7 (5–16 kHz 31 → 14 dB under median) · top opens at 1.70–1.72 as the sky changes · steady groove 1.7–41.3 · harder low end 41.3–45.8 · kick stops 45.81–47.37, from 0.36 s before the pull-back reveal (46.167) · groove back · build 74.8–76.9 · drop 76.92 · top fades 30 dB 83.9–85.0 |
| Flying machine | ~115 BPM, elastic (beat spacing CV 0.48); grid unusable for sync | −6.9 / 5.3 / +3.0 | orchestra, brass, timpani | 0–37.94 one harmonic texture, ending 140 ms after the failure's stillness begins (37.80) · 37.94–58.91 failure, turn, redesign, delivery · 58.91–63.40 low-passed under the live flight and first title · 63.40–66.90 loudest, most changing, as the machine returns · 66.90–73.53 long tail under the terms (−24.5 dBFS) |
| App | uncertain: 117.6 (librosa), 116.3, or 70 (confidence 0.32); low hits 0.31–0.37 s apart | −7.5 / 3 / +1.9 | — | music enters 4.0 → 4.1 s (RMS −17.7 → −7.3 dBFS) as the input bar rises at 4.133 · drops out 5.1–5.6 between the two typed sentences · a rising sweep ~300 Hz → 2 kHz across 30–39.5 with the low end pulled at 38–39.5 · low end back 39.51 · biggest change 51.00 · out 57.3–57.4 |
| Manga | uncertain: 69.8 or 139.5; a regular kick 33–42.5 at ~143 BPM | −8.5 / 8.7 / +2.3 | — | 0–3.49 · 3.49–15.48 · 15.48–22.96 · 22.96–29.95 (biggest change) · 29.95–42.93 loudest (−6 dBFS) · 42.93–50.92 quietest (−15.3) · 50.92–59.41 · 59.41–62.93 |
| Truck | uncertain: 68 BPM by one tracker (0.83 confidence, bar confidence 0.03), 113 by another, candidates 42.6–171 near equal | −7.5 / 3.6 / +1.3 | 808-style low hits with falling pitch, irregular (0.4–0.9 s) | top filtered 0–3.7 under the title (momentary −13.7 LUFS) · full band opens +4 dB on the cut to the wreck at 3.71 · above 5 kHz removed 10.0–10.67, ending as the checking line cuts in · rising glide 11.2–12.4 into a full-band hit at 12.41 on the cut to 3D · hit 23.01 → short gap → rising glide 23.3–24.0 → top back 23.73, parts scatter 24.0 · biggest change 38.01 as the truck leaves the ground (38.0) · out 40.9–41.3 |

Make-up of the three measured in detail [verified]:

| | Fly | Game | Flying machine |
|---|---|---|---|
| Sub < 60 Hz against total | −4.5 dB | −10.0 | −5.9 |
| 60–250 / 250–2k / 2–6k / 6–16k against total | −6.3 / −8.4 / −14.0 / −16.4 | −4.5 / −5.2 / −9.0 / −15.9 | −6.1 / −4.6 / −14.2 / −21.8 |
| Share of time the sub is present | 79% | 90% | 71% |
| Sub crest (p99 / median) | 7.8 dB | 10.5 | 14.6 |
| Spectral centroid, median | 550 Hz | 1088 | 589 |
| Flatness 200 Hz–8 kHz | 0.139 | 0.123 | 0.023 |
| Onsets a second | 11.0 | 5.9 | 9.4 |
| L/R correlation; sub L/R | 0.87; 0.98 | 0.68; 0.90 | 0.64; 0.86 |
| Classifier effect windows / detector events per 10 s | 5.7 / 15.6 | 1.5 / 2.4 | 2.2 / 4.6 |

Two scores made earlier with this tool's kit and recorded instruments
measured, on the same tools: sub −21.4 and −14.6 dB, present 10% and 38% of
the time with a crest of 34–41 dB; flatness 0.0015–0.0023; 3.5–3.7 onsets a
second; 96–98 BPM; no window the classifier took for an effect; −16 LUFS
[verified]. A short test cue mixed toward the three films' band balance
brought sub / low / mid into their range (e.g. −7.3 / −3.7 / −6.4 dB) but
not presence, air, flatness or onset density; those come from the sound
material, not the engine [inferred].

## 2. Cuts and the beat

Frame-checked cuts against beats from three beat trackers, ±42 ms (one frame
at 24 fps) unless said, with the rate a random time would hit [verified].
`film study` does not test cuts against a beat grid; its shuffled test of
its own cuts against onsets, hits and sub entries reads all six, the truck
included, as no better than chance (the truck's hits p = 0.09):

| Film | Cuts on a beat | Expected at random | Other |
|---|---|---|---|
| Fly | 7 of 28 boundaries | 5.0 (P≈0.22) | 1 of 28 on a bar line (1.3 expected); changes of space and same-plane jumps alike (4/16, 3/12) |
| Game | 4 of 27 | 4.4 | phase over the whole film: Rayleigh p≈0.26. The first 41 s lean ~0.1 s before the beat (p≈0.06); the 8 interface cuts of 64.9–77 cluster on the off-beat (mean phase 0.50, p≈0.04) |
| Flying machine | 3 of 14 (±40 ms) | 2.1 | the grid itself drifts; 3 of 14 within ±40 ms of a sub hit (1.05 expected) |
| App | 6 of 27 changes (±34 ms) | ~3.5 | phase p≈0.26; cuts only p≈0.34; none on a bar line (0/27) |
| Manga | 3 of 15 | 17% each | 62 picture accents: 11 on a beat against 10.6 expected |
| Truck | 8 of 20 on a 68 BPM grid, all on the beat, none on the half-beat | 1.9 (P≈0.0003) | 4 of 20 on a 113 BPM grid (3.2 expected); five cuts on the parts board 23 / 20 / 20 / 18 frames apart, about a beat each |

What does line up is structure [verified]:

- **The fly's hits sit on bar lines, the cuts do not.** 10 of its 26 heavy
  events (impacts, lone sub hits, low-end entries) fall within 60 ms of a
  bar line against 1.7 expected (P≈3×10⁻⁶), mostly on even bars, about every
  3.7 s. Only a few turns are made to coincide (§3).
- **The manga's sound turns on its transformations, not its cuts.** Of 19
  structural sound events (section starts, simultaneous changes, low-end
  entries, lone hits), 9 fall within 0.1 s of a picture accent (4.4
  expected, p = 0.022); against cuts only, 1 of 19.
- **Over one take, events do lock to onsets.** In the game's 23.8 s take, 10
  of 16 picture events fall within 42 ms of an onset (5.6 expected, p≈0.02).
- **The flying machine's camera moves carry its low hits.** 7 of 33 move
  starts and landings in 31–49 s fall within 40 ms of a sub hit (2.4
  expected; 0.7% of shifted copies do as well).

## 3. Where the structure turns

Each row: what the sound does, what is on screen, and the offset as
picture − sound where signed (negative: the picture is first), otherwise in
words [verified].

| Gesture | Film, time | Picture | Offset |
|---|---|---|---|
| Low end in with a hit, after the title | fly 4.90–4.958 | first hard cut out of the title shots | sound ~58 ms before |
| Low end in (+28.5 dB across the cut) | fly 6.50 → entry at 6.70 | cut to the macro shot; the PDF grows to full size at 6.66 with an impact | entry 0.2 s after the cut |
| Rising sweep 9.41–9.62 | fly 9.41 | send button jumps, burst rises | −35 ms |
| Lone sub on a bar line | fly 11.042 / 11.08 | push into the layer panel | −38 ms |
| Low end out, top +14 dB | fly 32.792 (low −19.4 dB) | upward flick into the compositing app | on the cut |
| **Low-end hole 0.8 s (down to −40 dB), riser 43.59–43.79, low back 44.28** | fly 43.45–44.28 | reaching the fifth station, accelerating push 1.48×, cut to the fly | cut 30 ms before the low end returns — the film's one large hit |
| Short gap → impact 47.63 | fly 47.625 | the fly walks into the lens → packshot | −5 ms |
| Low-pass opens | game 1.70–1.72 | the sky swaps in 2 frames (1.708) | sound 0–12 ms after |
| Low end −8 dB, back +11 dB | game 13.38–13.70 | the card turns into a slot and lights | sound 40–48 ms before |
| High "ding", then the top removed 0.85 s (5–16 kHz −20 dB, tonal beeps) | game 23.04–23.9 | match cut grey → lit | sound 23–43 ms before |
| Kick stops 1.56 s, low-mid +5 dB, top −4 dB | game 45.81–47.37 | the clip is pulled back into a plane from 46.167 | kick stops ~0.36 s before the pull-back; an onset lands 9 ms after it starts |
| Strongest low hit of the stretch, low −14 dB to 62.35 | game 61.74 | the panel's edges square with the frame (61.667) | 73 ms after |
| **Build: low −10 to −20 dB, 5–16 kHz +5–7 dB, whole −4.6 dB → drop: low back 16–18 dB in 40 ms** | game 74.8–76.96 | push through the words, cut on the brightest frame into the reveal | sound 0–23 ms after |
| Top closes −12 dB, reopens slowly | game 76.95–77.58 | the pixel reveal | — |
| Full-band hit, flux peak | flying machine 8.00 | send pressed | ~−10 ms |
| Sub hits on the window hop | flying machine 31.49, 32.00, 32.54 | pull-out starts, window lands, next window starts to lift | +10, 0, −7 ms |
| Top +8 to +9.5 dB rising | flying machine 36.7–37.3 | into the wing breaking at 37.03 | — |
| **Top −15 dB, low −14 dB for 2.5 s** | flying machine 37.8–40.27 | the dead-still failure | — |
| Brightest hard cut, top back +3.5 dB | flying machine 40.267 | dark → light board | cut 47 ms after a beat |
| Low end hollowed, one hit left | flying machine 40.7–42.3, hit 41.27 | the 2-frame whip pull-out at 41.233 | −37 ms |
| Sub hits on the two key interface cuts | flying machine 54.767, 57.433 (the strongest in the film) | black → white reply; upward motion into the button | −3, +3 ms |
| Ticks on each file row | flying machine 55.77 / 56.20 / 56.63 | rows reach full size | −27 / −13 / −20 ms |
| Top −16 dB 0.1 s after the cut | flying machine 58.567 | push through into live action | — |
| **Drop 9.4 dB within 100 ms; −21.9 LU from 60.40 to 61.70** | flying machine 60.300 | the launch line appears as the picture darkens ×0.71 and loses half its sharpness | −20 ms |
| Low-pass sweep to the top | flying machine 63.467 | the machine reappears over the ridge and the line changes | +27 ms |
| Music in (+10 dB) then impact | app 4.1, 4.36 | input bar rises 4.133; typing starts 4.40 | ≤ 1 frame; 40 ms |
| Music out for the punchline | app 5.1–5.6 | between the two typed sentences | — |
| Low end back (strength 0.6) | app 37.13 | push into the stack 37.27 | 0.14 s |
| Low end back (strength 1.0) | app 39.51 | the ready line finished at 38.9; the dissolve at 40.33 | drop 0.8 s before the picture change |
| Biggest change in the film | app 51.00 | whip into live action 51.033 | 30 ms |
| Low end in | manga 19.74 | the sweep of light starts 19.667 | sound 0.07 s after |
| Biggest section change | manga 22.96 | the ring bursts from the generate button 23.0 | sound 0.04 s before |
| Low end out | manga 44.37 | cut to live action 44.583 | sound 0.21 s before |
| Low end in + impact | manga 47.72 / 47.77 | holographic pages rise 47.79 | sound 0.07 / 0.02 s before |
| Rising arpeggio, cut off | manga 50.9–54.25 | the view count tops out; hard cut | on the cut |
| Section change, top in | manga 59.41 / 59.49 | the volleyball hits 59.458 | sound 0.05 s before / 0.03 s after |
| Full-band opens +4 dB | truck 3.77 | cut to the wreck 3.71 | sound ~60 ms after |
| Rising glide → full-band hit | truck 11.2–12.41 | hard cut to 3D 12.417 | on the cut |
| Biggest change: mid hits halve, 142–225 Hz +5 dB, top −6 dB | truck 38.01 | the truck leaves the ground (frame 912 = 38.0) | ~0 |

Heavy hits are few: the fly has 12 impacts and 10 lone sub hits in 59.6 s
(one about every 2.7 s; with low-end entries, 26 heavy events, one every
2.3 s, mostly on the score's own bars); the game
has 2 lone low hits (81.30, 83.97) in 85 s; the flying machine 3 lone booms
(35.41, 62.03, 65.25) [verified].

## 4. The effects layer

[verified counts; what they are is inferred from spectra]

- **Fly**: the most designed sound — impacts, lone sub booms, sweeps (9.41,
  43.59, 45.54 up; 25.34, 38.33 down), 18 short gaps of 30–150 ms, mostly
  30–60 ms before a hit; 126 short high transients, most of them hi-hat,
  some in runs of 3–12 at 4–9 a second while interface elements appear. A
  classifier marks typing at 2.5–3.0, 8.0, 16.0 and 19.5 s, over typing on
  screen.
- **Game**: almost none — 5 ticks, 1 sweep (56.64, not on any whip), 2 lone
  hits. Typing, clicks, whips, rays and the title have no sound of their
  own.
- **Flying machine**: about 15 designed sounds, one every ~5 s: the opening
  hit, send, a whip, 4 ticks, 3 swishes on the star's wipes (57–107 ms
  from the move, each envelope spanning the whole move), 3 booms.
- **App**: mixed track only; structural events listed in §3.
- **Truck**: 47 sub hits with a falling pitch; its effects may sit on its
  cuts (§2).

Typing and clicks are silent in the game, and no keyboard sound could be
measured in `../structure.md`'s film either; the fly is the exception
[verified].

## 5. Quiet and the ending

[verified]

- No film has digital silence (under −50 dBFS) before its last second.
- Space is made by sudden drops instead: the flying machine −21.9 LU for
  1.3 s after its launch line, −17.7 LU at 67.70–68.70, −36.2 LU from 69.00
  to 73.10 under the terms; the fly's low-end holes (2.5–4.9, 11.06–14.65,
  32.6–33.2, 43.45–44.25, ~51.0–51.4; the second is back by 14.76); the app's 0.5 s gap before the
  punchline.
- Endings: the fly drops out 59.03–59.33 and is silent 59.37–59.57 with the
  picture held 0.55 s more; the game fades its top 30 dB over the last
  second and never goes silent, over a near-freeze; the truck cuts out at
  40.9–41.3 with the truck still in the air; the app's music ends
  57.3–57.4, 0.2 s before the closing card completes (57.57); the flying
  machine tails off from 66.90 at −24.5 dBFS. In catalogue films the music
  leaves 0.1–0.6 s before the end card.

## 6. Loud where the picture is calm

[verified, from loudness and picture change per half-second]

- Fly: loudest half-seconds 15.0, 41.0, 34.0, 9.5, 29.5; busiest 32.5,
  44.0, 13.0, 33.0, 4.5 — no overlap. The fly's shots are nearly still and
  loud; interface stretches are busy and quieter.
- Flying machine: loudest 33–35.5 and 65.5; busiest 24.5–27.0 and 54.5 — no
  overlap.
- Truck: one of five overlaps; the sound peaks at the build and the
  take-off (23.5, 38.0, 38.5, 24.0, 39.0), the picture at transitions (5.0,
  37.0, 34.0, 12.0, 24.0).
- `../structure.md`'s film shows the same: its loudest half-seconds are on
  the finished whiteboard, held still.

## 7. Uncertain

- No stems: what is an effect and what is the score is guessed from band
  shape and timing.
- Tempo is reliable only for the fly (and the game's 120); the truck's
  on-beat cuts depend on a grid that may itself have been pulled to the
  cuts.
- Whether the fly has a voice under its captions: a pitch tracker found
  voiced frames in 0.18 and 0.10 of the first two caption windows and none
  in the other four, no more than in control windows a bar later.
- Loudness on social platforms: whether they normalise was not checked, so
  "louder on a phone" is not established.
