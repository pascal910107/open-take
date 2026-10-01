// Running a tool and keeping what it writes: stdout as bytes, and when it
// fails, the end of its stderr in the error.

import { spawn } from "node:child_process";

export function runBuffer(bin: string, args: string[]): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    p.stderr.on("data", (d: Buffer) => {
      err = (err + d.toString()).slice(-2000);
    });
    p.on("error", fail);
    p.on("close", (code) =>
      code === 0
        ? ok(Buffer.concat(chunks))
        : fail(new Error(`${bin} exited ${code}: ${err.trim().slice(-400)}`)),
    );
  });
}
