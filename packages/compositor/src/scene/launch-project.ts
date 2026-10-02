import { makeProject } from "@revideo/core";
import scene from "./launch-scene";
import comp from "./.launch-composition.json";

export default makeProject({
  scenes: [scene],
  settings: {
    shared: { size: { x: comp.output.width, y: comp.output.height } },
    rendering: { fps: comp.output.fps },
  },
});
