## Sound

The soundtrack is a WAV you make — `__film.audio`, or `--audio <file>`.
Compose it however suits the film: a script that synthesizes and mixes it
(it can follow the same timeline the page draws from), sounds you bring, or
both. In `kit/audio.mjs`, `osc` gives a saw, square or pulse that does not
alias (`2 * (phase % 1) - 1` and `sin(x) > 0 ? 1 : -1` fold their upper
harmonics back as tones that are not in the note), exactly in tune, its
pitch a number or a function of time for a glide.

The music and the sounds can also be someone else's finished work — a
track, recorded instruments, a set of effects — when the licence allows
setting it to picture and commercial use: CC0, or CC BY with the credit
kept (`tl.credit({ what, by, licence, url })`); not NC, ND or SA. Take it
from a source that needs no account. Then the picture is cut to the track:
`load` reads it, `film beats` finds its bars, sections and drops, and
`cutToBars` with `landOn` puts the bar you choose on the film's turn
(`skill film cutting`); `film listen` shows where its changes fall against
the cuts. In one comparison of films made from one brief, the one cut to a
found track, its drop on the film's turn and a few effects each on an
action, landed the picture on the music; over a slow track, another had
nothing to land on.

What the measured launch films' scores share (`START.md`, "What the
measured films do"): the sound's structure turns where the story turns — the
low end coming in on a reveal or dropping out, a build that drops on the cut
that shows the result, a hit on the start or landing of a camera move — and
in six of the seven, cuts land on the beat no more often than chance would
put them. Where they differ is density. The six of `reference/travel/` run
a continuous bed (in the three measured in detail, a sub 4.5–10 dB under
the total and there 71–90% of the time), 6–11 onsets a second and no
silence before the last second. The reference film keeps it sparse — no low
end for its first 15.6 s, a few pitched effects, clicks and typing silent,
the logo on a bar line, then silence (`reference/structure.md`, section 6)
— and the three films a viewer preferred were scored that way with
recorded instruments: drums in at the result and out where the film
reflects, a handful of sounds each on an arrival. Our
earlier scores, set beside the six, had a sub 14.6–21.4 dB under the total
and there 10–38% of the time. Either way, one track runs under the whole
film rather than restarting at each scene.

For the low foundation, `lib/palette.mjs` gives `bed` (a sub on the roots),
a `hit` and `hits` on camera-move starts and landings, and a `build` into a
`drop`; a hit stands 4.8 dB over what its bus already holds where it lands,
so mix the bed and the music in first (`over: [buses]` names what it must
stand above when it has a bus of its own; `over: []` plays its `gain` as
given). In `kit/audio.mjs`, `subIn(bus, at)` brings the band under 80 Hz in
18.3 dB and `dropOut(bus, at)` takes it 19.4 dB down for 1.4 s (`full:
true`: the whole bus, 22 dB). `node lib/palette.mjs score.wav` sets a score
beside the six soundtracks' figures — a description, not a target.

`film init` puts recorded instruments in the film's folder: `samples/` — a
grand piano, strings bowed and plucked, harp, vibraphone, marimba,
glockenspiel, a finger bass, an acoustic and an electronic kit; CC0 except
the piano (CC BY 3.0, credited with `tl.credit`; `samples/NOTICE.txt`) —
and `lib/sampler.mjs`, which plays them into `kit/audio.mjs` buses a note
at a time: `S.note(bus, "piano", n("C4"), at, { vel, dur })`, `S.hit(bus,
"pk_kick", at, { align: "onset" })`, `S.credits()`. Effects you bring land
with `play(bus, sound, at, { align: "onset" })`, or `"hit"` for a sound
whose attack is soft.

`film check` measures what is hard to judge by ear alone: integrated
loudness, loudness range, true peak, silences, and clicks; `film listen`
shows where the sound's onsets, beats and sections fall against the page's
events and cuts, where several things in the sound change at once — how
often each band is struck, a sound coming in or going, the harmony, the
level, the low pulse halving or doubling — and whether anything led into
it, and how much of each register's pitched sound sits within 15 cents of
the piece's own tuning. A render ends with the sharpest of those changes
and the tuning, beside what the picture did.

A take recorded with `make` also keeps the product's own sound when the page
made any: `<name>.take/product-audio.wav` is what it sent to its speakers, on
the capture's clock (sample 0 is the zero of every event `tMs`;
`product-sound.json` says how it was placed), and the audio files the page
fetched are listed there, the smaller ones saved in `product-sounds/`. `load`
reads either, and `play` can put any slice of them on a real event.

### What made a score sound machine-made

From one film scored four ways and heard each time: a note for every thing
that happens on screen, a rising run for every build, a noise sweep under
every fast move, one chord a bar round a four-chord loop, and a phrase that
repeats unchanged. What was accepted in their place: one short motif over
slow harmony, four-bar phrases whose last bar turns round, a new phrase by
the middle of the film, a breath before the big turns, and a stretch that
waits thinned rather than stopped. Then the mix: a low bed from the first
frame, parts spread left and right, enough top, a level that does not jump
at the drop — `node lib/measure.mjs` reads these against a reference.
