import { useState } from "react";
import type { LoadStatus } from "../hooks/usePreview";

type Props = {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  status: LoadStatus;
  onDropFiles: (files: FileList) => void;
};

// The viewer is a reference monitor: the canvas is the hero, framed by corner
// ticks (a nod to camera framing marks) and a soft scrim. The canvas element
// itself is always mounted so the engine can bind to it before any load.
export function Viewer({ canvasRef, videoRef, status, onDropFiles }: Props) {
  const [drag, setDrag] = useState(false);

  return (
    <div
      className="viewer"
      data-dragging={drag}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (e.dataTransfer.files.length) onDropFiles(e.dataTransfer.files);
      }}
    >
      <div className="viewer__stage" data-empty={status !== "ready"}>
        <span className="tick tick--tl" />
        <span className="tick tick--tr" />
        <span className="tick tick--bl" />
        <span className="tick tick--br" />
        <canvas ref={canvasRef} className="viewer__canvas" width={1920} height={1080} />
        {/* hidden source video — drawn onto the canvas, never shown directly */}
        <video
          ref={videoRef}
          muted
          playsInline
          preload="auto"
          crossOrigin="anonymous"
          className="viewer__video"
        />
      </div>
      {drag && <div className="viewer__dropnote">drop composition.json + capture video</div>}
    </div>
  );
}
