// The decode guard's shared vocabulary — imported by BOTH sides of the
// browser/Node boundary. The scene (src/scene/scene.tsx, vite-compiled inside
// the render browser) probes the capture with a throwaway <video> and rejects
// with a message built here; render.ts (Node) recognises that rejection and
// retries with a VP9 intermediate. Only the message STRING survives the
// crossing — revideo forwards e.message through onRenderFailed — so the
// contract is a sentinel substring, not an error class.
//
// Keep this module dependency-free: the scene tree is copied verbatim into
// the render scratch and compiled for the browser, so a node:* import here
// would break the scene build.

export const CAPTURE_UNDECODABLE_MARK = "capture video is not decodable in the render browser";

/** Build the guard's rejection message. Both variants START with the mark so
 *  isCaptureUndecodable can match the forwarded string. */
export function buildUndecodableMessage(
  kind: "media-error" | "timeout",
  detail: string,
  src: string,
): string {
  const why =
    kind === "media-error"
      ? `decode failed (${detail}) — this Chromium likely lacks the capture's codec`
      : `no decode within 30s (${detail}) — the render browser may lack the capture's codec`;
  return `${CAPTURE_UNDECODABLE_MARK}: ${why}; src=${src}`;
}

/** Did this render rejection come from the scene's decode guard? Substring
 *  match on the message — the Error identity does not survive the
 *  browser→Node crossing. */
export function isCaptureUndecodable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(CAPTURE_UNDECODABLE_MARK);
}
