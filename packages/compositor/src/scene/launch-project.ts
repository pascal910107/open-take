import { makeProject } from "@revideo/core";
import { RENDER_OVERSAMPLE } from "../launch-evaluate";
import comp from "./.launch-composition.json";
import schedule from "./.launch-shutter.json";
import scene from "./launch-scene";

// under motion blur the render clock runs faster than the film (launch-scene.tsx)
const oversample = schedule.length ? RENDER_OVERSAMPLE : 1;

export default makeProject({
  scenes: [scene],
  settings: {
    shared: { size: { x: comp.output.width, y: comp.output.height } },
    rendering: { fps: comp.output.fps * oversample },
  },
});
