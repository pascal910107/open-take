import { useCallback, useEffect, useRef, useState } from "react";
import { PreviewEngine } from "../engine/preview";
import type { CaptureLog, TakeComposition } from "../lib/compositor";
import { activeBeatIndex } from "../lib/derive";

export type LoadStatus = "empty" | "loading" | "ready" | "error";

export type SourceMeta = { name: string; kind: "sample" | "files" | "bridge" };

export type SeedFn = (comp: TakeComposition, captureLog?: CaptureLog | null) => void;

export type UsePreview = {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  engine: PreviewEngine | null;
  status: LoadStatus;
  error: string | null;
  /** the loaded capture video URL (bridge/sample/object URL) — for thumbnails */
  videoSrc: string | null;
  source: SourceMeta | null;
  isPlaying: boolean;
  currentBeat: number;
  /** seed the composition (via the supplied seed) + load the video. */
  load: (
    comp: TakeComposition,
    videoSrc: string,
    meta: SourceMeta,
    captureLog?: CaptureLog | null,
  ) => Promise<void>;
  loadSample: () => void;
  loadFiles: (files: FileList | File[]) => void;
};

const SAMPLE = {
  composition: "/sample/composition.json",
  video: "/sample/capture.mp4",
};

// usePreview owns the engine, the canvas/video nodes, video loading, transport
// state, and the PLAYBACK beat (currentBeat). It no longer owns the composition
// — that lives in useComposition; `seed` (passed in) hands a loaded comp to it,
// and the engine reads its derived state back for the playback-beat highlight.
export function usePreview(seed: SeedFn): UsePreview {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [engine, setEngine] = useState<PreviewEngine | null>(null);
  const [status, setStatus] = useState<LoadStatus>("empty");
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<SourceMeta | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentBeat, setCurrentBeat] = useState(-1);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const objectUrl = useRef<string | null>(null);

  // create the engine once the canvas + video nodes exist
  useEffect(() => {
    if (!canvasRef.current || !videoRef.current) return;
    const eng = new PreviewEngine(canvasRef.current, videoRef.current);
    setEngine(eng);
    // dev-only handle for fidelity automation / debugging in the console
    if (import.meta.env.DEV) (window as unknown as { __engine: PreviewEngine }).__engine = eng;
    const offState = eng.on("state", (s) => setIsPlaying(s === "playing"));
    const offTime = eng.on("time", (t) => {
      const d = eng.derived;
      if (!d) return;
      const idx = activeBeatIndex(d.comp, t);
      setCurrentBeat((prev) => (prev === idx ? prev : idx));
    });
    return () => {
      offState();
      offTime();
      eng.dispose();
    };
  }, []);

  const load = useCallback(
    async (
      comp: TakeComposition,
      videoSrc: string,
      meta: SourceMeta,
      captureLog: CaptureLog | null = null,
    ) => {
      const eng = engine;
      if (!eng) return;
      setStatus("loading");
      setError(null);
      try {
        seed(comp, captureLog); // useComposition → engine.setComposition
        await eng.loadVideo(videoSrc);
        setVideoSrc(videoSrc);
        setSource(meta);
        setCurrentBeat(activeBeatIndex(comp, 0));
        setStatus("ready");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    },
    [engine, seed],
  );

  const loadSample = useCallback(() => {
    void (async () => {
      try {
        const comp = (await (await fetch(SAMPLE.composition)).json()) as TakeComposition;
        await load(comp, SAMPLE.video, { name: "sample · docs demo", kind: "sample" });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    })();
  }, [load]);

  const loadFiles = useCallback(
    (files: FileList | File[]) => {
      const arr = Array.from(files);
      const compFile =
        arr.find((f) => /composition.*\.json$/i.test(f.name)) ??
        arr.find((f) => f.name.endsWith(".json"));
      const videoFile = arr.find(
        (f) => f.type.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(f.name),
      );
      if (!compFile || !videoFile) {
        setError("Drop a composition .json and its capture video together.");
        setStatus("error");
        return;
      }
      // an optional sibling capture log enables the full capture-lock Save gate
      const logFile = arr.find((f) => /capture.*\.json$/i.test(f.name) && f !== compFile);
      void (async () => {
        try {
          const comp = JSON.parse(await compFile.text()) as TakeComposition;
          const captureLog = logFile ? (JSON.parse(await logFile.text()) as CaptureLog) : null;
          if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
          const url = URL.createObjectURL(videoFile);
          objectUrl.current = url;
          await load(comp, url, { name: videoFile.name, kind: "files" }, captureLog);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          setStatus("error");
        }
      })();
    },
    [load],
  );

  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  return {
    canvasRef,
    videoRef,
    engine,
    status,
    error,
    videoSrc,
    source,
    isPlaying,
    currentBeat,
    load,
    loadSample,
    loadFiles,
  };
}

/** Subscribe a leaf component to the engine clock (isolates 60fps re-renders
 *  to just the playhead / timecode that need them). */
export function useEngineTime(engine: PreviewEngine | null): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!engine) return;
    setT(engine.currentTime);
    return engine.on("time", setT);
  }, [engine]);
  return t;
}
