// This workspace keeps upstream @revideo/renderer as a build-only input for
// @open-take/revideo-renderer. Skip its browser download during development.
// Published consumers receive the bridge's puppeteer-core dependency instead,
// so they do not need this file or an environment variable.
module.exports = { skipDownload: true };
