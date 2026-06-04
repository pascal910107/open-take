type Props = {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
};

// A styled switch on a native checkbox (accessible, keyboard-operable). Amber
// only when on (live/active = amber discipline).
export function Toggle({ checked, onChange, disabled, label }: Props) {
  return (
    <label className="switch" data-on={checked} data-disabled={disabled || undefined}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch__track">
        <span className="switch__thumb" />
      </span>
      {label && <span className="switch__label">{label}</span>}
    </label>
  );
}
