# Original motion compositions

Three different compositions use the same public `motion` JSON vocabulary:

- **Commerce:** opposing screenshot crops, editorial type and a clipped product reveal.
- **Analytics:** a drawn trend, large result typography and a dashboard screenshot.
- **Collaboration:** spatial handoffs, nested groups and a moving task crop.

The functional fixture and product illustrations are original, local and covered
by this repository's MIT license. All products and data are illustrative. The
films are designed explanations of fixtures, not recordings of a customer app.
The capture script also saves actual interaction states for provenance.

```sh
pnpm build
node examples/motion/prepare-assets.mjs
node examples/motion/compose.mjs
node packages/cli/dist/cli.js launch render out/motion-demo/commerce.json --out out/motion-demo/commerce.mp4
node packages/cli/dist/cli.js launch render out/motion-demo/analytics.json --out out/motion-demo/analytics.mp4
node packages/cli/dist/cli.js launch render out/motion-demo/board.json --out out/motion-demo/board.mp4
```

Without `--out`, the default is `launch.mp4` in the composition directory.
Add `--draft` for faster previews.
The generator also writes `portrait.json` (different layout, language, timing,
hierarchy and paint order) and `motion-off.json` (authored static resting values).
These can be rendered with the same CLI; no renderer changes or extra captures
are needed. All five examples are silent because they omit audio.

For the protected authoring path, generate semantic briefs without any layer
coordinates, then let the CLI lay out all three recipe purposes in landscape and
portrait, plus a square focus/five-step stress case:

```sh
node examples/motion/recipe-briefs.mjs
node packages/cli/dist/cli.js launch compose out/motion-demo/recipe-landscape.brief.json --out out/motion-demo/recipe-landscape.json
node packages/cli/dist/cli.js launch compose out/motion-demo/recipe-portrait.brief.json --out out/motion-demo/recipe-portrait.json
node packages/cli/dist/cli.js launch compose out/motion-demo/recipe-square.brief.json --out out/motion-demo/recipe-square.json
node packages/cli/dist/cli.js launch render out/motion-demo/recipe-landscape.json --draft --out out/motion-demo/recipe-landscape.draft.mp4
node packages/cli/dist/cli.js launch render out/motion-demo/recipe-portrait.json --draft --out out/motion-demo/recipe-portrait.draft.mp4
node packages/cli/dist/cli.js launch render out/motion-demo/recipe-square.json --draft --out out/motion-demo/recipe-square.draft.mp4
```

`compose` requires a new output path to protect existing edits. It derives scene
durations from the content unless the brief sets them. These examples exercise
the same layout code an agent calls; they do not hand-tune the generated layers.
The square stress case uses 12fps to keep its render inexpensive; frame rate is
an output choice, not a recipe constraint. Once all eight films are rendered,
`node examples/motion/verify-renders.mjs` checks media properties, visible change,
static motion-off behavior and source integrity. It does not judge typography
or storytelling; inspect the films as well.

To generate the optional recipe-treatment review matrix:

```sh
node examples/motion/style-matrix.mjs
node packages/cli/dist/cli.js launch render out/motion-demo/style-editorial-landscape.json --draft --out out/motion-demo/style-editorial-landscape.draft.mp4
```

The generator writes nine `style-{editorial,product,technical}-{landscape,portrait,square}`
briefs/compositions, each containing focus, comparison and steps, plus three
square motion-off proofs. They retain the same neutral theme and mixed Latin/CJK
copy so reviewers can compare geometry, hierarchy and motion. Their subjects
are illustrative fixtures; the lamp comparison shows two designs, not a claimed
before/after transformation. Outputs are review evidence, not automatic aesthetic
approval. The generated files may be refreshed by rerunning this example script.

Both `prepare-assets.mjs` and `style-matrix.mjs` accept an optional output
directory as their first argument. Use a new directory when comparing revisions
so earlier source manifests, compositions and films remain available for review.

`assets.json` records source-pixel crop rectangles measured from live DOM
elements at capture scale 2, plus the CSS viewport and native pixel dimensions.
`source-hashes.json` records the six screenshots before any renders, so review
can prove source integrity. Rerunning asset preparation intentionally refreshes
these original generated assets; it does not touch recordings elsewhere.

Durations are editorial choices for these examples, not engine presets. Change
the composition geometry, content and timing to fit the actual app. See the
[authoring reference](../../skills/open-take/references/motion-composition.md).
