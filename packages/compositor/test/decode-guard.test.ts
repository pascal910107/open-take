// decode-guard — the sentinel contract between the scene's in-browser decode
// probe and render.ts's VP9 retry. Only the message STRING crosses the
// browser→Node boundary, so both message variants must START with the mark
// and the Node-side matcher must recognise them by substring.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildUndecodableMessage,
  CAPTURE_UNDECODABLE_MARK,
  isCaptureUndecodable,
} from "../src/decode-guard.js";

test("buildUndecodableMessage: both variants start with the mark", () => {
  const err = buildUndecodableMessage(
    "media-error",
    "MediaError code 4: DEMUXER_ERROR_NO_SUPPORTED_STREAMS",
    "/capture.mp4",
  );
  const timeout = buildUndecodableMessage("timeout", "readyState=0", "/capture.mp4");
  assert.equal(err.startsWith(CAPTURE_UNDECODABLE_MARK), true);
  assert.equal(timeout.startsWith(CAPTURE_UNDECODABLE_MARK), true);
});

test("buildUndecodableMessage: carries the detail and the src", () => {
  const msg = buildUndecodableMessage(
    "media-error",
    "MediaError code 4: no detail",
    "/capture.mp4",
  );
  assert.match(msg, /MediaError code 4/);
  assert.match(msg, /src=\/capture\.mp4/);
});

test("isCaptureUndecodable: recognises guard messages, built or forwarded", () => {
  assert.equal(
    isCaptureUndecodable(new Error(`${CAPTURE_UNDECODABLE_MARK}: MediaError code 4 …`)),
    true,
  );
  // revideo may forward the message wrapped or as a bare string
  assert.equal(
    isCaptureUndecodable(buildUndecodableMessage("timeout", "readyState=0", "/capture.mp4")),
    true,
  );
  assert.equal(
    isCaptureUndecodable(
      new Error(buildUndecodableMessage("media-error", "MediaError code 3: decode", "/c.mp4")),
    ),
    true,
  );
});

test("isCaptureUndecodable: an unrelated render error is false", () => {
  assert.equal(isCaptureUndecodable(new Error("vite: failed to resolve import")), false);
  assert.equal(isCaptureUndecodable("ffmpeg exited 1"), false);
  assert.equal(isCaptureUndecodable(undefined), false);
});
