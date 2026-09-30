# Authoring composable motion

Read this for requested launch films or designed animated explanations. A clean
recording with cursor/zoom stays on `make`/`render`. Choose composition and motion
from the actual product story; examples are vocabulary, not required layouts.

For a launch, or a draft that feels thin or unfocused, first read
[launch-story.md](launch-story.md). It covers scope, a single takeaway, source
evidence, optional checked story metadata and continuous-sequence review.

## Start from evidence and a visual direction

Capture real UI and verify the demonstrated states. Use footage for operations
the viewer needs to see happen. Use screenshots/crops for a detail or comparison;
an animated screenshot is not proof that an interaction occurred. Label diagrams
or simulated data as illustrative when that distinction matters to the story.
Preserve the product's typography, assets and visual character when available.

Select a direction before authoring: a commerce comparison might use opposing
panels; analytics may emphasize one result with a drawn trend; collaboration may
use spatial movement through a workflow. Editorial typography or full-screen
footage may fit better than either. Do not reuse an unrelated product's signature
input bar, chip arrangement, timing and shot order as a universal template.

`launch init <directory> --video <recording>` creates editable title/footage/end
scenes. Replace the placeholder copy. Remove cards that do not serve the brief.
Add `motion` scenes only when wanted. An image-only composition can be authored
directly as JSON; the initializer is a convenience, not a required capture step.

## Prefer protected layouts for a first draft

Start with `open-take launch compose brief.json --out launch.json` when `focus`,
`compare` or `steps` fits the story. Supply the actual content and assets instead
of guessing dozens of layer coordinates. The generator owns margins, hierarchy,
image fit, aspect-dependent layout and entrance timing; the resulting ordinary
`motion` layers remain editable. `--out` must be a new file. Asset paths in the
brief resolve from its directory and are rebased for the output JSON.

The brief has the usual `version`, `output`, `theme` and optional `audio` and
`story` fields.
Its `scenes` can mix existing footage/title/motion scenes with these recipes:

| Recipe | Content fields | Best use |
| --- | --- | --- |
| `focus` | `title`, `image: {asset, crop?}`, optional `body` | Explain one real UI detail |
| `compare` | `title`, `before: {label, image}`, `after: {label, image}`, optional `body` | Compare two verified states or peer subjects |
| `steps` | `title`, `steps: [{label, body?}]` (2–5) | Explain a process, with real footage as proof where needed |

Each recipe needs `id` and `recipe`; `durationS`, `motion`, `transition` and `style` are
optional. Without `durationS`, reading needs and entrances determine duration.
Explicit timing remains the author's choice and receives quality checks. Theme
is the same shape as a launch composition; use the target brand with readable
foreground/background roles. Portrait output receives a stacked layout.

Optional `style` selects `editorial` (typographic hierarchy and quiet media),
`product` (media emphasis and rounded, raised surfaces), or `technical` (precise
rows and structural lines). Omitting it preserves the original treatment.
These are bounded visual alternatives, not website categories; all retain the
supplied theme, complete source image and copy, and respect `motion: "off"`.
Inspect the render before accepting a new combination of style and content.
For styled `focus` recipes, an authored source-pixel `crop` also supplies the
media aspect: code fits the media inside its padded surface and keeps portrait
copy together with that surface. This avoids placing a wide detail inside a
tall empty panel. Without crop dimensions, the pure compiler retains its usual
layout; it does not open image files or infer a relevant crop. An extreme aspect
can remain structurally valid but visually unhelpful, so inspect the actual detail.

```json
{
  "id": "detail",
  "recipe": "focus",
  "title": "Every handoff has an owner.",
  "body": "Show the verified result, then explain its value.",
  "image": {"asset": "assets/result.png"}
}
```

Handle fit errors by editing copy, choosing a better source crop or splitting a
scene; do not silently truncate the user's message. `launch check` also reports
quality concerns such as tiny text, known low contrast, resting content outside
the frame, insufficient reading time, or a foreground line entering image/video
bounds during a sampled visible hold. Connector advice identifies a layer and
scene-local time; inspect the actual media before retaining an intentional
annotation. Sampling is bounded and does not read text inside the asset.
These are heuristics for free layouts,
not proof of artistic quality or correct storytelling. Inspect the rendered
frames. Keep a simple recording when extra design does not help.

### Recipes from a recording

