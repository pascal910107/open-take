# open-foley

Foley for agents. It reads the script, not the pixels.

A foley artist watches the picture and performs a sound for every moment that
needs one — a tap when the avatar lands, a whoosh when the panel slides, a hit
when the title drops. An agent that renders video already knows every one of
those moments to the millisecond: it wrote the timeline. open-foley takes that
timeline as an **event sheet** and returns a sample-accurate sound stem. No
model watches the video, nothing is guessed, and the same input always mixes to
the same bytes.

```sh
npx open-foley score events.json --video film.mp4 --out film-scored.mp4
```

## The two documents

**Event sheet** (in) — what happened, in a timeline's vocabulary:

```json
{
  "version": 1,
  "durationS": 11.8,
  "events": [
    { "kind": "notify", "atS": 0.08, "label": "followed you" },
    { "kind": "tap", "atS": 0.37, "pan": -0.2, "label": "avatar" },
    { "kind": "build", "atS": 1.6, "durationS": 2.7 },
    { "kind": "move", "atS": 1.65, "durationS": 0.5, "extent": 0.3 },
    { "kind": "transition", "atS": 5.97 },
    { "kind": "reveal", "atS": 6.0, "intensity": 0.9, "label": "Thank you." }
  ]
}
```

Kinds: `click` `key` `tap` `enter` `exit` `move` `zoom-in` `zoom-out` `pan`
`transition` `reveal` `notify` `build` `drop`. Each carries `atS` on the output
timeline and optionally `durationS`, `intensity` (0..1), `extent` (0..1, how
much of the frame), `pan` (−1..1) and a `label`.

**Cue sheet** (out) — every sound to play: role, time, level, pan, pitch, seed.
It is the editable artifact: change a cue's gain, delete one, re-mix.

```sh
open-foley spot events.json --style cinematic     # events → cues.json
open-foley mix  events.cues.json --out foley.wav  # cues   → samples
```

## Spotting is a table

`spot` walks the events and places cues by rule: a tap per landing, a keystroke
per key, a whoosh that departs a hair before a move so its swell rides the
motion, a riser under a build that stops where the payoff begins, and — for a
`reveal` — a **stack**: pop (transient) + impact (body) + boom (sub) + chime
(tail), the way hand-laid motion-design sound is built. Two density passes keep
it from turning to mush: same-role cues that collide collapse into the louder
one, and micro cues are capped per second.

Three presets — `cinematic` (the reference language), `minimal` (interface
sounds only: no sub, no riser) and `playful` (pops) — are plain data
(`style.ts`); every level is a number you can edit.

## The voices

Every role has a procedural voice (`synth.ts`): tap, key, click, pop, whoosh,
air, riser, impact, boom, chime, ui, notify, tick. Each cue is rendered from its
own seed and pitch, so twenty avatar landings are twenty slightly different
taps. Any role can be overridden by WAV files once ears have picked something
better:

```json
{ "roles": { "impact": [{ "file": "impact-a.wav" }, { "file": "impact-b.wav" }] } }
```

```sh
open-foley audition --out audition/            # hear every role, three variants
open-foley mix cues.json --out foley.wav --library lib/library.json
```

## Programmatic

```ts
import { spot, mixToWav } from "open-foley";
const cues = spot(eventSheet, { style: "cinematic", seed: 1 });
writeFileSync("foley.wav", mixToWav(cues, { offsetS: 0 }));
```

open-foley has no dependencies and never shells out; `score` is the one command
that needs `ffmpeg` on PATH (or `FOLEY_FFMPEG`) to mux the stem onto a video.

[open-take](https://github.com/pascal910107/open-take) is the first client: a
take's composition and a launch film both spell their own timelines as event
sheets, so `open-take make --sound cinematic` scores a recording from its
ground-truth event log.

MIT.
