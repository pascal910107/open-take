// Timecode + number formatting for the readouts. Kept tiny and dependency-free.

/** seconds -> "SS.cc" (seconds.centiseconds), the editor's primary readout. */
export function tc(seconds: number): string {
  const s = Math.max(0, seconds);
  const whole = Math.floor(s);
  const cs = Math.round((s - whole) * 100);
  // carry when rounding centiseconds ticks to the next second
  const carry = cs === 100 ? 1 : 0;
  const ss = String(whole + carry).padStart(2, "0");
  const cc = String(carry ? 0 : cs).padStart(2, "0");
  return `${ss}.${cc}`;
}

/** seconds + frame index at the given fps, e.g. "02.4s · f72". */
export function tcFrame(seconds: number, fps: number): string {
  return `${tc(seconds)}s · f${Math.round(seconds * fps)}`;
}

export function ms(milliseconds: number): string {
  return `${Math.round(milliseconds)}ms`;
}

export function scaleX(scale: number): string {
  return `${scale.toFixed(2)}×`;
}
