# Song Maker — the product plays its own soundtrack

A 54.6 s, 1920×1080 film of Chrome Music Lab's Song Maker, made in October 2026
by Opus 5.5 writing its own film page and rendering it with `film render`.
It teaches the one action (click a square, hear a note), keeps adding to the
same song, and never leaves the one interface. Every sound in it is the
product's own output.

**Brief it was given:** make a launch film for people who have never heard of
it; no added music — every sound must come from the product itself. Length,
style and everything else were the model's choice.

## Structure: one session, built up in layers

The whole film is one real recorded session. The edit jumps forward inside it
(skipping waits), always inside the same framing, so a scene detector finds
no hard cut (measured: no change above 0.30, one above 0.12 at 42.2 s).

| Time | Wants to express | Moves | Holds | Handoff into next | Sound |
|---|---|---|---|---|---|
| 0–1.5 | an empty grid you can click | cursor heads to the first cell; camera at 1.42× | the empty grid; caption "Click a square." | first click | silence, waiting for the first note |
| 1.5–3.4 | one click = one note | first square appears with a ripple | camera | caption swaps in place | the first marimba note |
| 3.4–7.6 | higher square, higher note | four more squares; camera eases out | caption | carry: same session | each click sounds |
| 7.6–11.45 | keep clicking — that is a melody | camera reaches the whole grid; squares appear in rhythm | the grid | carry | the melody as it was clicked |
| 11.45–13.45 | the lower rows are bass | camera moves to the lower half | — | carry | bass notes |
| 13.45–14.15 | press play | push in on Play; cursor clicks | — | the click | — |
| 14.15–22.15 | what you clicked is already a song | camera pulls back; playhead sweeps left to right | the grid; "It's already a song." | carry | the whole loop, 8 s |
| 22.15–30.2 | add a beat | camera follows the cursor along the drum rows | the song keeps playing | carry | drums join one by one |
| 30.2–32.2 | the full song | pull back | — | carry | melody + bass + drums |
| 32.2–42.2 | same song, new instrument | instrument button clicked; a large label swaps (Piano → Strings → Woodwind) | the grid, framing | carry | the same melody in each instrument |
| 42.2–46.7 | it can go faster | push in on the Tempo slider; 120 → 148 | — | carry | faster, now Synth |
| 46.7–54.6 | name, where, free | the whole interface shrinks into a card on a light grid, still playing; title, line, URL rise in | the playing song | — | the song continues; last 2.2 s fade out |

What changes from section to section is not the picture (it is always the same
grid) but **what the song has**: one note → a melody → bass → playback →
drums → a new instrument → a new tempo. The film's build-up is the song's
build-up.

## Material

- **Recording** of a real session, driven live by a script (melody, bass,
  play, drums, instrument switches, a tempo drag), screencast at ~55–58 fps.
- **The product's own audio**, tapped from the page's `AudioContext` during
  the same session. (open-take now does this in `make`: the take keeps
  `product-audio.wav` on the capture clock — see film.md, Sound.)
- The product's font (Poppins) and its own instrument SVG icons for the label.
- No saved states, no music or effects added.

## Techniques worth seeing

- **Cut on bar lines, in chord order.** Every jump in the recording during
  playback lands on a bar line and keeps the chord sequence (bar 1 is always
  followed by bar 2), with 20 ms crossfades — so the music sounds continuous
  across edits the viewer never sees.
- **Two measured latencies.** The film measured how late the product's sound
  is against its own picture, separately for two situations, and shifted each
  stretch by its own lag:

  ```js
  // Song Maker sounds a clicked note ~0.33 s after the square appears, and
  // plays back ~0.05 s after its playhead; each stretch takes its sound that
  // much later so sound and picture land together.
  export const LAG = { prev: 0.33, play: 0.05 };
  ```
- **The ending keeps the product alive.** The interface becomes the end
  card's picture while the song keeps playing, then fades out.

## Known limits (from its own notes)

- The recording is 1× (1080p); pushing to 1.6× looked soft, so the film
  lowered its zooms to 1.36–1.42×. A 2× picture of a saved screen would stay
  sharp, but a recording of live playback cannot be swapped for a still.
- Its camera interpolated centre and zoom separately — the pattern
  `kit/camera.js` replaces; at its gentle zooms nothing visibly swung.
- `film check` flagged ~30 possible clicks; they are the product's own
  percussive attacks, kept.
