// The v4 control kit: slider with filled track, toggle, icon+label option
// cards, thumbnail grid, mini button, advanced disclosure. All controlled;
// gestures coalesce into one undo entry via onGestureStart.
import { type ReactNode, useId } from "react";

export function Row({
  label,
  children,
  value,
}: {
  label: ReactNode;
  children: ReactNode;
  value?: ReactNode;
}) {
  return (
    <div className="row">
      <span className="rowlabel">{label}</span>
      {children}
      {value != null && <span className="val mono">{value}</span>}
    </div>
  );
}

export function Slider({
  min,
  max,
  step = 1,
  value,
  onChange,
  onGestureStart,
}: {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
  onGestureStart?: () => void;
}) {
  const fill = `${((value - min) / (max - min)) * 100}%`;
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      style={{ "--fill": fill } as React.CSSProperties}
      onPointerDown={onGestureStart}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

export function Toggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      className={`toggle${on ? " on" : ""}`}
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
    >
      <i />
    </button>
  );
}

export function OptionCards<T extends string>({
  options,
  value,
  onChange,
  compact,
}: {
  options: { key: T; label: string; icon?: ReactNode }[];
  value: T | null;
  onChange: (k: T) => void;
  compact?: boolean;
}) {
  return (
    <div className={`opts${compact ? " compact" : ""}`}>
      {options.map((o) => (
        <button
          type="button"
          key={o.key}
          className={`opt${o.key === value ? " on" : ""}`}
          onClick={() => onChange(o.key)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Thumbs({
  items,
  value,
  onChange,
}: {
  items: { key: string; css: string; title?: string }[];
  value: string | null;
  onChange: (k: string) => void;
}) {
  return (
    <div className="thumbs">
      {items.map((t) => (
        <button
          type="button"
          key={t.key}
          title={t.title ?? t.key}
          className={`thumb${t.key === value ? " on" : ""}`}
          style={{ background: t.css }}
          onClick={() => onChange(t.key)}
        />
      ))}
    </div>
  );
}

export function MiniBtn({
  onClick,
  children,
  title,
  disabled,
}: {
  onClick: () => void;
  children: ReactNode;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button type="button" className="minibtn" onClick={onClick} title={title} disabled={disabled}>
      {children}
    </button>
  );
}

export function Adv({ label = "進階", children }: { label?: string; children: ReactNode }) {
  const id = useId();
  return (
    <details className="adv" id={id}>
      <summary>{label}</summary>
      {children}
    </details>
  );
}

export function Card({
  head,
  headRight,
  children,
}: {
  head?: ReactNode;
  headRight?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="card">
      {(head || headRight) && (
        <div className="head">
          <b>{head}</b>
          {headRight}
        </div>
      )}
      {children}
    </div>
  );
}
