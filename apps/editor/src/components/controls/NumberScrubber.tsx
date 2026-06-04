import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  value: number;
  onChange: (v: number) => void;
  /** called once when a drag/edit gesture begins (for undo coalescing keys). */
  onCommitStart?: () => void;
  min?: number;
  max?: number;
  /** value change per pixel dragged (and the type-in rounding granularity). */
  step?: number;
  /** decimals shown / parsed. Default derived from step. */
  precision?: number;
  unit?: string;
  disabled?: boolean;
  title?: string;
};

// A drag-to-scrub numeric field (DaVinci/Linear style): drag left/right on the
// value to change it, or click to type. The hot path (a drag) is rAF-coalesced
// so it emits at most one onChange per frame regardless of pointer rate — the
// engine redraw then stays at 60fps even on a fast drag.
export function NumberScrubber({
  value,
  onChange,
  onCommitStart,
  min,
  max,
  step = 1,
  precision,
  unit,
  disabled,
  title,
}: Props) {
  const prec =
    precision ??
    (Number.isInteger(step) ? 0 : Math.min(4, String(step).split(".")[1]?.length ?? 2));
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const drag = useRef<{ startX: number; startVal: number } | null>(null);
  const moved = useRef(false);
  const pending = useRef<number | null>(null);
  const raf = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const clamp = useCallback(
    (v: number) => {
      if (min != null) v = Math.max(min, v);
      if (max != null) v = Math.min(max, v);
      return v;
    },
    [min, max],
  );

  const flush = useCallback(() => {
    raf.current = 0;
    if (pending.current == null) return;
    onChange(pending.current);
    pending.current = null;
  }, [onChange]);

  const emit = useCallback(
    (v: number) => {
      pending.current = clamp(v);
      if (!raf.current) raf.current = requestAnimationFrame(flush);
    },
    [clamp, flush],
  );

  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    },
    [],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled || editing) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startVal: value };
    moved.current = false;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.startX;
    if (!moved.current && Math.abs(dx) > 3) {
      moved.current = true;
      onCommitStart?.();
    }
    if (!moved.current) return;
    const fine = e.shiftKey ? 0.25 : 1;
    const raw = drag.current.startVal + dx * step * fine;
    const snapped = Math.round(raw / step) * step;
    emit(Number(snapped.toFixed(prec)));
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (raf.current) {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
      flush();
    }
  };

  const startEdit = () => {
    if (disabled) return;
    onCommitStart?.();
    setText(value.toFixed(prec));
    setEditing(true);
    queueMicrotask(() => inputRef.current?.select());
  };
  const commitEdit = () => {
    setEditing(false);
    const n = Number.parseFloat(text);
    if (Number.isFinite(n)) onChange(clamp(Number(n.toFixed(prec))));
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="scrubber scrubber--edit"
        type="text"
        inputMode="decimal"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitEdit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitEdit();
          else if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="scrubber"
      data-disabled={disabled || undefined}
      title={title ?? "Drag to change · click to type"}
      disabled={disabled}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={() => {
        if (!moved.current) startEdit();
      }}
    >
      <span className="scrubber__val">{value.toFixed(prec)}</span>
      {unit && <span className="scrubber__unit">{unit}</span>}
    </button>
  );
}
