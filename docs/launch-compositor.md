# Launch compositions

Open Take has two compatible rendering paths. A **take** keeps a real recording and adds
the synthetic cursor and camera polish. A **launch composition** arranges real footage,
typography, composable animated layers, transitions, and optional local audio on one editable
timeline. Launch scenes never replace recorded product behavior: `footage` scenes always
point to real video assets.

```sh
open-take launch init launch-film --video demos/product.mp4
open-take launch check launch-film/launch.json
open-take launch render launch-film/launch.json
open-take launch render launch-film/launch.json --draft
```

`init` creates a portable directory and copies the video into `assets/`. It refuses to
overwrite an existing directory. Paths in `launch.json` resolve from the JSON's directory,
including paths containing spaces. A normal render defaults to `launch.mp4`; a draft defaults
to `launch.draft.mp4` and scales the authored dimensions down while preserving aspect ratio.
Neither command rewrites the authored JSON. The initializer uses a neutral
title/footage/end structure with static cards, cut transitions, the full supplied
clip, and no audio. Replace its placeholder copy and freely change or remove scenes.

The ordered `scenes` array accepts `title`, `footage`, `motion`, `ui-morph`, and `end-card`. Scene slots
do not overlap: their lengths add to the film length. A `cut`, `fade`, or `slide` transition
is an entrance/exit effect inside its scene's slot and never shortens the film. Scenes can be
added, removed, or reordered freely.

For a protected first draft, use `open-take launch compose brief.json --out launch.json`.
The brief keeps the same version/output/theme/audio/story structure; its scenes may
mix regular scenes with `focus`, `compare` and `steps` recipes. Code determines
spacing, typography, aspect-dependent layout and default duration from content.
The generated JSON contains normal editable layers. Assets resolve from the
brief's directory and are rebased to the output directory. The output path must
be new; compose refuses to overwrite existing edits.

Recipes optionally select an `editorial`, `product` or `technical` style;
omitting the field preserves the original treatment. Styles change bounded
geometry, hierarchy and motion rather than assigning one template per website
category. They preserve the supplied theme and user motion choice.

An optional root `story` records intent, audience, takeaway and scene-local
beats, with references to recorded or screenshot evidence. Both compose and
check validate those references and report story omissions or rushed windows
as advice. Legacy compositions need no story metadata. See
[directing a launch story](../skills/open-take/references/launch-story.md) for
the schema, limits and review procedure. This metadata is not rendered copy.

`launch check` reports structural/asset errors and heuristic motion quality
warnings. Warnings about small text, known flat-color contrast, resting bounds,
reading time, animation density, or a foreground line entering image/video
bounds are review aids, not an aesthetic score. Connector checks sample stable
visible holds, accounting for transforms, clipping, reveal and paint order;
they identify the target layer and scene-local time. They use authored geometry,
not OCR, pixel alpha or semantic understanding, and may miss brief or densely
animated crossings. Intentional annotations remain valid and require review.
Render delivery also reports the outstanding warnings; rendering successfully
does not certify that the story or visual direction works.
Intentional entrances may start offscreen. General layers remain available for
compositions beyond the protected recipes; see the authoring reference below.

Encoded video timing has frame granularity. Use multiples of `1 / output.fps`
for scene boundaries when exact frame-aligned delivery is required. `init` sets
`output.fps` from the recording so footage keeps every captured frame.

`motion` contains text, local images/crops, real video clips, rectangles, ellipses,
lines and nested groups. A video clip can move inside the same group as surrounding
UI, using an explicit scene start and source span; its sound remains opt-in.
Rectangles/images/videos support static shadows. Clipped groups support rounded
corners, including animated radius. Each layer can animate its
supported properties with keyframes. See the
[authoring reference](../skills/open-take/references/motion-composition.md) for
the complete schema and coordinate/timing rules, or `open-take skill motion`.
The [examples](../examples/motion/README.md) show several different geometries
built from the same vocabulary. PNG/JPEG/WebP are supported; automatic DOM
decomposition, arbitrary executable scenes and a timeline GUI are not.

`ui-morph` is retained for existing compositions; new work should use `motion`
scenes. `ui-morph` timing comes from its states. Every state declares `transitionS`, `typeDelayS`,
`typeS`, and `holdS`; its length is `max(transitionS, typeDelayS + typeS) + holdS`. The scene
and film length update when any of those values changes. `durationS` is optional and acts only
as an assertion when supplied. Each state's icon, label, prompt, panel width, and panel height
are editable. The icon enum is `record`, `style`, `refine`, `camera`, `spark`, or `target`.
Set `motion: "off"` on title or end-card scenes to keep their text fully visible from the
first frame. With a `cut` transition this provides static editorial cards without entrances.

Audio is opt-in. Tracks accept `music`, `narration`, or `sfx`, with gain, trim, duration,
fade-in, and fade-out. Place a track with absolute `atS`, or with `afterSceneId` plus `offsetS`;
the latter means offset from that scene's **end**. Removing its anchor scene is a validation
error. Omitted duration means the remaining film. Only music may set `loop: true`. Source-video
audio is never included implicitly.

A silent launch needs no `audio` field. A pure recording needs no launch JSON at all: use the
existing `open-take make` and `open-take render` workflow for real footage with cursor/zoom.
If the brief requests only a recording with sound, wrap the finished recording in one
`footage` scene and add the requested audio. Titles, UI animation, and transitions remain
optional; using the compositor does not require adding them.

All output dimensions must be even. Footage defaults to `contain`; `cover` is an explicit crop.
Validation runs before Chrome and rejects unsupported types, inconsistent state timing,
missing or wrong-kind media, out-of-range trims, invalid colors and audio windows, and text
that cannot fit its single-line UI region.
