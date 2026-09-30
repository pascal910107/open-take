// The Chrome for Testing a browser test drives: OPEN_TAKE_E2E_CHROME, the
// runtime's managed download, or a legacy agent-browser install — never the
// system Chrome. Tests skip when none is found.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CFT_EXE = "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const exeCandidates = (dir: string): string[] => [
  join(dir, "chrome-mac-arm64", CFT_EXE),
  join(dir, "chrome-mac-x64", CFT_EXE),
  join(dir, CFT_EXE),
  join(dir, "chrome-linux64", "chrome"),
  join(dir, "chrome-win64", "chrome.exe"),
  join(dir, "chrome"),
];
/** newest build first: "mac_arm-149.0.7827.22" > "chrome-131.0.6778.204" by the numbers */
const byBuildDesc = (a: string, b: string): number => {
  const nums = (s: string) => (/\d+(?:\.\d+)+/.exec(s)?.[0] ?? "0").split(".").map(Number);
  const na = nums(a),
    nb = nums(b);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (nb[i] ?? 0) - (na[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

export function findChrome(): string | null {
  if (process.env.OPEN_TAKE_E2E_CHROME) return process.env.OPEN_TAKE_E2E_CHROME;
  const candidates: string[] = [];
  // the runtime's managed download (@puppeteer/browsers layout: chrome/<platform>-<build>/…)
  const managed = join(homedir(), ".open-take", "browsers", "chrome");
  if (existsSync(managed))
    for (const d of readdirSync(managed).sort(byBuildDesc))
      candidates.push(...exeCandidates(join(managed, d)));
  // legacy: a CfT an agent-browser install left behind (the runtime accepts it too)
  const legacy = join(homedir(), ".agent-browser", "browsers");
  if (existsSync(legacy))
    for (const d of readdirSync(legacy)
      .filter((n) => n.startsWith("chrome-"))
      .sort(byBuildDesc))
      candidates.push(...exeCandidates(join(legacy, d)));
  return candidates.find((c) => existsSync(c)) ?? null;
}
