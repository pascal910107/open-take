import type { LaunchComposition } from "./launch-types";

/** A recording-led starting point. Scene lengths and styling remain editable.
 *  Output fps follows the recording so the footage keeps every captured frame;
 *  the default matches `make`'s 60. */
export function launchStarter(
  videoAsset = "assets/capture.mp4",
  clipDurationS = 12,
  fps = 60,
): LaunchComposition {
  if (!Number.isFinite(clipDurationS) || clipDurationS <= 0)
    throw new Error("launch starter: clip duration must be a finite positive number");
  if (!Number.isInteger(fps) || fps < 1 || fps > 120)
    throw new Error("launch starter: fps must be an integer between 1 and 120");
  return {
    version: 1,
    output: { width: 1920, height: 1080, fps },
    theme: {
      canvas: "#F5F2EA",
      ink: "#172E28",
      surface: "#DCE5D8",
      accent: "#214F41",
      dark: "#10231E",
      fontFamily: "Avenir Next, Avenir, Helvetica Neue, Noto Sans, sans-serif",
    },
    scenes: [
      {
        id: "opening",
        type: "title",
        durationS: 2,
        lines: ["Your product. In action."],
        motion: "off",
        transition: { type: "cut" },
      },
      {
        id: "product",
        type: "footage",
        durationS: clipDurationS,
        asset: videoAsset,
        trimStartS: 0,
        fit: "contain",
        frame: { inset: 64, radius: 20 },
        transition: { type: "cut" },
      },
      {
        id: "end",
        type: "end-card",
        durationS: 2,
        headline: "See what you can do.",
        brand: "Your product",
        cta: "Explore your product",
        motion: "off",
        transition: { type: "cut" },
      },
    ],
  };
}
