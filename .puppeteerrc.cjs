// open-take manages ONE browser itself: the capture path downloads a pinned
// Chrome-for-Testing via @puppeteer/browsers (runtime/src/cdp.ts), and the
// render path is handed that same binary as puppeteer's `executablePath`
// (compositor/src/render.ts). So revideo's bundled puppeteer never needs to
// fetch its own Chrome — skip that redundant ~150MB download.
//
// Consumers installing the published package get the same effect by setting
// PUPPETEER_SKIP_DOWNLOAD=true (overrides are root-only, so we can't force this
// transitively — documented in the README). The runtime uses the single CfT
// regardless.
module.exports = { skipDownload: true };
