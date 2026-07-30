// profileDir — the only pure, security-load-bearing part of `open-take auth`.
// A profile name becomes a directory under ~/.open-take/profiles/, so an
// unvalidated one is a path-traversal write into the user's home: `auth
// ../../.ssh` would point a headed Chrome (and every later capture) at a
// directory that is not ours to touch. The launch itself needs a real Chrome
// and a human at the keyboard; this does not, and it is the part that must
// never quietly widen.
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { profileDir } from "../src/auth";

const PROFILES = join(homedir(), ".open-take", "profiles");

test("a plain name lands under ~/.open-take/profiles", () => {
  assert.equal(profileDir("vercel"), join(PROFILES, "vercel"));
  // one char, and the full allowed alphabet after the first position
  assert.equal(profileDir("a"), join(PROFILES, "a"));
  assert.equal(profileDir("A.b_c-1"), join(PROFILES, "A.b_c-1"));
});

test("a name that would escape the profiles dir is refused", () => {
  // the reason this function exists: each of these resolves OUTSIDE the dir
  for (const bad of ["../evil", "..", "../../.ssh", "a/b", "a\\b", "/etc/passwd"]) {
    assert.throws(
      () => profileDir(bad),
      /invalid profile name/,
      `${JSON.stringify(bad)} must be refused`,
    );
  }
});

test("a name that would collide with open-take's own state is refused", () => {
  // ~/.open-take also holds non-profile state; a dot-leading or empty name is
  // either a hidden sibling or the profiles dir itself.
  for (const bad of ["", ".", ".hidden", " ", "a b"]) {
    assert.throws(() => profileDir(bad), /invalid profile name/);
  }
});

test("`..` anywhere is refused, not just at the front", () => {
  // belt-and-braces: the character class already blocks separators, so `a..b`
  // could not traverse — but the explicit `..` guard is what makes that
  // independent of the regex, and a regression in either must still fail.
  assert.throws(() => profileDir("a..b"), /invalid profile name/);
  assert.throws(() => profileDir("..a"), /invalid profile name/);
});

test("the refusal names the name and says what is allowed", () => {
  // an agent reading this message has to be able to fix it without the source
  assert.throws(
    () => profileDir("../evil"),
    (e: Error) => {
      assert.match(e.message, /"\.\.\/evil"/, "quotes the offending name");
      assert.match(e.message, /letters\/digits/, "says what a valid name looks like");
      return true;
    },
  );
});
