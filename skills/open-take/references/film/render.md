## Render

```sh
npx open-take film render film/index.html --out film.mp4          # 1080p60 master
npx open-take film render film/index.html --draft --out draft.mp4 # half size, 30 fps, no blur, fast
npx open-take film render film/index.html --from 12 --to 16 --out part.mp4
```

Render the master once, when the film is done; look at drafts and stills
while you work on it. A draft has no blur and half the frames; a few
seconds whose motion matters — a handoff, a whip, a fast zoom — can be seen
as the master will show them, alone, with `--from`/`--to` and no `--into`
(it costs those seconds' share of a master render). A change to a few
seconds goes into the master you have, in place of its own frames — the rest is not drawn again; a change to
the sound alone is not a render at all:

```sh
npx open-take film render film/index.html --from 12 --to 16 --into film.mp4
npx open-take film mux film.mp4 --audio score.wav
```

A `<video>` on the page is shown from its decoded frames: steady under a slow
push and quick to render, as it is — and one you draw into a canvas gets the
same frames.

The directory served is the working directory when the page is inside it
(`--root <dir>` otherwise); a file the page asks for that is not there fails
the render by name. Motion blur is measured, not guessed: every frame's
shutter (180°) is probed for how far anything visible moves and gets one
sample per 3 px of travel, averaged in linear light — still frames pass
through untouched. The master is H.264 High, yuv420p, BT.709, 60 fps, with the
soundtrack as AAC. `<audio>` elements on the page are not recorded — the
soundtrack is `__film.audio` (or `--audio <file>`).

Every render also writes `<film>.events.json` beside the film: the page's
events and named moments, each curve sampled once a frame, and the cuts —
the page's events of kind `"cut"` (`declaredCuts`) and those the blur probe saw
(`detectedCuts`; a draft or `--no-blur` sees none, and a cut between two
shutters can be missed) — and the page's beat sheet as `segments`
(`tl.segment`). A page without hooks gets empty lists. A
`--from --to --into` patch updates the master's file in place. The score's
script reads it, so the sound follows the picture as rendered.

When a render is done it prints a few lines measured on the film it made,
each saying what it covered (`--no-report` leaves them out; they take a few
seconds): where the product's own words — its saved screens, and the text
in its pictures read from their files — are most of the text on screen, and
how big they are on a phone; the one-frame jumps the page did not declare as
cuts, and how far their content moved (a card that jumps, a saved screen
swapped under the camera, a line re-centred as it is typed) or that it
changed in place; pictures on screen that their shoot took while the
product's screen was still changing; moves of the picture where what it
ends up framing heads the wrong way first, or past its place and back (a
view whose centre and zoom move apart, or that is clamped inside the page
every frame, does that; `kit/camera.js` moves straight); live text moving
under a pixel a frame; the parts named through `product()` at each use, and
pictures drawn past their own pixels (`skill film checking`). Facts, not grades; `film probe` reads all of it and
more.

Text that moves slowly on a live page — a slow push or drift across an
interface, the ease into and out of a move, the settle at its end — steps a
pixel at a time, because Chrome places each glyph on a whole pixel. A render
draws those frames at 3× the pixels each way and averages them down, each
stretch reaching to the nearest cut or fast move so that the change does not
show, and says where (`drawn at 3× …`). On two stretches of one film (a
4.8 s push over a live page; a 1 s move and its settle) the whole-pixel steps
went from 8 and 5 to none, as with every frame at 3×, in 4.3× and 1.3× the
plain render's time instead of 4.8× and 6.8×. `--supersample <n>` draws
every frame at n instead; `--supersample 1` draws none finer. A picture of
the screen moves smoother still, and renders in about the live screen's
time: shoot it once at twice the pixels, show that picture at the screen's
size, and render with `--supersample 3`:

```sh
npx open-take film picture takes/x.take/states/s3   # → states/s3/picture@2x.png
```

Measured on a saved screen pushed from 1× to 1.6× in 4 s (six
lines of 13–18 px text, frame-to-frame jitter): 0.49 px as the live screen,
0.19 px as the live screen with `--supersample 3`, 0.08 px as the picture
with `--supersample 3` (0.10 with `--supersample 2`), which rendered in about
the live screen's time without it. The picture's last frame is as sharp as
the live screen's, a shade lighter.

A render drops the page's `will-change` hints. With one, Chrome can keep a
layer as a single picture drawn at the size it had and scale that picture:
on two films a layer the camera had enlarged to about 2× showed its text
soft, at a third to an eighth of the sharpness the same frame had without
the hint, and sharp again only where frames were drawn at 3× — so the text
went soft and sharp as the camera stopped and moved. `--keep-layers` keeps
the hints (`film still` takes it too).

A layer under a CSS `perspective` is drawn by Chrome at no more than about
the frame's area. Tilt a whole saved page (1920×1300) and push in to 2.3×,
and its text is drawn at about a third of the size it is shown, then
stretched: soft, on one film, and as soft with `--supersample 3`. The same
frame without the perspective was sharp, and so was a tilted box no bigger
than the part it shows: an `overflow: hidden` window around the card, or the
card alone. The render's report names such layers among the pictures drawn
past their own pixels ("under a perspective").

Measured on stills of a page drawn in the film's own DOM, its 706×203 card
turned rotateX 8°, rotateY −18° under the camera at 2.3× (edge energy of the
card's text, higher is sharper): the whole page as one layer under the
perspective 25.6k; the card alone as a slab of `kit/stage.js` 42.8k; the
same view flat, no tilt, 50.1k, and the stage's slab square on 50.1k too.
The stage keeps each slab the size of its part, writes a slab square on to
the lens as a plain 2D transform (so a push or the lens travelling up to it
is drawn at its final scale), and its `warnings()` name a tilted slab drawn
bigger than the frame, and when. A saved screen shown through an iframe
measured the same whole or cropped to the card (17.4k each) in these stills.

A `<canvas>` is drawn at its own `width` × `height`. On one film a grain laid
over the whole frame from a 480×270 canvas (4× stretched, 7 %, overlay)
looked yellowish and smeared at full screen; the same grain from a
1920×1080 canvas looked clean. The report lists a stretched canvas too.
