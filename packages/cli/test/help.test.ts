// `<verb> --help` prints that verb's usage, driven through the real binary.
//
// The failure this replaces: every value-flag parse saw `--help` as a flag and
// `film render --help` answered "--help requires a value" (or ran the verb), so
// an agent asking a verb what it takes learned nothing. Each verb and each
// `film` / `launch` subcommand must answer with its usage, exit 0, and list
// exactly the flags the parser accepts for it. Nothing here starts Chrome.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FILM_FLAGS, LAUNCH_FLAGS } from "../src/help";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, ["--import", "tsx/esm", CLI, ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => {
      out += d;
    });
    p.stderr.on("data", (d) => {
      err += d;
    });
    p.once("error", rej);
    p.once("close", (code) => res({ code: code ?? -1, out, err }));
  });
}

const usageFlags = (out: string): string[] => {
  const block = out.slice(0, out.indexOf("\n\n"));
  return [...new Set(block.match(/--[a-z][\w-]*/g) ?? [])];
};
const flagsLine = (out: string): string[] => {
  const m = /^Flags: (.*)$/m.exec(out);
  assert.ok(m, `no Flags: line in\n${out}`);
  return m[1] === "none" ? [] : m[1]!.split(" ");
};

test("every verb answers --help with its own usage and the flags it accepts", async () => {
  const full = await run(["--help"]);
  assert.equal(full.code, 0);
  const verbs = [
    ...new Set(
      [...full.out.matchAll(/^ {2}open-take\s+(\S+)/gm)]
        .map((m) => m[1]!)
        .filter((v) => v !== "film" && v !== "launch"),
    ),
  ];
  assert.ok(verbs.includes("make") && verbs.includes("shoot") && verbs.includes("skill"));
  for (const verb of verbs) {
    const r = await run([verb, "--help"]);
    assert.equal(r.code, 0, `${verb} --help: ${r.err}`);
    assert.match(r.out, new RegExp(`^Usage:\\n {2}open-take ${verb}\\s`), verb);
    for (const m of r.out.slice(0, r.out.indexOf("\n\n")).matchAll(/^ {2}open-take (\S+)/gm))
      assert.equal(m[1], verb, `${verb} --help shows only its own usage`);
    // every flag its usage lines show is one the parser accepts for it
    const accepted = flagsLine(r.out);
    for (const f of usageFlags(r.out)) assert.ok(accepted.includes(f), `${verb}: usage shows ${f}`);
  }
});

test("-h, a value flag missing its value, and `help <verb>` all give the help", async () => {
  for (const args of [
    ["make", "-h"],
    ["make", "--plan", "--help"],
    ["make", "--help", "--plan"],
    ["help", "make"],
  ]) {
    const r = await run(args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.err}`);
    assert.match(r.out, /^Usage:\n {2}open-take make /, args.join(" "));
    assert.doesNotMatch(r.err, /requires a value/);
  }
});

test("every film and launch subcommand answers --help with its usage", async () => {
  for (const [verb, table] of [
    ["film", FILM_FLAGS],
    ["launch", LAUNCH_FLAGS],
  ] as const) {
    const all = await run([verb, "--help"]);
    assert.equal(all.code, 0);
    for (const sub of Object.keys(table))
      assert.match(
        all.out,
        new RegExp(`open-take ${verb} ${sub}\\s`),
        `${verb} --help lists ${sub}`,
      );
    for (const [sub, flags] of Object.entries(table)) {
      // with a target and other flags around it, as an agent would type it
      const r = await run([verb, sub, "x", "--out", "--help"]);
      assert.equal(r.code, 0, `${verb} ${sub} --help: ${r.err}`);
      assert.match(r.out, new RegExp(`^Usage:\\n {2}open-take ${verb} ${sub}\\s`));
      assert.deepEqual(flagsLine(r.out), flags, `${verb} ${sub}`);
      // the usage line and the accepted flags are the same set
      assert.deepEqual(usageFlags(r.out).sort(), [...flags].sort(), `${verb} ${sub} usage line`);
    }
  }
});

test("FILM_FLAGS is what each film branch in cli.ts accepts", () => {
  // cli.ts checks film flags inside each branch (`only(…)`); the help reads
  // FILM_FLAGS — this keeps the two from drifting apart
  const src = readFileSync(CLI, "utf8");
  const found: Record<string, string[]> = {};
  for (const m of src.matchAll(/if \(action === "(\w+)"\) \{\s*only\(([^)]*)\)/g))
    found[m[1]!] = [...m[2]!.matchAll(/"(--[\w-]+)"/g)].map((x) => x[1]!);
  assert.deepEqual(found, FILM_FLAGS);
});
