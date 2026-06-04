# @open-take/editor

A web editor for open-take's **cinematic layer** — a live, WYSIWYG preview of a
`TakeComposition` drawn in the browser over the capture video, the same way
revideo will export it. Modelled on a dual-mode inspector, scoped to
`composition.json` only. **It never touches the captured video** (that's frozen
at capture time); it refines zoom / cursor / framing / pacing.

> **Status: milestone 2a — editable property panel + one-click export.** You can
> now edit the cinematic layer (framing / cursor feel / per-beat zoom / start /
> duration) live, validate-gated, and Export a re-render. On-frame drag (2b) and
> cut/trim/speed-remap (2c) are next (see Roadmap). Aesthetic = "Linear bones +
> amber": Linear's structure (layered near-black surfaces, hairline borders,
> Inter, dense 4px, snappy motion, ⌘K) with amber reserved for live/active only.

## Run

**With the integrated export bridge** (edit a real take + one-click render):

```bash
pnpm build                                       # build editor + runtime + cli once
node packages/cli/dist/cli.js edit <take.mp4>    # or: open-take edit <take dir>
```

This launches a local server on `127.0.0.1` that serves the editor and the take's
files, auto-loads the take, and wires **Save** (persist `composition.json`) +
**Export** (re-render over the kept capture, with live progress). Nothing leaves
your machine.

**Standalone (UI dev / no render):**

```bash
pnpm --filter @open-take/editor dev      # http://localhost:5173
```

Click **Load sample** for the bundled docs-demo take, or **Open…** / drag-drop a
`composition.json` together with its `*.capture.mp4` (+ optional `*.capture.json`
for the full capture-lock gate). Loading is pure browser File API. Without the
bridge, **Export** degrades to downloading the edited `composition.json` (run
`open-take render` to produce the mp4). Press **⌘K** for the command palette.

## What it does

- **Faithful canvas preview.** The cinematic transform (zoom scale/center,
  framing, cursor, ripples) is drawn to a `<canvas>` over the playing capture.
- **Scrubbable timeline** with beat markers and the **zoom-scale curve plotted
  as an area** — you can see the cinematic motion (ramps, holds, settles) at a
  glance. Drag to scrub; click a beat flag to jump to it.
- **Transport**: play/pause, frame-step, restart, loop, live timecode.
- **Inspector**: the framed beat's fields (zoom scale/center/inAt, timing) +
  the whole composition + a live `validateComposition()` verdict (the Save gate,
  visible from day one). Capture-locked fields are marked.

## How it stays faithful to the export (the key design choice)

The preview imports the compositor's transform math **directly from source**
(`@compositor` alias → `packages/compositor/src/math.ts`) — it is *not* a copy.
So the browser preview and the revideo renderer run the exact same
geometry/timing code; only the cosmetic draw layer (canvas 2D vs revideo JSX) is
reimplemented (`src/engine/preview.ts`, mirroring `scene.tsx`). That single
cosmetic surface is verified: see `out/web-preview-spike/verify-editor.mjs`,
which drives this running app, screenshots the canvas at sampled times, and
diffs against the revideo export (PSNR 34–38 dB through an upscale = faithful;
the lavender backdrop and zoom geometry match the export).

**Colour:** new captures are encoded `tv`/bt709, so a raw `drawImage(video)`
canvas is colour-faithful. Captures made before that fix are full-range and will
wash out in the preview — re-make them.

## Verification status (honest ledger)

Verified (headless CfT against the running app — scripts in `out/web-preview-spike/`):

- **Static fidelity** vs the revideo export (`verify-editor.mjs`): PSNR 34–38 dB at
  t=2.4/5/6/8.4/11.8 *through* a display-size→1080p upscale (true fidelity higher).
  Side-by-sides `appcmp-*.png`; lavender/zoom/cursor match.
- **Playback** actually advances under `play()` and draws distinct frames
  (`verify-dynamic.mjs`).
- **Tail clock** (the custom bit): time climbs past the video end (15.77 s) to
  `stage.T` (16.94 s) and stops; the tail frame at t=16.4 matches the export at
  36 dB. (No static sample had ever exceeded the video duration — this was the
  biggest untested path.)
- **Loop** wraps to start and keeps playing.
- **Coalesced rapid scrub** settles on the last target (4 seeks → lands on 5.000 s).
- **File-picker loader** (`loadFiles`) loads composition+video → ready, 0 errors.
- **Overlay** renders (`overlay-isolated.png`: amber bbox/crosshair/dot).
- typecheck 11/11 (no monorepo regression); `vite build` green.

NOT yet verified / known limitations:

- **Perceptual playback "feel"** — headless confirms time advances and frames
  draw, but the *silk* (no judder, cursor/zoom easing) needs a human eye in a
  real browser (per the feel-tuning workflow). Open it and watch.
- **Drag-and-drop** event wiring isn't separately tested — it calls the same
  `loadFiles` as the (tested) picker, but the DnD `onDrop` path itself wasn't
  driven headlessly.
- **Overlay is low-contrast** (thin amber on a light frame) — fine as a preview
  affordance, wants more contrast when it becomes the drag layer in milestone 2.
- **Old full-range captures** wash out (documented caveat; not re-demonstrated).
- In dev, React StrictMode double-mounts the engine (reasoned safe; the live
  instance wins and it's gone in the prod build) — not rigorously stress-tested.

## Architecture

```
src/
  engine/preview.ts     PreviewEngine — canvas + <video>, the faithful draw,
                        video-as-clock playback + own-clock zoom-out tail + seek
  lib/compositor.ts     single bridge to the compositor SOURCE (math/types/validate)
  lib/edit.ts           pure structural-sharing setters for the editable comp
  lib/derive.ts         memoised stage/legs/scale-curve derivations (pure)
  lib/bridge.ts         client for the local edit-server (take / save / render SSE)
  lib/format.ts         timecode formatting
  hooks/useComposition  owns the editable comp + undo/validate/gate; pushes to engine
  hooks/usePreview      owns the engine, video loading, transport, playback beat
  hooks/useBridge       auto-load + Save / Export / Download
  components/           Viewer · Transport · Timeline · Inspector · CommandPalette
  components/controls/  NumberScrubber · Slider · Toggle · ColorSwatch · Vec2 · Row
```

The engine is framework-agnostic and imperative (owns the canvas + the rAF clock).
**React owns the composition** (`useComposition`) and pushes each immutable edit to
the engine via `setComposition`, which redraws on the same tick — so the canvas
updates live, independent of React render. 60fps updates (playhead, timecode) are
isolated to leaf components via `useEngineTime`. The Node-only revideo render runs
behind the **edit-server** bridge (`packages/runtime/src/edit-server.ts`), reached
by `open-take edit`.

## Roadmap

1. ~~**Property panel** bound to the editable fields → `validateComposition` on
   Save → re-render-to-export.~~ **Done (2a)** — plus the amber-Linear restyle, a
   ⌘K palette, and the integrated one-click export bridge.
2. **On-frame drag** for the zoom box / center / start point (the overlay layer
   already outlines these).
3. **Cut / trim / speed-remap** — the retime layer (re-time `tMs` + re-encode the
   video + remap the capture log; extends the capture-lock model).
4. **Comment → AI** for coarse/choreography edits (routes to talk-to-refine).

Editable vs capture-locked boundary is the one in `skills/open-take/SKILL.md`
(REFINE): cinematic params are free; what's clicked/typed/dragged, beat order,
and action `tMs` need a re-make.
