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
the cuts. Few effects, on arrivals — a result landing, a part set down —
each with `play(bus, sound, at, { align: "onset" })`; clicks and keys can
stay silent. That was seen in one comparison of films made from one brief:
in the one cut to a found track, its drop on the film's turn and a few
effects each on an action, the picture landed on the music; over a slow
track, another had nothing to land on.

`film init` puts recorded instruments in the film's folder: `samples/` — a
grand piano, strings bowed and plucked, harp, vibraphone, marimba,
glockenspiel, a finger bass, an acoustic and an electronic kit; CC0 except
the piano (CC BY 3.0, credited with `tl.credit`; `samples/NOTICE.txt`) —
and `lib/sampler.mjs`, which plays them into `kit/audio.mjs` buses a note
at a time: `S.note(bus, "piano", n("C4"), at, { vel, dur })`, `S.hit(bus,
"pk_kick", at, { align: "onset" })`, `S.credits()`. The films a viewer
preferred were scored this way: only the story's turns on bar lines, drums
in at the result and out where the film reflects, clicks and typing
silent, a handful of sounds, each on an arrival (`START.md`; how the
measured film's sound was built is `reference/structure.md`, section 6).

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
