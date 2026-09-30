// What the HTML renderer's page is handed beside the film (media.json):
// where each video layer's pre-extracted frames are, and each state layer's
// saved screen. Shared by the Node side (launch.ts) and the page (engine.ts).

/** Pre-extracted frames of a video layer: frame i shows source second
 *  trimStartS + i / fps; files are `${base}${String(i + 1).padStart(6, "0")}.jpg`. */
export type HtmlVideoFrames = { base: string; count: number; fps: number };
/** A saved screen a state layer shows: its page, and the viewport it was
 *  captured at (CSS px) — the size the page is laid out at again. */
export type HtmlState = { url: string; width: number; height: number };
/** Media is keyed by scene and layer: layer ids are unique within a scene. */
export const mediaKey = (sceneId: string, layerId: string) => `${sceneId}/${layerId}`;
export type HtmlMedia = {
  videos: Record<string, HtmlVideoFrames>;
  states?: Record<string, HtmlState>;
};
