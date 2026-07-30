<!--
The title becomes the release note, so write it as the user-visible change:
"fix zoom drifting on short beats", not "fix bug".
-->

## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## How it was verified

<!--
Delete what does not apply. Motion, pacing and zoom changes are signed off by
eye — attach the clip, or an A/B with one knob changed.
-->

- [ ] `pnpm build && pnpm typecheck && pnpm lint && pnpm -r test && pnpm test:package`
      (note: bare `pnpm test` at the root runs nothing)
- [ ] `pnpm --filter @open-take/compositor test:render-smoke` — if this touches rendering
- [ ] Watched the result — clip attached, if this changes how a demo looks

## Checklist

- [ ] No `version` fields changed (the release script owns them)
- [ ] No new dependency in a published package, or it is justified above
- [ ] `composition.json` / take layout unchanged, or the format change is called out
