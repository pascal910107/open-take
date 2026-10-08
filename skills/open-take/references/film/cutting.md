## Cutting on the music

A long take and fast cuts are not modes of a film: each boundary hands over
its own way — carried by a move, cut, cut to the same place, bridged by a
sound — and a cut can sit on a beat, an onset, a word, or off them on
purpose.

```sh
npx open-take film beats track.mp3     # → track.beats.json (a film.mp4 works too)
```

`film beats` reads music as a grid: tempo (with its confidence and the
half/double readings), beats, downbeats and bars, sections with their energy,
drops, onsets — each field labelled measured, estimated or not detected.
`kit/cut.js` reads it:

```js
import { grid, matchCut, cuts, density } from "./kit/cut.js";
import { throughCamera } from "./kit/media.js";
const g = grid(await (await fetch("music.beats.json")).json());
// or a pulse of your own: grid({ bpm: /* the music's */, offset: /* s */, beatsPerBar: /* its meter */ })
g.bar(4); g.beat(8.5);               // when bar 4 starts; the "and" of beat 8
g.snap(3.1, { to: "onset", within: 0.08 });  // to: beat | half | quarter | bar | onset | section | drop
g.between(8, 12, { to: "bar" });     // the bar lines in [8, 12)
```

`film listen` prints the grid it heard as such a call, `grid({ bpm, offset })`
(`skill film checking`).

- `matchCut(fromBox, toBox, { width, height }, { fit })` frames the next
  shot so its copy of the subject lands where the last shot left it: a view
  `{ cx, cy, w }` for `cam.cut(view, t, { keepInside: false })`. `fromBox` is
  where the subject showed in the picture — `throughCamera(box, cam, t)`;
  `fit` is `"area"` (default), `"width"`, `"height"`, `"contain"`, `"cover"`.
- `cuts(tl, times, { grid, to, within })` declares each as `tl.event(t,
  "cut")` (snapped onto the grid when one is given), so the events file and
  the score have them.
- `density(g, [{ from, to, intent }])` is one way to turn "this part holds,
  this one bursts" into cut times on the grid: `intent` a word from `PACE`
  (`hold`, `calm` 8 beats, `steady` 4, `pulse` 2, `burst` 1, `flurry` ½), a
  number of beats, or `{ every: [4, 0.5] }` for a pace that changes across
  the section; `on: "onset"` lands each on a nearby onset. Change what it
  gives or place every cut by hand.

A track can be edited by whole bars in the score's script (`audio.mjs`):
`cutToBars(sound, beats, [{ from, to, times }], { xfade, fadeIn, fadeOut, at })`
joins bars with an equal-power crossfade that ends on the bar line, and
returns `{ sound, map, joins, beats }` — `beats` is the edit's own grid, to
write out for the page's `grid()`. `landOn(beats, { bar, at, start })` gives
the lead-in so source bar `bar` sounds at film time `at`:

```js
const edit = cutToBars(load("track.mp3"), beats,
  [...landOn(beats, { bar: 40, at: 16 }), { from: 40, to: 46 }]);
play(music, edit.sound, 0);
writeFileSync("music.beats.json", JSON.stringify(edit.beats));
```

A track you did not make needs a licence that covers the film.