When the product was recorded with `make --states`, two recipes take the take
itself as material. You name WHAT to show — actions of the take and an
element of a saved screen — and the program owns the rest. The camera is the
take's own director: it follows the hand (pushing in on each action, easing
out for page-wide changes), and when an action changes something elsewhere on
the page — a field whose result appears across the screen — it shows the hand
through the action, then looks at the result (the saved screens tell it what
changed where). The recording starts a beat before the hand moves and never
before the page settled; an idle stretch between two actions is cut only where
the cut lands on a new framing, never inside one. The cursor, click ripples,
switching between recording and saved screen where they match, how big a
lifted element grows and where it goes, reading-time holds and the curves are
the program's too. Scenes of one take continue each other: the recording's
clock and the cursor carry over.

| Recipe | Fields | What it shows |
| --- | --- | --- |
| `proof` | `take`, `from`, optional `to` | The recorded actions `from` → `to` through the take's camera (the hand, then what it changed), until the last result has been seen |
| `lift` | `take`, `after`, `element`, optional `change` | The screen `after` left behind; `element` lifts out of it, big and sharp, the page dimmed behind; with `change`, a later action's change to it happens in place; then it goes home and the recording carries on |

`take` is the `<name>.take` folder, relative to the brief. Actions are `a1`,
`a2`, … as `open-take states <take>` numbers them (it also lists what each
action changed, the saved screen it left behind, and its elements); an
element is an id of the state that action left behind (`e32`). Read the
listing, then choose: prove the actions that carry the story with `proof`, and
`lift` the one element whose content IS the point — a value that changed, a
card the viewer must read. A lift is a close look, not a transition; one or two
in a film, where the content earns it. A state that failed its fidelity check
cannot be lifted (show that moment with `proof`).

```json
{ "scenes": [
  { "recipe": "proof", "id": "add", "take": "shop.take", "from": "a1", "to": "a2" },
  { "recipe": "lift", "id": "total", "take": "shop.take", "after": "a2", "element": "e41", "change": "a3" },
  { "recipe": "proof", "id": "pay", "take": "shop.take", "from": "a4" }
] }
```

Use free layers below when the purpose calls for a different visual structure.
The protected recipes are starting points, not the entire animation system.

## Composition and coordinates

The root JSON uses `version: 1`, `output: {width, height, fps}`, a theme and ordered
`scenes`. Each scene has an ID and its own duration; their sum is film length.
Transitions happen within a scene's duration. Audio is optional and separate.

```json
{
  "id": "result",
  "type": "motion",
  "durationS": 3.5,
  "designSize": {"width": 1920, "height": 1080},
  "transition": {"type": "cut"},
  "layers": [
    {
      "id": "label", "type": "text", "x": 0, "y": -40,
      "text": "See the result.", "width": 1300, "height": 180,
      "fontSize": 110, "fontWeight": 600,
      "animations": [
        {"property": "y", "keyframes": [
          {"atS": 0, "value": 50},
          {"atS": 0.8, "value": -40, "easing": "ease-out"}
        ]},
        {"property": "opacity", "keyframes": [
          {"atS": 0, "value": 0},
          {"atS": 0.5, "value": 1}
        ]}
      ]
    }
  ]
}
```

Coordinates are design pixels relative to the center of the scene or parent
group. Later layers paint above earlier ones. Group children move/scale/rotate
with their parent. `designSize` defaults to 1920×1080 and fits uniformly into the
output. Draft scaling preserves the authored geometry. For a portrait layout,
author a portrait design size and rearrange the content; aspect fitting does
not automatically redesign a landscape scene.

All layer kinds share `id`, `x`, `y`, `opacity`, `scaleX`, `scaleY`, `rotation`
(degrees), and optional `animations`. Position/rotation default to 0; opacity
and scales default to 1. IDs must be unique throughout a scene.

