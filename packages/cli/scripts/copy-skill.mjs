// Bundle the guide and its bounded Markdown references as one package resource.
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "..", "..", "..", "skills", "open-take");
const dest = resolve(here, "..", "skill");
const files = ["SKILL.md"];
let bytes = 0;
const names = new Set();
function collect(path, depth = 0) {
  if (depth > 8) throw new Error("Skill reference directory is too deep");
  if (!lstatSync(resolve(src, path)).isDirectory())
    throw new Error(`Unsafe skill directory: ${path}`);
  for (const entry of readdirSync(resolve(src, path), { withFileTypes: true })) {
    const name = `${path}/${entry.name}`;
    if (name.split("/").length > 9) throw new Error("Skill reference directory is too deep");
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.name) ||
      /^(skill\.md|skill-lock\.json)$/i.test(entry.name) ||
      entry.name.endsWith(".") ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(entry.name) ||
      entry.isSymbolicLink()
    )
      throw new Error(`Unsafe skill reference: ${name}`);
    if (entry.isDirectory()) collect(name, depth + 1);
    else {
      if (!entry.isFile() || !name.endsWith(".md") || names.has(name.toLowerCase()))
        throw new Error(`Invalid skill reference: ${name}`);
      names.add(name.toLowerCase());
      bytes += lstatSync(resolve(src, name)).size;
      files.push(name);
      if (files.length > 65 || bytes > 2 * 1024 * 1024)
        throw new Error("Skill references exceed bundle limits");
    }
  }
}
collect("references");
if (!lstatSync(resolve(src, "SKILL.md")).isFile()) throw new Error("Invalid skill guide");
const guide = readFileSync(resolve(src, "SKILL.md"), "utf8");
for (const match of guide.matchAll(
  /(?:\]\(\s*<?|\]:\s*<?)(?:\.\/)?(references\/[a-zA-Z0-9._/-]+\.md)(?:[?#][^\s)>]*)?(?=[>\s)]|$)/g,
)) {
  if (!files.includes(match[1])) throw new Error(`Missing skill reference: ${match[1]}`);
}
const foldedFiles = new Set(files.map((path) => path.toLowerCase()));
for (const path of foldedFiles) {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    if (foldedFiles.has(parts.slice(0, i).join("/")))
      throw new Error(`Unsafe skill reference file/directory collision: ${path}`);
  }
}
// This is generated package content. Clearing it avoids shipping references
// removed from the source bundle on a later build.
rmSync(dest, { recursive: true, force: true });
for (const file of files) {
  mkdirSync(dirname(resolve(dest, file)), { recursive: true });
  copyFileSync(resolve(src, file), resolve(dest, file));
}
