# Squoosh — one claim per scene, each with its number

A 48 s, 1920×1080 film of squoosh.app (image compression in the browser),
made in October 2026 by Opus 5.5 writing its own film page. Thirteen short
scenes; each says one thing and shows the number that proves it, read off the
real page.

**Brief it was given:** fast-paced and information-dense, like a product
showcase. Length, style and music were the model's choice.

**The comment this film got** (blind, one viewer — the project's owner —
batch of six; verdict "會"):

> 會，感覺整部都很不錯

(Translation: "Yes, the whole film feels really good.") One viewer, one film.

## Structure: a list of claims, cut on the beat

Hard cuts land on beats of a 120 BPM score (measured, scene > 0.30: 5, 8,
12, 17, 20, 26, 29, 37, 42 s — every 3–8 s; whole beats, not always bar
lines). Inside each scene the picture is
one real screen in a rounded window beside a large readout.

| Time | Wants to express | Moves | Holds | Handoff into next | Sound |
|---|---|---|---|---|---|
| 0–3 | a 2.79 MB photo becomes 276 kB — the whole pitch | the number squashes flat, swaps to "276 kB" in pink and springs back; the photo drifts back | the photo behind | a wave from the product's homepage sweeps up | low blips on the beat, then the swap |
| 2.75–5 | the name and the line | logo pops in; the line types word by word, the second half pink | white page | cut | — |
| 5–8 | open it, drop an image or try a sample | homepage window rises; camera pushes to the samples; cursor clicks one | — | cut on the beat | click |
| 8–12 | compare original and compressed by dragging the line | 175 real drag frames; labels ride the divider | the photo | cut | — |
| 12–17 | one slider, the size answers live | quality jumps 75→100→…→1; size, bar and percentage follow; at 100 it turns pink: "bigger than the original!" | the settings panel | cut | a blip per step, **pitch rising as the file shrinks** |
| 17–20 | zoom in, see what you trade | 244 % crop at quality 1, then cut to quality 75 | framing | cut | — |
| 20–26 | many encoders, different results | the panel switches through six real encoders; a bar chart grows one bar each; "AVIF: ↓90% smaller" pops | — | cut | a note per encoder |
| 26–29 | race two encoders side by side | real split view, WebP vs AVIF, slow push | — | cut | — |
| 29–32 | resize in the same pass | width rolls 3872 → 1200 px; size 862 → 118 kB | — | carry | — |
| 32–34 | every knob, if you want it | camera pans down the advanced panel | — | carry | — |
| 34–37 | photos, artwork, screenshots | three cards rise with their own savings | — | cut | — |
| 37–42 | your images never leave your device | a big "0 bytes uploaded", the product's own illustration, its "Ready to work offline" snackbar, two tags | — | cut | music drops to a pad |
| 42–48 | where: squoosh.app | white, the product's two-layer wave rises; logo, URL, one line | — | fade | — |

## Material

- **Stills of the real site** at 2× for every state (13 quality values, six
  encoders, split view, resize, advanced panel, four sample images) — the
  numbers on screen were read from the page, written to a data file, and the
  film reads them from there.
- **A real drag**, 175 frames (an earlier 73-frame take stuttered and was
  shot again).
- **A measured fact**: every network request during the shoot was logged —
  179 GETs, no POST, 0 bytes uploaded — which became the privacy scene.
- The product's logo SVG, illustration and wave shape.

## Techniques worth seeing

- **The opening number squashes, swaps and springs back** — the compression
  itself, done to the text:

  ```js
  const pre = eio(ramp(lt, 1.15, 1.5));          // wind-up: squash vertically
  big.style.transform = `scale(${1 + pre * .25}, ${1 - pre * .72})`;
  // at 1.5 s the text becomes "276 kB" and springs back:
  big.style.transform = `scale(${lerp(1.25, 1, eback(u))}, ${lerp(.28, 1, eback(u))})`;
  ```
  `kit/motion.js` now has springs and a `drop` with squash for this kind of
  move.
- **Sound that reads the data**: each quality step is a blip whose pitch
  follows the file size.
- **A real screen beside a big readout**: the interface stays small and
  legible as context; the claim lives in the large number next to it.

## Known limits (from its own notes)

- Each scene's first frame was empty dark background until entrances were
  offset by 0.14 s; the end card's first frame is still almost white (kept —
  a hard cut on the beat, the logo arrives 0.15 s later).
