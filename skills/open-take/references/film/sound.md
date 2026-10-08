## Sound

The soundtrack is a WAV you make — `__film.audio`, or `--audio <file>`.
Compose it however suits the film: a script that synthesizes and mixes it
(it can follow the same timeline the page draws from), sounds you bring, or
both. `film check` measures what is hard to judge by ear alone: integrated
loudness, loudness range, true peak, silences, and clicks; `film listen`
shows where the sound's onsets, beats and sections fall against the page's
events and cuts.

A take recorded with `make` also keeps the product's own sound when the page
made any: `<name>.take/product-audio.wav` is what it sent to its speakers, on
the capture's clock (sample 0 is the zero of every event `tMs`;
`product-sound.json` says how it was placed), and the audio files the page
fetched are listed there, the smaller ones saved in `product-sounds/`. `load`
reads either, and `play` can put any slice of them on a real event.
