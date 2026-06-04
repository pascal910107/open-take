import { NumberScrubber } from "./NumberScrubber";

type Props = {
  x: number;
  y: number;
  onChangeX: (v: number) => void;
  onChangeY: (v: number) => void;
  onCommitStart?: () => void;
  step?: number;
  min?: number;
  maxX?: number;
  maxY?: number;
  disabled?: boolean;
};

// Two scrubbers for a point (zoom center, cursor start). Values are video-px.
export function Vec2({
  x,
  y,
  onChangeX,
  onChangeY,
  onCommitStart,
  step = 1,
  min,
  maxX,
  maxY,
  disabled,
}: Props) {
  return (
    <span className="vec2">
      <span className="vec2__axis">
        <span className="vec2__k">x</span>
        <NumberScrubber
          value={x}
          onChange={onChangeX}
          onCommitStart={onCommitStart}
          step={step}
          min={min}
          max={maxX}
          disabled={disabled}
        />
      </span>
      <span className="vec2__axis">
        <span className="vec2__k">y</span>
        <NumberScrubber
          value={y}
          onChange={onChangeY}
          onCommitStart={onCommitStart}
          step={step}
          min={min}
          max={maxY}
          disabled={disabled}
        />
      </span>
    </span>
  );
}
