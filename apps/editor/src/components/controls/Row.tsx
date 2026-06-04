import type { ReactNode } from "react";

// A labelled control row for the inspector. `locked` shows the capture-lock
// badge (⦂) and is purely advisory — the control itself should be `disabled`.
export function Row({
  label,
  locked,
  hint,
  children,
}: { label: string; locked?: boolean; hint?: string; children: ReactNode }) {
  return (
    <div className="row" title={hint}>
      <span className="row__label">
        {label}
        {locked && (
          <span className="row__lock" title="capture-locked — needs a re-make to change">
            ⦂
          </span>
        )}
      </span>
      <span className="row__control">{children}</span>
    </div>
  );
}

export function Group({
  title,
  children,
  defaultOpen = true,
}: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="group" open={defaultOpen}>
      <summary className="group__head">{title}</summary>
      <div className="group__body">{children}</div>
    </details>
  );
}
