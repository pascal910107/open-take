# @open-take/editor — the visual editor (v4)

The human door into a take's cinematic layer: preview + icon-rail layered
settings + a timeline with zoom blocks, over the live pixel-faithful
`PreviewEngine` (compositor math imported from source via the `@compositor`
Vite alias — never forked). It refines `composition.json`; it never touches
the captured video.

## Run

- **Integrated (the real workflow):** `pnpm build`, then
  `npx open-take edit <take.mp4 | dir>` — a local bridge server
  (`packages/runtime/src/edit-server.ts`) serves this app's dist + the take,
  auto-opens the browser. **Edits autosave** (no Save button); Export renders
  the real mp4 with live progress.
- **UI dev:** `pnpm --filter @open-take/editor dev` — sample/drop mode, no
  rendering.

## Layout (reference recorder structure, our skin)

- **Stage** (`components/Stage.tsx`) — engine canvas; selecting a zoom block
  enters INSPECT mode (wide rest-framed still) with a draggable/resizable
  zoom-region box (drag = `zoom.center`, corner = `zoom.scale`, aspect locked
  to the output). Also handles 設定游標起點 picking.
- **Icon rail + panels** (`components/Rail.tsx`, `components/panels.tsx`) —
  seven layered panes: Zoom · Background (Look thumbnails + custom) · Frame ·
  Cursor · Motion (pace cards, blur, 微調時長) · Clip · Agent (notes →
  `<base>.notes.md` + a NOTE line on the edit-server stdout).
- **Timeline** (`components/Timeline.tsx`) — transport, ruler, client-side
  filmstrip thumbnails, iris zoom blocks (dashed ghosts enable a zoom on a
  beat), synced playhead.
- **Top bar** — undo/redo, 對比原版 (hold: engine shows the last-saved
  baseline), Export.

State: `hooks/useComposition` (draft + undo/redo + continuous validation),
`hooks/usePreview` (engine + transport), `hooks/useBridge` (bridge detection +
export). Edits go through the pure setters in `lib/edit.ts`. The App autosaves
over the bridge (debounced, validity-gated) and polls `/api/take/mtime` to
hot-reload agent edits (own writes are absorbed; a change arriving while dirty
stays pending — last-writer-wins is a known limit, see .notes/HANDOFF.md).
