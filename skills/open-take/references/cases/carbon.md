# Carbon — a question asked at the start, answered at the end

A 47 s, 1920×1080 film of carbon.now.sh (images of source code), made in
October 2026 by Opus 5.5 writing its own film page. It opens on a problem,
asks a question, tours the product briefly, then spends most of its time on
**where the result goes and who uses it**, and closes by answering the
question beside the opening shot.

**Brief it was given:** rich material — not the whole film circling one
interface: real outputs, where it is used, different pages and states, a new
thing to look at in each part, switched on the beat of the music — and a
story: open on something the viewer cares about, answer it at the end;
features are things the story uses, not a list to tour. Length, style and
music were the model's choice.

## Structure: problem → question → answer, with a bookend

All cuts sit on the beat of a 120 BPM score (measured, scene > 0.30: 20 cuts,
2–42 s; 25.5 cuts a minute; five-second counts `1 1 3 3 1 5 3 2 1 0`).

| Time | Wants to express | Moves | Holds | Handoff into next | Sound |
|---|---|---|---|---|---|
| 0–2 | someone wrote good code | code types out on black | black | cut | pad, a quiet pluck with the typing |
| 2–4 | they shared an ugly screenshot | a post in a feed: blurry screenshot, file tree, red squiggles, ♡ 0 | the post | carry | a dull thud as it lands |
| 4–6 | nobody stopped | the feed drifts, then whips up past with blur | — | cut | a whoosh |
| 6–8 | how do you make people actually *read* your code? | the question types on black, "read" in yellow | black | cut on the drop | riser and a clap roll |
| 8–10.5 | the answer has a name | the real logo on the real page, then pull out to its line and editor | — | carry | **the drop**: full groove starts, sub and bell |
| 10.5–13 | paste, pick a look | empty editor → ⌘V keycap → code; the theme menu opens | — | cut | UI clicks |
| 13–17 | one theme changes the whole feel | close on the image frame; a different real theme every beat (8), name tag in the corner | the framing | cut | groove |
| 17–21.75 | background, settings, export | real colour picker (a swatch per beat), settings panel, export menu → PNG | — | the click | — |
| 21.75–24 | the result is a crisp PNG | the real exported PNG grows **out of the button just clicked** to centre | — | cut | accent |
| 24–30 | it goes wherever code is shared | one place per second: post, slides, blog, docs, chat, course — each with a different real export; caption's last word swaps | the caption | cut each second | an accent per place |
| 30–34 | embed it, open it from VS Code, Vim, the terminal | real embed page, Marketplace page, plugin READMEs, slow pushes | — | cut | — |
| 34–38 | people use it; it is open source | real About page logos; real GitHub page, a star counter runs to the real count | — | cut | a clap fill before the answer |
| 38–42 | answer: make it look as good as it is | the opening post, dimmed and small, beside the same code as a Carbon image | — | cut | breakdown |
| 42–47 | where: carbon.now.sh, free, no sign-up | logo, URL, one line | — | fade | riser into a held C chord |

The product tour itself is about 14 s of 47; the rest is the question, the
places, the proof, and the answer.

## Material

- **Stills of the real site** (29 at 2×): homepage, paste, theme list, eight
  themes, backgrounds, settings, export.
- **Real outputs**: seven PNGs actually exported from the product in seven
  languages and themes — these fill the "where it goes" scene.
- **Real pages around the product**: its embed page, About page, GitHub repo
  (star count read from the GitHub API that day), Marketplace and plugin
  READMEs.
- Generic layouts the film built in HTML for the six places (no real
  platform's branding) and for the opening ugly screenshot.
- The product's logo SVG (from its DOM) and its editor font.

## Techniques worth seeing

- **A result that comes out of the control that made it.** The PNG starts at
  the export button's place in the picture at the moment of the click — read
  through the camera — and grows to centre:

  ```js
  const btn = cam.toView(1303, 514, T("click"));   // the PNG button, on screen
  const p = out3((t - T("hero")) / 0.55);
  const w = lerp(220, 1500, p);
  const x = lerp(btn[0], 960, p) - w / 2, y = lerp(btn[1], 500, p) - h / 2;
  ```
  Its first version flew in from off screen, oversized and blurred; the
  master showed it as a smear. In `kit/motion.js` terms this is a
  `morphRect` whose start rectangle is the button's box on screen.
- **The same picture at both ends.** The opening post comes back at 38 s,
  dimmed, beside its answer — the viewer reads the change without a caption
  explaining it.
- **One beat, one item** for variety (themes, swatches), one second per item
  for the places — the cut rate follows how much there is to read.

## Known limits (from its own notes)

- Captions over white pages needed dark backing; the star counter first sat
  on GitHub's own buttons and was moved into a dark card.
