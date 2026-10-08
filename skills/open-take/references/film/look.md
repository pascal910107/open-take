## The product's look

```sh
npx open-take film look takes/x.take --out film/look --page film --fonts film/fonts
```

`film look` reads the look off the product's real interface — a take's
saved screens, one state, or a URL: every colour with how much of the screen
it paints and where (and its CSS variable names), an estimate of the roles
(bg, surface, text, muted, accent, on-accent, border) with the reason and
the alternatives, the families the text is set in with their actual font
files, type sizes, radii, shadows, and the motion timings its CSS declares
(declared, not necessarily played). It writes `look.json`, `look.css` (the
product's `@font-face` rules and `--look-*` colours) and `look.png`, a
specimen at film size in the product's fonts and words. With `--page` (the
film's page) or `--text` it checks every character of the film's words
against those font files, at each weight used, and names what none of them
has; `--fonts <dir>` writes the files cut down to those words, with a
`fonts.css`. Roles are estimated, the rest measured; none of it is a preset.
`film init <dir> --url <url>` runs it once on the product's page, into
`<dir>/look/`.

`kit/look.js` executes type and colour at film scale:

```js
import { fitText, contrast, readable, palette, loadLook, fontsReady } from "./kit/look.js";
const look = palette(await loadLook("look/look.json"));   // look.bg, look.text, look.accent, look.font()…
await fontsReady(look.font(), "800", words);
const f = fitText({ width: 1500, height: 420 }, words, { font: look.font(), weight: 800, lines: 2 });
title.style.font = f.font; title.innerHTML = f.lines.join("<br>");
contrast(look.text, look.bg);   // the WCAG ratio
f.readable.on[0];               // how big that size shows on an upright phone, px and mm
```

`fitText(box, text, { font, weight, min, max, lines, lineHeight,
letterSpacing, balance })` returns the biggest size that fits and its lines
(`fits: false` when even `min` does not): CJK broken by phrase and never
before a closing mark, Latin at spaces, lines balanced. `breakLines`,
`measurer` and `readable(px)` are there on their own.
