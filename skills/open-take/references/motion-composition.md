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
| `text` | `text`, `width`, `height`, `fontSize` | `fontFamily`, `fontWeight`, `fill`, `align`, `lineHeight`, `reveal` |
| `image` | `asset`, `width`, `height` | `fit`, `radius`, `crop`, `shadow` |
| `video` | `asset`, `width`, `height`, `durationS` | `fit`, `radius`, `trimStartS`, `startS`, `shadow` |
| `line` | `points` (array of `[x,y]`) | `stroke`, `strokeWidth`, `end` |

Text wraps in a bounded box. `align` is `left`, `center` (default), or `right`;
`lineHeight` is in design pixels. `reveal` runs 0–1 over grapheme clusters (so an
emoji or combining character is not cut into code units). Leave enough height
for all lines and inspect the rendered font; estimated validation cannot know
every installed font. Defaults inherit theme `ink`, `surface`, and `accent`.

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

Rectangles, images and videos accept a static `shadow` object with `color`,
`blur` (0–256), and optional `offsetX`/`offsetY` (−512 to 512, default zero), all
in design pixels. Shadow follows the layer's transform; shadow-specific tracks
are not supported. Use it sparingly to distinguish lifted content from its surface.

## Animation and user preferences

Each track has a `property` and `keyframes: [{atS, value, easing?}]`. One track per
property; the first time must be 0; later times strictly increase within the
scene duration. A delayed entrance uses repeated values before the change.
Values hold after the last keyframe. Easing belongs to the **destination**
keyframe: `linear` (default), `ease-in`, `ease-out`, `ease-in-out`, or `step`.
`step` holds the previous value until the destination timestamp.

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
