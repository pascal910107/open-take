type Props = {
  value: number;
  onChange: (v: number) => void;
  onCommitStart?: () => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
};

// Native range input, styled to the amber-Linear theme (see styles.css .rng).
// Keyboard-operable for free; a pointer-down marks the gesture start so the drag
// is one undo entry.
export function Slider({
  value,
  onChange,
  onCommitStart,
  min = 0,
  max = 1,
  step = 0.01,
  disabled,
}: Props) {
  return (
    <input
      className="rng"
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onPointerDown={() => onCommitStart?.()}
      onKeyDown={() => onCommitStart?.()}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}
