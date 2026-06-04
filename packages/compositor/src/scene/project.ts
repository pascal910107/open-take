// Excluded from tsc (src/scene/**); compiled by revideo's vite at render.
import { makeProject } from "@revideo/core";
import scene from "./scene";
import comp from "./.composition.json";

// Motion blur = temporal supersampling: render at fps·samples and let render.ts
// average sub-frames back down to the output fps (ffmpeg tmix). Off (samples ≤ 1
// or shutter 0) ⇒ just the output fps, i.e. unchanged.
const mb = comp.motionBlur;
const subSamples = mb && mb.samples > 1 && mb.shutter > 0 ? mb.samples : 1;

export default makeProject({
  scenes: [scene],
  settings: {
    shared: { size: { x: comp.output.width, y: comp.output.height } },
    // honour the composition's fps (default 30) — a hi-fps capture renders at 60
    rendering: { fps: comp.output.fps * subSamples },
  },
});
