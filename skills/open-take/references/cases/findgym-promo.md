# FindGym — the product's own things rebuilt as the film's objects

A 43.5 s, 1920×1080, 60 fps film of findgym.tw (a marketplace for
second-hand gym memberships, in Traditional Chinese), made on 2026-09-30 by
Opus 5.5 writing its own film page **without open-take**: its own renderer,
its own motion blur, its own synthesized score. It shows almost no
recording or screenshot of the site: it **rebuilt the site's components**
(the membership card the site draws for each listing, its calculator's
scoreboard, its search form, its "second-hand first" divider, its globe)
as the film's own HTML at film size, in the site's own fonts, colours and
clay illustrations, and moved them.

**Brief it was given:** make a promo film for findgym.tw, to let people
know it exists and bring users to it; the creative choices are yours. The
author could read the product's source code and run it locally with its
demo data and test accounts. An earlier version of the brief carried a
list of motion rules (curves by role, masked word rises, one hard hit),
which the author kept. The site's scripts did not run in its headless
browser, so recording the live site was not an option.

## Structure: a problem, one card's journey through the product, the site's own end card

120 BPM; every scene boundary on a bar. 6 hard cuts in 43.5 s (measured,
scene > 0.30: 4, 18, 21, 24, 32, 36 s); the other scene changes are carried
by an object or by words. Times are the film's own cue sheet, the key
moments checked on frames.

| Time | Wants to express | Moves | Holds | Handoff into next | Sound |
|---|---|---|---|---|---|
| 0–2.7 | plans changed, the membership did not | 「計畫變了，會籍還在。」 rises word by word over the site's clay locker illustration, a card already in its cubby | the illustration, creeping 4.5 % | carry | pad, minor colour |
| 2.7–4.4 | this is about that card | the rebuilt card appears exactly over the drawn one, lifts out, turns to camera; the background defocuses | — | **cut at 4.0 while the card is still arriving** — the object carries it | a whoosh |
| 4.25–5.35 | time used vs time left | 24 month segments rise, 14 dim one after another; 「剩 10 個月」 arrives with that change | the card on dark green | — | a note per step |
| 5.9–8.36 | cancel or transfer? | the question 「解約，還是轉讓？」; its two words fly up and become the scoreboard's labels | — | **carry: the words are the labels** | build |
| 8.45–12.0 | what each costs | the scoreboard counts from 0 to NT$3,376 and NT$300, bars grow | — | — | — |
| 12.0 | the answer | 「轉讓省 NT$3,076」 lands with a spring; the camera punches 1.2 % | — | — | the one hard hit, after a dip; the music resolves for the first time |
| 13.55–18 | it becomes a listing | the card falls into the first slot of the market's list; the demo listings shift to make room | — | carry (the fall), then cut | whoosh |
| 18–21 | someone else searches | the site's own search form: a district chip, a budget typed digit by digit; taps shown as rings, no cursor | — | cut | digits |
| 21–24 | the site's promise | 「不用登入，也不會有人打給你。」 full frame | — | cut | drums out |
| 24–32 | second-hand first, then quotes | one camera move down the results; the 「二手優先」 stamp lands at 26.0; a real quote, more arriving blurred; a button pressed into the site's own "chosen" state at 30.5 | — | cut | groove; a two-note sound on the choice |
| 32–36 | the next person's start | the card arrives in another clay illustration (about 33 s); the line from the same block as the opening image | — | cut | — |
| 36–43.5 | name, where | the site's own hero headline, a rebuilt globe, the logo, findgym.tw and two calls to action in the site's wording | — | out | plagal close on the logo |

The card is not in every scene: the search, the promise and the results
stand on their own (18–32 s).

## Material

- **The product's source**, read as material: its components (the card,
  the calculator, the form, the divider, the quote card, the globe), its
  design tokens, its copy (most words on screen are the site's own
  strings), its fonts (pulled from the running site's CSS), its clay
  illustrations.
- **Numbers from the product's own formula**: NT$1,688 × 24 months, 10
  left, at the calculator's default rate, with 「依 findgym.tw/calc
  試算，僅供參考」 on screen.
- **Data**: the market's list and the globe's points are the local demo
  seed's 6 listings **plus one listing the author made** (the card that
  falls in), shown as 「剛剛確認」 (just confirmed). The live market had no
  listings. That wording does not tell a viewer the listing is made up.
  Extra quotes are blurred, so no made-up quote text is readable.
- **Time and looking**: at least 2.5 hours from its first research
  screenshot to the master; eight rounds of stills and contact sheets, ten
  rounds of changes.

## Techniques worth seeing (descriptions only)

- **A drawn object becomes the real one.** The rebuilt card is placed by
  the same camera function as the illustration, so it starts on the drawn
  card's pixels and leaves it.
- **Words that become parts.** The question's two words fly to where the
  scoreboard's labels are and are the labels from then on.
- **A change shown where it happens.** The months dim on the strip and the
  caption arrives with them; the chosen quote's button turns into the
  site's own chosen state.
- **Honesty in the picture.** A claim moved to where the site really makes
  it; the product's own formula and disclaimer; a globe with only as many
  points as listings — and one made-up listing that the screen does not
  call made up.

In open-take today: rebuilt components can take their real values from
`components.json` (`readValues`) and say where each came from
(`tl.source`, `note: "demo"`); `film look` reads the fonts and colours off
a saved screen (`skill film material`, `skill film look`).