| Type | Required fields | Optional fields |
| --- | --- | --- |
| `group` | `children` | `width`, `height`, `clip` (clipping requires both sizes), `radius` (only with `clip: true`) |
| `rect` | `width`, `height` | `fill`, `stroke`, `strokeWidth`, `radius`, `shadow` |
| `ellipse` | `width`, `height` | `fill`, `stroke`, `strokeWidth` |
| `text` | `text`, `width`, `height`, `fontSize` | `fontFamily`, `fontWeight`, `fill`, `align`, `lineHeight`, `reveal`, `units` |
| `image` | `asset`, `width`, `height` | `fit`, `radius`, `crop`, `shadow` |
| `video` | `asset`, `width`, `height`, `durationS` | `fit`, `radius`, `trimStartS`, `startS`, `shadow` |
| `state` | `state`, `width`, `height` | `fit`, `radius`, `crop`, `only`, `hide`, `shadow` |
| `cursor` | — | open-take's arrow, its tip at the layer's origin (24 × 39 at scale 1) |
| `line` | `points` (array of `[x,y]`) | `stroke`, `strokeWidth`, `end` |
| `wipe` | `atS` | `durationS`, `holdS`, `revealS`, `direction` (`right`/`left`), `color` |

Text wraps in a bounded box. `align` is `left`, `center` (default), or `right`;
`lineHeight` is in design pixels. `reveal` runs 0–1 over grapheme clusters (so an
emoji or combining character is not cut into code units). Leave enough height
for all lines and inspect the rendered font; estimated validation cannot know
every installed font. Defaults inherit theme `ink`, `surface`, and `accent`.

`units` makes copy move word by word (or grapheme by grapheme) with **named
moves** — the program owns the distances, curves, masks and blur; you choose the
move and when: `"units": {"by": "word", "moves": [{"move": "rise", "atS": 0.4},
{"move": "fall", "atS": 5.2}]}`. Arrivals: `rise` (each word rises into place
through a mask at its line — the default for a headline), `pop` (settles from
slightly large with a blurred first frame — a word that lands on a beat),
`fade`. Exits: `fall` (each word drops away, tipping and blurring — lets a line
leave with the same energy it arrived with), `fade-out`. At most one arrival,
then at most one exit; optional `staggerS`/`durationS` override the measured
defaults. CJK copy is segmented into words too. Do not combine `units` with a
`reveal` track (typing), and give the box no clip of its own when a unit leaves
it (a `fall` leaves the box).

Image assets are local PNG, JPEG or WebP; paths resolve relative to the JSON.
`fit: "contain"` preserves all of the source; `"cover"` crops to the layer box.
`crop: {x, y, width, height}` selects a rectangle in original source-image pixels
before fitting. Use measured element bounds, not guesses. The renderer stages
copies and keeps the original screenshots intact. Remote URLs, SVG/HTML and
executable layer code are not supported.

Video layers use local MP4, WebM or MOV assets. `trimStartS` selects the first
source second; `startS` is when playback begins inside this scene (both default
to zero). Required `durationS` selects the source span, which must fit the source
and end inside the scene. The layer holds its first frame before `startS` and
last frame after the span; it never adds the source soundtrack. Video uses the
same fitting, parent transforms and clipping as images, so a real operation can
stay inside one moving or expanding panel. Keep related beats inside one scene
when the same element should continue across them. A normal `footage` scene is
still available for a standalone clip.

**Saved screens.** A take recorded with `make --states` also keeps the
interface itself at every settled moment: `<take>.take/states/s<N>/` holds
`state.html` (the page, re-renderable offline), `index.json` (what was on
screen: each visible element's `id`, `role`, `name`, `text` and `box` —
`[x, y, width, height]` in page CSS px — plus `layers`, the page's major regions
back to front, `step`, the action it follows, and `fidelity`) and `live.png`
(the recording at that moment). A `state` layer shows one as live DOM, laid out
at its captured viewport: text and vectors stay sharp at any zoom, where a
recording softens past its capture resolution, and every element is
addressable. `only: ["e42"]` keeps just those elements — the rest of the page,
its background included, turns transparent — so a button, a card or a panel
can leave its page; `hide` removes elements without moving anything around
them; `crop` selects a region in page CSS px before fitting, like an image
crop. Find ids by role, name and text in index.json, and take crops from their
boxes. To sit an element exactly over its place in a full-page layer P (contain
scale `s = min(P.width / viewport.w, P.height / viewport.h)`), give it
`crop` = its box, `width`/`height` = the box × s, and centre it at
`P.x + (x + w/2 − viewport.w/2) × s`, `P.y + (y + h/2 − viewport.h/2) × s`.
A saved screen is a still: the recording carries what happens (typing,
clicking, scrolling), the state what is there — for a hold, a close look, a
region lifted out, a layout taken apart. When a state did not re-render like
the recording (`fidelity.ok` false) the checker warns: compare it with
live.png, or show the recording instead. A moment the page was still moving
at (a video playing, a long animation) is not saved at all — `open-take
states` names it MOVING — because there is no still of it to show, and
reading one would stall the app mid-recording; show it with the recording. Saved screens need a film made only
of motion scenes (the HTML renderer, below).

