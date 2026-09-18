# Launch sample assets

`fixture.html` is an owned, functional local release workspace used to record
real browser interactions. It is explicitly a demonstration fixture, not a
third-party product or the Open Take editor. Buttons update application state:
approve the checklist, publish, then open the release page.

After building the repository, run:

```sh
node examples/launch/prepare-assets.mjs
```

The script serves the fixture on a temporary loopback port, records it using
Open Take, and writes footage plus original procedural music/UI sounds under
`out/launch-demo/assets/`. It retains capture and composition alongside them.
Pass `--audio-only` to regenerate sound without launching a browser, and
`--duration <seconds>` to match music to the authored film length.

Assemble the launch JSON from the reusable template, then render:

```sh
node examples/launch/compose.mjs
node packages/cli/dist/cli.js launch check out/launch-demo/launch.json
node packages/cli/dist/cli.js launch render out/launch-demo/launch.json --draft
node packages/cli/dist/cli.js launch render out/launch-demo/launch.json
```

The assembly script computes sound cues from scene/state boundaries and leaves
music duration open so it follows the film's actual ending. Edit `launch.json`
directly to change copy, state timing, scene order/count, colors and audio. Do
not rerun `compose.mjs` over hand edits; it deliberately regenerates the sample.
For silence, remove `audio` or set it to `[]`. For only capture + cursor/zoom,
use `recording.mp4` directly; the launch workflow is optional.

The waveform synthesis is deterministic and uses no samples, online service,
paid account, or external music. The music is a quiet 80 BPM pad/pluck sketch;
the two sound effects are restrained tonal accents. Assets are distributed
under this repository's MIT license and generated media is not checked in.
