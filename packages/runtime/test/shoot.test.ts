// The parts of `shoot` that need no browser: which key a typed character goes
// out as (a page that listens to keydown must see the key a US keyboard
// sends), and how a still's name becomes its file.

import assert from "node:assert/strict";
import { test } from "node:test";
import { keyFor, stillFile } from "../src/shoot";

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