Rectangles, images, videos and states accept a static `shadow` object with `color`,
`blur` (0–256), and optional `offsetX`/`offsetY` (−512 to 512, default zero), all
in design pixels. Shadow follows the layer's transform; shadow-specific tracks
are not supported. Use it sparingly to distinguish lifted content from its surface.

## Animation and user preferences

Each track has a `property` and `keyframes: [{atS, value, easing?}]`. One track per
property; the first time must be 0; later times strictly increase within the
scene duration. A delayed entrance uses repeated values before the change.
Values hold after the last keyframe. Easing belongs to the **destination**
keyframe: `linear` (default), `ease-in`, `ease-out`, `ease-in-out`, `step`, or a
named curve. `step` holds the previous value until the destination timestamp.

The named curves carry a meaning (measured frame by frame off a reference launch
film): **`snap`** — something arriving (most of the travel early, then a long
settle); **`swift`** — an object moving; **`glide`** — a camera or a hand moving
(symmetric, never overshoots); **`spring`** — something landing (a small
overshoot, settled by the keyframe); **`back`** — a small pop past the target
(handles, checkboxes). Leave with `ease-in`: exits accelerate away rather than
decelerate. Pick the curve by what the motion *is*, not per film.

A few habits separate a designed film from a slideshow; `launch check` points
at them as advice, never errors. The camera rarely rests — over a reading hold
let the framing creep (a linear push of a few percent) rather than freeze. Vary
camera moves; the same move repeated reads as a template. Let copy leave with a
move, not a fade. Start the next move before the last one has fully settled,
and move the camera a few frames before the action it frames.

**Depth.** Any layer takes `rotateX`, `rotateY` (degrees) and `z` (design px,
negative = away), animatable like the other transforms, seen through the
scene's `perspective` (design px, default 2800 — the measured reference). A
recorded window that waits tilted beside the copy and swings to face the viewer
as the camera pushes in is the typical use; keep tilts modest (10–30°). Layers
still stack in paint order — a tilted plane is drawn over what came before it.
3D needs a film made only of motion scenes (it renders through the HTML
renderer, below); the checker says so otherwise.

**Chapter changes.** Most changes need no effect at all: cut onto the next
action, or let a camera move carried by the product's own interface take the
viewer there. A `wipe` layer is a plain cover — a straight edge sweeps across
in `color`, holds, then clears; switch what is underneath while it is covered
(between `atS + durationS` and `atS + durationS + holdS`). Keep it for a real
turn in the story, and put it last so it paints over everything.

