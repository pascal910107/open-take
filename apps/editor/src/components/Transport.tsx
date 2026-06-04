import { useState } from "react";
import type { PreviewEngine } from "../engine/preview";
import { useEngineTime } from "../hooks/usePreview";
import type { Derived } from "../lib/derive";
import { tcFrame } from "../lib/format";

type Props = {
  engine: PreviewEngine;
  derived: Derived;
  isPlaying: boolean;
};

// Live timecode — isolated leaf so only this re-renders at 60fps.
function Timecode({ engine, derived }: { engine: PreviewEngine; derived: Derived }) {
  const t = useEngineTime(engine);
  const fps = derived.comp.output.fps;
  return (
    <div className="timecode">
      <span className="timecode__now">{tcFrame(t, fps)}</span>
      <span className="timecode__sep">/</span>
      <span className="timecode__total">{tcFrame(derived.T, fps)}</span>
    </div>
  );
}

export function Transport({ engine, derived, isPlaying }: Props) {
  const [loop, setLoop] = useState(false);
  const fps = derived.comp.output.fps;
  const frameStep = (dir: number) => engine.seek(engine.currentTime + dir / fps);

  return (
    <div className="transport">
      <div className="transport__cluster">
        <button type="button" className="ctl" title="Restart" onClick={() => engine.restart()}>
          <Icon name="restart" />
        </button>
        <button
          type="button"
          className="ctl"
          title="Step back one frame"
          onClick={() => frameStep(-1)}
        >
          <Icon name="prev" />
        </button>
        <button
          type="button"
          className="ctl ctl--play"
          title={isPlaying ? "Pause" : "Play"}
          onClick={() => engine.toggle()}
        >
          <Icon name={isPlaying ? "pause" : "play"} />
        </button>
        <button
          type="button"
          className="ctl"
          title="Step forward one frame"
          onClick={() => frameStep(1)}
        >
          <Icon name="next" />
        </button>
        <button
          type="button"
          className="ctl"
          data-active={loop}
          title="Loop"
          onClick={() => {
            const v = !loop;
            setLoop(v);
            engine.setLoop(v);
          }}
        >
          <Icon name="loop" />
        </button>
      </div>

      <Timecode engine={engine} derived={derived} />
    </div>
  );
}

function Icon({ name }: { name: string }) {
  const p = (() => {
    switch (name) {
      case "play":
        return <path d="M5 3.5v13l11-6.5z" />;
      case "pause":
        return (
          <>
            <rect x="4.5" y="3.5" width="4" height="13" rx="1" />
            <rect x="11.5" y="3.5" width="4" height="13" rx="1" />
          </>
        );
      case "restart":
        return (
          <path
            d="M10 4a6 6 0 1 1-5.7 4.1M4.2 8.1 3 3.6m1.2 4.5 4.4-1.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        );
      case "prev":
        return (
          <>
            <path d="M14 4.5v11L7 10z" />
            <rect x="4.5" y="4.5" width="2" height="11" rx="1" />
          </>
        );
      case "next":
        return (
          <>
            <path d="M6 4.5v11L13 10z" />
            <rect x="13.5" y="4.5" width="2" height="11" rx="1" />
          </>
        );
      case "loop":
        return (
          <path
            d="M5 7h7a3 3 0 0 1 0 6H8m-3-6 2.2-2.2M5 7l2.2 2.2M15 13H8a3 3 0 0 1 0-6h4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        );
      default:
        return null;
    }
  })();
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden>
      {p}
    </svg>
  );
}
