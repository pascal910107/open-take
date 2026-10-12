# Mermaid Live Editor — text in, diagram out, for engineers

A 30 s, 1920×1080 film of mermaid.live, made in October 2026 by Opus 5.5
writing its own film page, for an engineering audience. Five claims, each
shown happening in the real editor, then an end card.

**Brief it was given:** a 30-second technical short for engineers — how it
works and why it saves effort. Everything else was the model's choice.

## Structure: close-in hook, pull out, claim by claim

| Time | Wants to express | Moves | Holds | Handoff into next | Sound |
|---|---|---|---|---|---|
| 0–2.8 | diagrams are code | one line of syntax typed character by character, camera at 2.5× on it | the camera, nearly still | the pull-out | intro pad, a riser, a soft tick per real keystroke |
| 2.8–9.3 | it renders as you type | camera pulls out to the whole editor (2.7→3.5 s); three lines typed; the preview grows node by node, greys out while the syntax is briefly invalid | framing after the pull-out | carry | **the kick starts at 3.0, as the camera opens**; ticks continue |
| 9.3–14.3 | change two letters, new layout | a box marks `TD`; `L` shows an error, `LR` re-lays the whole diagram sideways; a ripple marks the real Reset view | the editor | carry | an error blip, a reflow hit |
| 14.3–20.5 | the diagram lives in the URL | camera backs out to show the browser frame and the live URL, pushes into the `#pako:` hash; a panel decodes it step by step to the JSON | — | panel leaves *before* the camera moves back | kick drops to downbeats only, pad louder; a whoosh out, a swell into the bar, a shimmer on decode |
| 20.5–25.5 | dozens of diagram types | the real Sample Diagrams buttons switch type every 0.85 s; a corner label shows each one's first line | framing | the editor fades first | a sound per switch |
| 25.5–30 | free, open source, no sign-up | end card: logo, name, URL, one line | — | fade to black | a final kick |

The scene detector finds no hard cut (measured: nothing above 0.30; one
change above 0.12, at 17.4 s, as the decode panel covers the frame);
everything is camera and content changing inside one picture.

## Material

- **Stills of the real site**, one 2× screenshot per keystroke (98 in all),
  with the real URL logged at each — played back as a flipbook on film time.
  The URL bar and the decoded JSON are the site's real state at each moment.
- The opening single-node state was opened by URL in the site's own `#pako:`
  format, so the preview starts from the author's diagram, not the default.
- The site's own font (Recursive) and logo SVG.
- Score synthesized from the same timeline as the picture.

## Techniques worth seeing

- **The drums arrive with the camera.** The camera keys and the score share
  one file; the pull-out starts at 2.7 s and the kick at 3.0 s:

  ```js
  { t: 0, x: 322, y: 196, z: 2.5 },   // on the line being typed
  { t: 2.7, x: 326, y: 198, z: 2.42 },
  { t: 3.5, x: 800, y: 450, z: 1.0 },  // the whole editor
  // score: for (let t = 3.0; t < 25.5; t += BEAT) kick(t, …)
  ```
  Today the same coupling can run through `tl.curve` (e.g. the camera's speed) and the
  score's `curveOf`.
- **The section about a hidden property thins the music** — the URL section
  keeps only downbeat kicks under a louder pad, so the explanation reads as a
  different part.
- **Leave before you move.** The decode panel fades out before the camera
  pulls back, and the editor clears before the end card enters; both were
  fixed after a master showed them overlapping in motion blur.