**Beats that land.** A scene's `hits: [{"atS": 30.15, "strength": 0.6, "flash":
0.5}]` shakes the whole frame briefly and optionally flashes it white — for the
payoff, the reveal, the logo landing. A hit on everything is a hit on nothing.

**Design from this product, not a template.** Every tool here — depth,
wipes, hits, word moves — is optional and earns its place only by what it
shows. Don't add an effect because it is available, don't reuse one film's
set pieces in the next, and don't imitate another film's look: two launch
films should not feel like the same template with different screenshots. The
distinctive moments come from the product's own material — its interface, its
recorded actions, its words — framed for this story. What the program keeps
constant is the craft you should not have to think about: curves, motion blur,
a camera that never quite rests, readable holds, sound in sync.

**Renderer.** A film made only of motion scenes renders through the HTML
renderer (Chrome drawing the layers as DOM, several pages in parallel); films
with other scene types use the 2D renderer. Both read the same JSON and the
same curves; depth and saved screens need the HTML renderer.

Final renders apply a film-style motion blur automatically (a 180° shutter;
drafts skip it): a still frame renders once, a fast move is sampled finely
enough to smear instead of strobe. `output.motionBlur: false` turns it off;
`{"samples": 2–16, "shutter": 0–1}` caps the samples per frame and sets the
shutter. Recorded footage itself is never smeared.

Animate shared transforms or kind-specific fields: size, rect/image/video or
clipped-group `radius`, paint `fill`/`stroke`, `strokeWidth`, text
`fontSize`/`reveal`, line `end` (0–1).
Unsupported property/kind combinations are errors. Colors use supported theme
color syntax (hex and RGB/RGBA) and interpolate RGBA. The end of a line reveals
the path; it does not change the data represented by that path.

Author static base properties as the useful resting layout. `motion: "off"`
ignores tracks and uses those base values, including text reveal. It also
disables scene entrances/exits. Real video playback continues, as it does in a
footage scene; motion-off disables decorative motion, not the recorded operation.
`cut` removes a transition while keeping layer
animation enabled. Omitting `audio` produces silent output; the soundtrack of a
source video is not automatically included. Do not add effects the user excluded.

At most 256 layers per scene, group depth 8, and 128 keyframes per track are
accepted; at most eight video layers are allowed in one scene. Avoid unnecessary layers;
legibility and purpose matter more than
showing every animation property. There is no prescribed film length.

## Verify and revise

For an operation that changes another part of the page, keep the control and its
target understandable together. If a full-frame zoom leaves only clipped text or
empty canvas, use a wider view or a synchronized detail inset alongside the
complete workspace. An inset can reuse the actual video under a clipped group;
the source time and cursor transform must match the main view, and its scale must
respect the source pixel density. Before the inset enters, its target and logical
container must already be fully rendered, expanded and stable in the source.
Delay the inset or trim its source rather than briefly exposing a cropped or old
state and then jumping to the intended one. Show the field/menu long enough to
read, then return attention to the changed result. This is an optional framing
choice, not an extra effect to add when the user's selected mode excludes it.

Every editorial connector needs an identifiable source, target and explanatory
purpose. For a connector between copy and a product view, keep it in the gap and
stop at the view's edge; do not let a decorative elbow enter the screenshot or
cross its embedded text. If the relationship is already clear from the layout,
omit the line. Review connectors during movement as well as at rest. Structural
checks cannot identify text or meaningful objects inside raster images/video,
so a valid path and a sharp frame do not establish that a line is well placed.

1. Run `open-take launch check <file>` before rendering. Fix precise property and
   asset errors; do not silently replace missing UI with an invented mockup.
2. Render a draft, inspect entrances, midpoints, the resting composition and
   scene boundaries. Check text/crop/clipping at the intended viewing size.
   Inspect the complete sequence for object continuity, readable holds, useful
   state changes and static tails. For every critical action or animation,
   compare dense consecutive frames from the raw source and rendered output,
   and watch both at normal speed. Confirm source readiness, reveal order,
   cursor arrival and the reading hold. Sampled stills alone do not establish
   motion quality, and fps metadata does not prove observed smoothness: a 60 fps
   file can repeat or hold source frames. State the limitation if that is all
   you inspected.
3. Apply follow-up edits to JSON. Preserve the user's mode, audio and feature
   choices unless the new request changes them. Re-render the affected draft.
4. Check the master at its actual output size, including text embedded in images
   and video. Repeat the dense raw-versus-rendered frame and normal-speed checks
   for every critical action window in the final master. Prefer the original
   capture and native screenshots; avoid feeding a draft or repeatedly encoded
   export into another render. Choose source density per shot: close detail
   may need scale 2, while a full-view animation can use scale 1 when it supplies
   every displayed pixel and improves observed cadence. Measure both clarity
   and motion; more source pixels do not compensate for missing motion frames.
   A larger output resolution does not restore missing source pixels. Act on
   asset-enlargement warnings by recapturing, changing the
   crop or reducing its display size. Low file bitrate alone is not proof of
   poor encoding: static scenes can compress efficiently at a high quality setting.
5. Deliver the master and portable editable JSON/assets, explaining any material
   illustrative content or unavailable effects. Do not claim automatic arbitrary
   DOM decomposition, 3D, generative media or a launch-layer GUI editor.

Passing technical checks establishes that a composition can render. It does not
certify launch-film quality. A stronger draft makes a clear object or result
carry the story through several states, with coordinated parent/child timing,
purposeful reframing and brief holds. Adding independent fades to a static slide
does not demonstrate that capability.

Typing used as a hero action should normally reveal progressively and retain a
readable completed hold. Use an instantaneous reveal only for an explicitly
paste-like operation whose editorial meaning matches that behavior. Budget
cursor travel from distance and the available gap, leaving time for arrival and
reading before the click; shortening opening copy is preferable to making its
entrance or the entire film uniformly faster.

Existing `ui-morph` scenes are supported for compatibility. New compositions
should use the general layer vocabulary when its structure fits the story.
