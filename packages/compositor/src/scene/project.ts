// Excluded from tsc (src/scene/**); compiled by revideo's vite at render.
import { makeProject } from "@revideo/core";
import scene from "./scene";
import comp from "./.composition.json";

export default makeProject({
  scenes: [scene],
  settings: {
    shared: { size: { x: comp.output.width, y: comp.output.height } },
    // honour the composition's fps (default 30) — a hi-fps capture renders at 60
    rendering: { fps: comp.output.fps },
  },
});
