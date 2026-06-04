import { Command } from "cmdk";
import type { PreviewEngine } from "../engine/preview";
import type { useBridge } from "../hooks/useBridge";
import type { UseComposition } from "../hooks/useComposition";
import type { UsePreview } from "../hooks/usePreview";
import { beatTitle } from "../lib/derive";

type Props = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  engine: PreviewEngine | null;
  c: UseComposition;
  b: ReturnType<typeof useBridge>;
  p: UsePreview;
  ready: boolean;
  onOpenFiles: () => void;
};

// ⌘K palette — fuzzy access to every editor action, wrapping the existing
// engine/hook methods. cmdk handles filtering + keyboard nav; the dialog opens
// on ⌘K (wired in App).
export function CommandPalette({ open, onOpenChange, engine, c, b, p, ready, onOpenFiles }: Props) {
  const run = (fn: () => void) => {
    fn();
    onOpenChange(false);
  };
  const fps = c.comp?.output.fps ?? 60;
  const step = (dir: number) => engine?.seek(engine.currentTime + dir / fps);

  return (
    <Command.Dialog className="cmdk" open={open} onOpenChange={onOpenChange} label="Command menu">
      <Command.Input placeholder="Search commands…" />
      <Command.List>
        <Command.Empty>No matching command.</Command.Empty>

        {ready && engine && (
          <Command.Group heading="Playback">
            <Command.Item onSelect={() => run(() => engine.toggle())}>Play / Pause</Command.Item>
            <Command.Item onSelect={() => run(() => engine.restart())}>Restart</Command.Item>
            <Command.Item onSelect={() => run(() => step(1))}>Step forward 1 frame</Command.Item>
            <Command.Item onSelect={() => run(() => step(-1))}>Step back 1 frame</Command.Item>
            <Command.Item onSelect={() => run(() => engine.setLoop(!engine.loop))}>
              Toggle loop
            </Command.Item>
          </Command.Group>
        )}

        {ready && engine && c.comp && (
          <Command.Group heading="Go to beat">
            {c.comp.events.map((e, i) => (
              <Command.Item
                key={i}
                value={`beat ${i} ${beatTitle(e)}`}
                onSelect={() =>
                  run(() => {
                    engine.seek(e.tMs / 1000);
                    c.selectBeat(i);
                  })
                }
              >
                {i + 1}. {beatTitle(e)}
              </Command.Item>
            ))}
          </Command.Group>
        )}

        {ready && (
          <Command.Group heading="Edit">
            {c.canUndo && <Command.Item onSelect={() => run(c.undo)}>Undo</Command.Item>}
            {c.canRedo && <Command.Item onSelect={() => run(c.redo)}>Redo</Command.Item>}
            {c.dirty && (
              <Command.Item onSelect={() => run(c.reset)}>Reset to last saved</Command.Item>
            )}
          </Command.Group>
        )}

        <Command.Group heading="Take">
          <Command.Item onSelect={() => run(onOpenFiles)}>Open files…</Command.Item>
          {!b.bridge && <Command.Item onSelect={() => run(p.loadSample)}>Load sample</Command.Item>}
          {ready && b.bridge && (
            <Command.Item onSelect={() => run(() => void b.save())}>Save composition</Command.Item>
          )}
          {ready && b.bridge && (
            <Command.Item disabled={!c.canSave} onSelect={() => run(() => void b.exportNow())}>
              Export (render)
            </Command.Item>
          )}
          {ready && !b.bridge && (
            <Command.Item onSelect={() => run(b.downloadComposition)}>
              Download composition.json
            </Command.Item>
          )}
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}
