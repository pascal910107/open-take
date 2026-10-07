// Records the take film-seam-e2e.test.ts plays: the fixture product
// (product/index.html, 640×360) served locally, one click on "Calculate", its
// result showing 0.7 s later — recorded by the runtime with saved states
// (`make --states --no-render`), at 30 fps and 2× density. The take is kept
// in take/ (capture.mp4 + capture.json + states/) so the test needs no
// capture of its own. Run from the repo root when the capture format changes:
//
//   pnpm --dir packages/runtime exec tsx ../compositor/test/fixtures/seam-film/record.ts

import { cp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — run from packages/runtime, where the runtime resolves
import { makeTake } from "../../../../runtime/src/index.ts";

const here = import.meta.dirname;
const page = await readFile(join(here, "product", "index.html"));
const server = createServer((_, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const out = join(tmpdir(), `seam-film-${process.pid}`, "calc.mp4");
try {
  const made = await makeTake(
    {
      url: `http://127.0.0.1:${port}/`,
      viewport: { width: 640, height: 360 },
      startCursor: { x: 320, y: 200 },
      steps: [
        { action: "wait", ms: 400 },
        { action: "click", selector: "#calc", settleMs: 1500 },
        { action: "wait", ms: 600 },
      ],
    },
    { outPath: out, render: false, capture: { fps: 30, states: true, productAudio: false } },
  );
  const take = join(here, "take");
  await rm(take, { recursive: true, force: true });
  for (const f of ["capture.mp4", "capture.json", "states"])
    await cp(join(made.takeDir, f), join(take, f), { recursive: true });
  console.log(`recorded into ${take}`);
} finally {
  server.close();
}
