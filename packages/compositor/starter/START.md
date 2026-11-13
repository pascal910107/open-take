# Start here

`film init` wrote this folder. `skill film` says how the page is written,
rendered and checked. This page says what the films made with this tool were
liked and disliked for, and the order the liked ones were made in.

## What this page rests on

Thirteen films of three products, made by agents with this tool, watched by
one viewer.

Six were made from a one-line request and a guide of advice. His words for
them: middling, nothing stands out, rigid, not good-looking. What they shared:

- a tour — the product's picture, a claim, a feature, another feature, a line
  on trust, the logo — each a card of its own, nothing carried from one card
  into the next;
- the product as screenshots, pushed in on or tilted, soft once enlarged;
- a caption or a big number on nearly every card;
- a camera that never stops drifting or pushing in;
- a hit on every cut and every number, over an oscillator score;
- a logo card held three to six seconds.

Three were made from what is on this page. He preferred each of them: "not
rigid", "the information is clear", "the transitions look good, the animation
too". The three look nothing like each other — a slow web page and the photo
that slows it; a photo as a slab whose thickness is its file size; a
membership card handed to the next person. What they shared:

- **one thing from the product's world, followed from the first frame to the
  last.** What the product does is what happens to that thing. The last view
  is the first view, changed.
- **the thing starts in trouble, with a number on it, and the film ends on
  that number changed.** A 2.79 MB photo that a page waits ten seconds for;
  at the end 276 kB, and the same page is there in one. Ten months left on a
  contract and NT$2,576 to leave it; at the end NT$300 to hand it on, and the
  next person training on it. The thing and its number are on screen before
  any of the product is.
- **more of the product happens to the same thing on the way** — three to
  five of the things it does, none of them as a card. The quality slider
  dragged too far and back; the divider drawn across the eye; the other
  formats standing beside it as slabs, one of them bigger than the original;
  nothing uploaded. The calculator; the brand's transfer rule on the back of
  the card; 353 branches lighting up on the map; second-hand listings ranked
  first.
- **material at the size where the trouble is real.** The photo was the
  product's own sample, because that sample is 2.79 MB. Where what the
  product opens with is too small to be a problem for anyone, bring one that
  is: public data fetched without an account, or one written for the film
  and marked as a demo where it stands for someone's data (the page and the
  membership in the three were marked so).
- **more than one place.** None of the three stays inside the product's
  window: a white web page, a studio floor, a cream table come first, and the
  product's interface arrives into that as one place among several, in its
  own colours.
- **the product's interface rebuilt as live HTML** in its own fonts, colours,
  wording and formulas, the cursor working it: a list opens, a slider drags,
  a result is computed and lands. A screenshot appears only as evidence.
- **the camera mostly holds.** The picture stays alive because things are made
  one at a time: a panel slides in, months grey out one by one, a number
  counts, a result stamps down.
- **a change of scene is something on screen doing something**: a card flips
  over into the next view; a blob swallows the photo and opens as the editor;
  the page is squashed into the logo. Where there is a cut it sits inside the
  fastest motion.
- **few words**: three to six lines of caption in the whole film.
- **sound that follows the story**: real instrument samples, notes the agent
  wrote; only the story's turns sit on bar lines; drums come in at the result
  and leave where the film reflects; clicks, typing and camera moves are
  silent; a handful of sounds, each on an arrival. All three end on drums
  out, one chord, the logo, silence.
- 30 to 45 seconds. Two have their first draft on record: 37.5 and 41 s,
  ending at 30.5 and 38.5 after the rounds took time out.

Two were made from an earlier copy of this page and nothing else. Both
followed one thing and rebuilt the interface live. One he placed just under
the three. Of the other he said there was not much in it:

- it took the sample the product opens with, put it through the product's
  main function, retyped one value, and folded it into the logo;
- its plan had listed seven things the product does, and the film showed one;
- nothing was wrong at the start, so nothing was better at the end — no
  trouble, no number, nobody for whom anything changed;
- its own first-time viewer said the sample made it look like a toy; the note
  was turned down because a larger one "would have to be invented";
- three minutes went into the product, all of them on the screen it opens
  with;
- its first draft was 29 s and every round took time out: 21.6 s at the end.

That product's film was then made twice more from this page: real public
data in place of the sample, five and six of the product's functions
happening to it, a number that changed. He called them fine. What was still
weak in both: one dark colour from end to end, and the product pulled back
to blocks too small to read.

The films to beat are the tour and the thin one. The aim is a film plainly
better than both.

## The reference

`reference/structure.md` and `reference/motion.md` are measurements of one
launch film people shared, the one this viewer called "a very good launch":
its sections to 0.1 s, how its story is built, every transition, its motion
curves and speeds, when its camera holds, what its sound does. All three
preferred films were made after reading structure in full and motion §0–4,
and took from them the held camera, things made piece by piece, the stamp,
the fling, cuts hidden in motion, the ending that answers the opening, and
the sparse sound (structure §6). Borrow its grammar, never its brand, look
or names.

## The order the three were made in

1. Use the product, with something of your own put through it: every menu
   opened, each thing it does run once, the numbers and results it gives
   written down, its own words for them kept.
2. Fill `PLAN.md` before building: everything the product does; the film
   that comes to mind first and which marks of the tour it carries; then the
   film to make — its one sentence, the thing followed, its trouble and its
   number, which of the product's functions happen to it, and a table of
   stretches with what the viewer should feel in each.
3. Build it on the page. Render drafts (`film render . --draft`, about half a
   minute each) and look at each one's sheet (`film sheet`) and full-size
   stills before going on.
4. Change it. The three took 3 to 8 drafts and 2 to 4 complete rounds of
   changes, in 64 to 77 minutes with their renders; two of them had a round
   from first-time viewers (`film viewer`). A first-time viewer will call
   some stretch still or slow. Cutting it is one answer; the other is to
   have the next thing the product does happen to the thing there. A film
   that has come down under 30 s needs the second.
5. Before the full render, full-quality stills (`film still --at`) of the
   fastest moments and of anything much larger than the frame. A draft is
   half size with no motion blur, so it shows neither a fast move smeared
   past reading nor a very large element the full render fails to draw; one
   film lost a 95,000 px line of text that way and found out after a
   13-minute render.
6. The full render — 3 to 26 minutes for these films; start it in the
   background and wait for it — then look at that too: frames from the
   finished file, `film check`, `film listen`. Patch a stretch with
   `--from --to --into` rather than rendering it all again.

## What is in the folder

- `PLAN.md` — the plan to fill in step 2.
- `reference/` — the measurements above.
- `lib/anim.js` — keyframes, the reference's measured curves, stamp, spring,
  fling and the like; there if useful. Each of the three wrote its own motion
  helpers in place of the kit's camera, cursor and motion files.
- `lib/sampler.mjs` and `samples/` — recorded instruments, no account needed;
  `samples/NOTICE.txt` has each one's licence, and the piano needs a credit
  (`tl.credit`).
- `kit/` — `time.js` (segments, events, sources, credits) and `audio.mjs`
  (mixing, loudness, diagnose) were used by all of them; the rest is there to
  read, use or drop.
