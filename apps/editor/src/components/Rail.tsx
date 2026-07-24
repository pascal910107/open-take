// The icon rail — the reference navigation move: one icon per settings
// category; clicking opens that category's panel. Icons over text walls.
import type { JSX } from "react";
import { IcAgent, IcBg, IcClip, IcCursor, IcFrame, IcMotion, IcZoom } from "../ui/icons";

export type PaneKey = "zoom" | "bg" | "frame" | "cursor" | "motion" | "clip" | "agent";

const ITEMS: { key: PaneKey; label: string; icon: () => JSX.Element }[] = [
  { key: "zoom", label: "Zoom", icon: () => <IcZoom /> },
  { key: "bg", label: "Background", icon: () => <IcBg /> },
  { key: "frame", label: "Frame", icon: () => <IcFrame /> },
  { key: "cursor", label: "Cursor", icon: () => <IcCursor /> },
  { key: "motion", label: "Motion", icon: () => <IcMotion /> },
  { key: "clip", label: "Clip", icon: () => <IcClip /> },
  { key: "agent", label: "Agent", icon: () => <IcAgent /> },
];

export function Rail({ active, onSelect }: { active: PaneKey; onSelect: (k: PaneKey) => void }) {
  return (
    <nav className="rail">
      {ITEMS.map((it) => (
        <button
          type="button"
          key={it.key}
          className={active === it.key ? "on" : ""}
          onClick={() => onSelect(it.key)}
          aria-label={it.label}
        >
          {it.icon()}
          <span className="tip">{it.label}</span>
        </button>
      ))}
    </nav>
  );
}
