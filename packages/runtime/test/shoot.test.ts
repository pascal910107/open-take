// The parts of `shoot` that need no browser: which key a typed character goes
// out as (a page that listens to keydown must see the key a US keyboard
// sends), and how a still's name becomes its file.

import assert from "node:assert/strict";
import { test } from "node:test";
import { keyFor, shootStatesLine, stateId, stillFile } from "../src/shoot";

test("a typed character goes out as the key a US keyboard presses for it", () => {
  assert.deepEqual(keyFor("a"), { key: "a", code: "KeyA", vk: 65, text: "a" });
  assert.deepEqual(keyFor("A"), { key: "A", code: "KeyA", vk: 65, text: "A", shift: true });
  assert.deepEqual(keyFor("7"), { key: "7", code: "Digit7", vk: 55, text: "7" });
  assert.deepEqual(keyFor("&"), { key: "&", code: "Digit7", vk: 55, text: "&", shift: true });
  assert.deepEqual(keyFor("?"), { key: "?", code: "Slash", vk: 191, text: "?", shift: true });
  assert.deepEqual(keyFor("\n"), { key: "Enter", code: "Enter", vk: 13, text: "\r" });
  assert.deepEqual(keyFor(" "), { key: " ", code: "Space", vk: 32, text: " " });
  // nothing on the layout types it: inserted as text, the way an IME does
  for (const ch of ["é", "中", "😀", "\t"]) assert.equal(keyFor(ch), null, ch);
});

test("a still's file is its index, then its name with what a file system dislikes made safe", () => {
  assert.equal(stillFile(0, "home"), "000-home.png");
  assert.equal(stillFile(12, "text=Add row"), "012-text-Add-row.png");
  assert.equal(stillFile(7, "a/b\\c:d"), "007-a-b-c-d.png");
  assert.equal(stillFile(3, "首頁"), "003-首頁.png");
  assert.equal(stillFile(1, "///"), "001-still.png");
  assert.equal(stillFile(1234, "x"), "1234-x.png");
});

test("a saved screen's id is the still's name as a folder name, new in the shoot", () => {
  const taken = new Set<string>();
  const add = (n: string) => {
    const id = stateId(n, taken);
    taken.add(id);
    return id;
  };
  assert.equal(add("home"), "home");
  assert.equal(add("home"), "home-2");
  assert.equal(add("home"), "home-3");
  assert.equal(add("text=Add row"), "text-Add-row");
  assert.equal(add("../up"), "up", "never a path out of states/");
  assert.equal(add("assets"), "assets-2", "states/assets/ holds the screens' shared files");
  assert.equal(add("首頁"), "首頁");
  assert.equal(add("///"), "still");
});

test("a shoot says once how many stills kept a saved screen, or what keeps one", () => {
  const still = (file: string, state?: string) => ({
    file,
    name: file,
    t: 0,
    cursor: { x: 0, y: 0 },
    scroll: { x: 0, y: 0 },
    boxes: {},
    ...(state ? { state } : {}),
  });
  const none = shootStatesLine({
    viewport: { w: 800, h: 600 },
    scale: 2,
    stills: [still("000-a.png"), still("001-b.png")],
  });
  assert.match(none, /^kept 2 stills; no saved screens/);
  assert.match(none, /\{ state: true \}/);
  assert.match(none, /skill film material/);
  const some = shootStatesLine({
    viewport: { w: 800, h: 600 },
    scale: 2,
    stills: [still("000-a.png", "a"), still("001-b.png")],
    states: {
      dir: "states",
      items: [{ id: "a", still: "000-a.png", t: 0, fidelity: { psnr: 40, diffFrac: 0, ok: true } }],
    },
  });
  assert.match(some, /^saved screens: 1 of 2 stills in states\/ \(1 re-render as shot\)/);
});
