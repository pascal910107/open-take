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

## Layout (reference-app structure, our skin)

- **Stage** (`components/Stage.tsx`) — engine canvas; selecting a zoom block
  enters INSPECT mode (wide rest-framed still) with a draggable/resizable
  zoom-region box (drag = `zoom.center`, corner = `zoom.scale`, aspect locked
  to the output). Also handles "Set cursor start" picking.
- **Icon rail + panels** (`components/Rail.tsx`, `components/panels.tsx`) —
  seven layered panes: Zoom · Background (Look thumbnails + custom) · Frame ·
  Cursor · Motion (pace cards, blur, fine-tune durations) · Clip · Agent (notes →
  `<base>.notes.md` + a NOTE line on the edit-server stdout).
- **Timeline** (`components/Timeline.tsx`) — transport, ruler, client-side
  filmstrip thumbnails, iris zoom blocks (dashed ghosts enable a zoom on a
  beat), synced playhead.
- **Top bar** — undo/redo, Compare (hold: engine shows the session origin —
  the take as this editor loaded it), Export.

State: `hooks/useComposition` (draft + undo/redo + continuous validation),
`hooks/usePreview` (engine + transport), `hooks/useBridge` (bridge detection +
export). Edits go through the pure setters in `lib/edit.ts`. The App autosaves
over the bridge (debounced, validity-gated) and polls `/api/take/mtime` to
hot-reload agent edits. Saves and exports carry the last mtime the editor saw;
the server refuses an overwrite with 409 if the agent changed the file first.
Clean drafts adopt outside changes automatically, while dirty drafts pause
autosave and ask the user to **Keep mine** or **Take theirs**.

UI copy is English-only and deliberately has no i18n layer: the editor is one
of two doors, and the other one — the agent conversation — already speaks the
user's language. Labels match the `composition.json` field they write (Depth →
`zoom.scale`, Glide → `zoom.glide`, Pace → the `MOTION` presets) so the GUI,
the CLI and the skill share one vocabulary.
