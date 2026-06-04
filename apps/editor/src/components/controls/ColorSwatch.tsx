import { useState } from "react";

type Props = {
  value: string;
  onChange: (v: string) => void;
  onCommitStart?: () => void;
  /** allow rgba()/alpha via the text field (e.g. shadow color). */
  allowAlpha?: boolean;
  disabled?: boolean;
};

const hex7 = (v: string) => (/^#[0-9a-f]{6}/i.test(v) ? v.slice(0, 7) : "#000000");

// Swatch button → popover with a native color picker + a raw text field. The
// picker handles hex; the text field handles rgba() (shadow color). No dep.
export function ColorSwatch({ value, onChange, onCommitStart, allowAlpha, disabled }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <span className="swatch-wrap">
      <button
        type="button"
        className="swatch"
        disabled={disabled}
        style={{ background: value }}
        title={value}
        onClick={() => !disabled && setOpen((o) => !o)}
      />
      {open && (
        <>
          <span className="swatch-pop__scrim" onPointerDown={() => setOpen(false)} />
          <span className="swatch-pop" onPointerDown={(e) => e.stopPropagation()}>
            <input
              type="color"
              value={hex7(value)}
              onPointerDown={() => onCommitStart?.()}
              onChange={(e) => onChange(e.target.value)}
            />
            <input
              className="swatch-pop__hex"
              type="text"
              value={value}
              spellCheck={false}
              onFocus={() => onCommitStart?.()}
              onChange={(e) => onChange(e.target.value)}
              placeholder={allowAlpha ? "rgba(0,0,0,.5)" : "#000000"}
            />
          </span>
        </>
      )}
    </span>
  );
}
