> What this is: measurements of one published launch film — its sections to
> 0.1 s, how its story is built, its words, rhythm and sound (section 6) —
> translated from a research report, with the parts that only made sense on the
> researcher's machine removed. The marks say how each claim stands:
> [verified] = measured on the file or seen in its frames, [inferred] = derived
> from measurements without direct evidence, [uncertain] = not found, or not
> enough measurement to conclude. The researcher could not hear: every statement
> about sound comes from spectra, onsets, band energy and loudness measurements
> set against picture events.

# Reference film, broad breakdown: "Introducing Claude Whiteboards, Sheets, and Data" (story / shots / words / rhythm / sound)

Source: "Introducing Claude Whiteboards, Sheets, and Data", YouTube channel
"Claude", uploaded 2026-11-10 (video id `YewAJPawE7I`); 1920×1080, 24 fps,
57.82 s, AAC 44.1 kHz stereo.

Sections 7 and 8 of the original (a comparison with a video tool's own guide,
draft entries for that guide, and recommendations for the tool) and section 10
(a list of the researcher's work files) are left out; the remaining sections
keep their original numbers.

Marks: **[verified]** = I measured the file itself or looked at its frames
(command or number given); **[inferred]** = follows from measurements, but
without direct evidence; **[uncertain]** = could not be found, or the
measurement is not enough to conclude.

---

## 0. Summary

- **0 hard cuts** in the whole film (maximum scene score 0.059; `film probe`: no
  hard cut) [verified]. It is one continuous 57.8 s shot that changes scene
  through objects, push-ins, whips and reframing. I divided it into 23 stretches
  of 0.8–4.4 s each (median 2.5 s).
- The story is **one launch project of one invented company (GeeGolly Good
  Pies)**, run through three products in turn: plan in Whiteboards → forecast in
  Sheets → share in Data. **Figures carry over from product to product** (65,000
  boxes, 10K baked a day, 50,000 last year). The closing line "Plan / Build /
  Share → **Work** at the speed of thought" gathers the verbs of the three title
  cards back into one sentence [verified].
- **The lead is Claude's collaboration cursor**: its name pill joins "New in" to
  make "New in Claude"; it then types the title, drags in the first card, draws
  the whiteboard, fills the sheet, and selects the word to be swapped; the logo
  appears after it has left. 5 more named teammate cursors run through the whole
  film [verified].
- **The score's arrangement turns where the story turns**: the 15.6 s intro has
  no low end; kick and sub-bass come in on the bar (15.62 s) where Claude starts
  drawing the answer; in the Data stretch (34.0 s) the low pulse doubles; once
  the closing line has settled (51.95 s) drums and bass all drop out; the logo
  lands on the next bar line (54.54 s); silence at 57.05 s [verified: measured /
  estimated].
- **Small picture events are not on the beat.** Of 35 picture events, 31 % fall
  within ±42 ms of the 0.325 s beat grid, against a chance baseline of 26 %; the
  word swaps come every 0.583 s (14 frames) while the beat is 0.649 s. Only 3–4
  structural turns land on bar lines [verified: measured].
- **Few sound effects, and they are pitched**: a short upward-gliding blip when
  objects pop in, the closing stickers matching 6/6 within 0.1 s; only 1 of 5
  act changes has a whoosh; the whip into the empty canvas has a riser plus a
  downward pitch glide; a shimmer when the logo appears. No effect could be
  measured for typing or clicks, and there is no narration [inferred].
- Loudness: **−15.5 LUFS integrated, true peak −1.5 dBTP, LRA 7.2 LU**
  [verified].
- The typed request (the prompt) runs at about 55 cps.

---

## 1. Method and limits

| Item | Method |
|---|---|
| Cut points | `ffmpeg select='gt(scene,0.25)',showinfo`, and at 0.10 → 0 cuts; scene score listed for every frame, maximum 0.059 at 46.83 s |
| Frame-difference curve | OpenCV at 480×270 greyscale: per-frame mean absolute difference and the share of pixels that change by >0.04; change density and still stretches computed from it |
| Viewing | 8 contact sheets at 4 fps (each 1796 px wide) + dense frames at 12/24 fps at key points + full-resolution single frames |
| This tool's own measurements | `film beats`, `film listen` and `film probe --text-every 0.25` all accept an external mp4 [verified] |
| Audio | librosa: tempogram, per-band onsets, Krumhansl key estimate, HPSS, band energy; zoomed spectrograms marked with the picture events; 2–10 kHz spectral flatness to find whooshes; correlation between picture change and loudness; ffmpeg `ebur128=peak=true` and `astats` |
| Beat alignment | 35 hand-marked picture events (frame accuracy ±1 frame = ±42 ms); offsets measured against onsets / the 0.325 s beat grid / 0.649 s / 2.6 s bars, with a chance baseline from 4000 random time points |

Limits:
- The source is YouTube's transcode (24 fps; the AAC may carry a priming offset
  of about 20–40 ms, which puts a little error into the beat-alignment figures)
  [uncertain]. The version seen on Threads may be a different crop or a
  different mix; the Threads original was not available to compare [uncertain].
- "No narration" can only be judged from the spectrum [inferred].
- "Sound effects" and "music" can only be told apart by spectral shape plus
  coincidence in time; there are no stems [inferred].

---

## 2. Stretch by stretch (timecodes to 0.1 s)

Narrative codes: H = hook, C = context / chapter, A = action in the demo (making
a request), R = demo result / proof, S = social proof (teammates), K = claim, E
= ending.

| Stretch | Time (s) | Length | Picture | On-screen text (verbatim; UI text only where it matters) | Function | Narrative |
|---|---|---|---|---|---|---|
| A | 0.0–2.5 | 2.5 | Warm-white empty stage, a small pill label; at 0.42 the Claude cursor (terracotta arrow + name pill) flies in and its name pill parks beside the pill label; 0.67–1.42 an insertion point types large serif letters at about 12 cps (the letter just typed is in the cursor's color, slowly cooling to ink); 1.75 the cursor leaves; 1.75–2.45 hold | `New in` + name pill `Claude` + `Artifacts` | Artifacts umbrella brand | H |
| B | 2.5–4.7 | 2.2 | 2.46–3.4 the letters of "Artifacts" turn one by one, left to right, into 7 artifact-type icons (document, slides, table, palette, bar chart, shapes, motion circle), about 12 per second; 3.7–4.4 hold | (no text) | Product family | C |
| C | 4.7–6.6 | 1.9 | From 4.67 the icons disappear one by one from right to left; from 5.1 "Plan it out with" is dragged in by the Claude cursor as a whiteboard object (tilted about −10°, straightening to 0° over ≈1.5 s); at 5.75 "Claude Whiteboards" is dragged in by the Mia cursor; 6.0–6.4 the whiteboard icon drops onto the top of the title; 6.3 the Rosa cursor enters; the whiteboard grid fades in behind | `Plan it out with` / `Claude Whiteboards`; name pills `Claude` `Mia` `Rosa` | Whiteboards chapter | C |
| D | 6.6–9.5 | 2.9 | The title holds, three cursors drift; 7.3–8.3 Rosa's name pill grows into a chat bubble; 8.5–9.4 the cursors leave one after another | `Soooo cool!` | Collaboration | C/S |
| E | 9.5–13.8 | 4.3 | 9.58 an avatar pin "MK" appears → 9.8–10.8 it grows into a comment box, with a push-in at the same time (zoom about ×1.07, moving down-left); 10.9 types `@Cl`, 11.15 it becomes an @Claude chip; 11.3–13.28 types 103 characters at an average of about 55 cps; 13.28–13.79 holds 0.5 s | In the box: `Whiteboard`, `Ask Claude to edit` (placeholder) → `@Claude Lay out an illustrated timeline for the Huckleberry Pie launch, from locking the flavor to holiday delivery.`, `☑ Send to Claude` | @Claude on the whiteboard | A |
| F | 13.8–15.5 | 1.7 | 13.79–14.8 the whole picture whips out to the left (pressing send is not shown); 14.8–15.4 empty grid, the Claude cursor enters from the right | (none) | Passage | (bridge) |
| G | 15.5–19.0 | 3.5 | 15.5 Claude starts drawing a path → Day 1 → sticky notes and illustrations pop in one by one (15.93, 16.18, 16.26, 16.43, 16.51, 16.76, 16.94, 17.65, 17.90, 18.20, 18.65, 18.83; mean interval about 0.26 s); 15.9–18.6 the camera pulls out to ×0.54, revealing the whole product window | Window: `Artifacts` tab, `Huckleberry Pie: Launch Timeline`, `Share`, `100%`, toolbar `Ask Claude`; on the board: `Huckleberry Pie: Launch Timeline` / `GeeGolly Good Pies: locked flavor to holiday delivery in 12 days`; `Lock flavor / Huckleberry it is`, `Lock pricing / What's a pie cost?`, `Build pre-order forecast / How many pies?`, `Place Huckleberry order / 23 tons`, `4 days on the road`, `Huckleberries arrive / In Kansas City`, `Recipe test / Rosa: 12 pies, then 500`, `Bake / 10K a day, full line`, `Holiday delivery / 48 states in 2 days` (map: Kansas City bakery, Reno, Allentown, Atlanta, `65,000 boxes / Dev: frozen 48 hours in the mailer`), `Allergen label waits on the locked recipe`, Day 1/2/3/7/8/10/12 | Claude draws an illustrated timeline | R |
| H | 19.0–21.8 | 2.8 | The whole board holds (the picture barely moves); June and Dev enter, Dev's name pill becomes `Perfect!`; Rosa presses Ask Claude and a `Describe a change` input appears; stickers (heart, badge, party popper) drop in one after another | `June` `Perfect!` `Rosa` `Describe a change` | Teammates editing together | S |
| I | 21.8–23.0 | 1.2 | 21.75–22.6 the whole board is pushed out to the left; 22.6–23.0 the next title card goes from faint to solid, the background becomes spreadsheet rows | `Build it with` / `Claude Sheets` | Sheets chapter | C |
| J | 23.0–25.5 | 2.5 | The title holds; at 23.92 a grey user bubble pops in whole (not typed) | `Draft a forecast for pre-orders. Reference last year's numbers from the Historical tab.` | Calling on Sheets by chat | A |
| K | 25.5–27.0 | 1.5 | 25.5 Claude's reply appears (serif), and at the same moment the title behind it goes out of focus (a focus pull); 26.5–27.1 a fast pull-out: the big bubble becomes a small bubble in the chat column on the left of the app window | `You got it.` | Reply | R |
| L | 27.0–29.1 | 2.1 | Chat column + sheet; the chat history **still holds the whiteboard request**; a faint shimmer on the status line; 28.38 the Claude cursor types `Channel` in A1, 28.9 types `Website` | `GeeGolly Good Pies launch`, `Lay out an illustrated timeline…`, `Laid out eight milestones from Day 1 to Day 12.`, `You got it.`, `Reading last year's numbers from the Historical tab. 1s`, `Holiday Pie: Pre-orders` | Sheets gets to work | R |
| M | 29.1–32.0 | 2.9 | 29.1–29.5 the chat column slides out and the sheet goes full width; formula bar; 29.9–30.6 the columns fill in one by one (blue = conservative, green = optimistic, yellow = difference), then "What it means"; 31.0–31.9 Dev and Rosa select cells | `=SUMIFS(Historical!C:C, Historical!A:A, A2)`, `=F10-D10`; `Channel / 2025 actual / Conservative growth / Conservative / Optimistic growth / Optimistic / Difference`; `Website 21,000 +10% 23,100 +30% 27,300 +4,181`…`Total 50,000 +6.8% 53,153 +25.8% 55,475 +4,213` (values at 31.0 s); `What it means`, `Days on the full line, at 10K a day 3.7`, `Boxes left, of 65,000 4,887` | Formulas, scenario forecast, several people at once | R/S |
| N | 32.0–32.8 | 0.8 | 31.96–32.75 the sheet is pushed out to the left → title card | `Share a story with` / `Claude Data` | Data chapter | C |
| O | 32.8–36.3 | 3.5 | The title sits in the left 1/3 and the dashboard builds itself on the right: KPI number rolls (33.5–34.5, from 11,74x up to 58,500; the count is not driven by anything on screen [verified]), a line chart draws, table and bars appear row by row; 35.3 the title exits left; 36.0–36.3 the whole dashboard is in place | `Pre-orders 58,500 / +8,500 on last year`, `Vs last year +17% / 50,000 last year`, `Top flavor this week Huckleberry / 4,100 pre-orders`, `Boxes left 6,500 / Of 65,000 printed`, `Pre-orders, this year vs last / Running total by week, all flavors`, `Pre-orders by flavor / This week, 11,700 across five flavors`, `Holiday pre-orders / All flavors · Season to date`, `Updated now`, `GEEGOLLY GOOD PIES` | Certified live data | R |
| P | 36.3–39.1 | 2.8 | A **black system cursor** (a person) moves to the palette icon and clicks at 37.3, with a push-in ×1.34 at the same moment; 37.6 the Design panel slides in; 38.92 clicks Scrollyteller (turns purple) | `Design` / `Claude redoes this dashboard in the format you pick, on the same data. You get a draft to save or cancel.` / `Scrollyteller` / `Visual short` | Changing the presentation format | A |
| Q | 39.1–43.5 | 4.4 | 39.1–39.4 cross-fade + zoom into a scrollytelling draft; 40.9–41.3 and 42.0–42.7 two scrolls, bars and lines grow as it scrolls | `Draft. Only people who can edit can see it until you save.` `Save`; `All queries on this dashboard are certified`; `Holiday Pies: Pre-order Sales` / `58,500 pre-orders so far, up 17% on last year. Huckleberry led the week, and 6,500 boxes are left.` / `Scroll ↓`; `Huckleberry was the #1 pre-ordered pie this week` / `4,100 of this week's 11,700 pre-orders, ahead of Apple, Pumpkin, Pecan and Cherry.`; `Pre-orders are up 17% vs last year` / `58,500 so far this season, against 50,000 at the same point last year.` | Data story | R |
| R | 43.5–45.8 | 2.3 | 43.5–44.3 push in to the top-right corner (about 2–3×); 45.1 hover, at about 45.5 clicks Share | Avatars J R D + Claude starburst, `Share` | Sharing | A |
| S | 45.8–48.0 | 2.2 | 45.79 about 22 third-party product icons burst out and fly toward the camera, blurrier the closer they come (probe: zoom ×6.7) | Legible names: `snowflake`, `databricks`, `Airtable`, `HEX`, plus icons for Excel, Asana, monday.com, Miro, Grafana, Amplitude, Smartsheet and others | Ecosystem / integrations (no words explain it) | K |
| T | 48.0–51.8 | 3.8 | 48.0–48.2 one line fades in; 49.29 Claude selects the first word; 50.00 / 50.58 / 51.17 word swaps; 51.7 deselects | `Plan at the speed of thought` → `Build …` → `Share …` → `Work at the speed of thought` | Gathering up the three verbs | E |
| U | 51.8–54.3 | 2.5 | Claude exits left; Rosa 51.8, Mia 52.6, Dev 52.8, June 53.3 enter; stickers 52.88 heart, 52.94 light bulb, 53.06 heart, 53.52 +1, 53.94 megaphone, 54.15 lightning bolt | Name pills `Rosa` `Mia` `Dev` `June` | Teammates stamp it | S/E |
| V | 54.3–55.3 | 1.0 | 54.25–54.45 everything gathers upward into a single point → 54.5 it grows into the Claude starburst (rotating) → 55.0–55.3 the wordmark writes on from left to right | `Claude` | Brand | E |
| W | 55.3–57.8 | 2.5 | Hold, with a very slight motion (about 0.2 % of pixels change per frame); complete silence from 57.05 | `Claude` | End card | E |

---

## 3. Story structure

**How the three products are strung into one line** [verified]
- One invented client project, "GeeGolly Good Pies' holiday launch of the
  Huckleberry Pie": plan (whiteboard timeline) → build (pre-order forecast
  sheet) → share (dashboard → data story → Share). These three actions are also
  the three verbs of the chapter cards: Plan it out / Build it / Share a story.
- **Figures carry across products**:
  - The whiteboard map says "65,000 boxes", the sheet says "Boxes left, of
    65,000", the dashboard says "Of 65,000 printed".
  - The whiteboard says "Bake 10K a day", the sheet says "Days on the full line,
    at 10K a day".
  - The sheet's "2025 actual" totals 50,000; the dashboard says "50,000 last
    year" and "+8,500 on last year".
- **The conversation carries across products too**: the Sheets chat history
  still holds the whiteboard request, together with Claude's reply "Laid out
  eight milestones from Day 1 to Day 12." (frame at 28.4 s).
- **The people carry over**: teammates are not only cursors; their names are
  written into the content too ("Recipe test — Rosa: 12 pies, then 500", "Dev:
  frozen 48 hours in the mailer"); the avatars at the top right of the sheet and
  the dashboard are R, D, J.

**The first 3 seconds** [verified]: warm-white empty stage → at 0.42 s the
Claude cursor enters, and **its name pill is itself the "Claude" of "New in
Claude"** → the insertion point types "Artifacts" → 1.75 s the cursor leaves →
2.46 s the title's letters turn into 7 artifact-type icons. In the first 3
seconds there is no logo and no product screen, only the lead (the cursor) and
the umbrella idea (Artifacts is a family). The icon row doubles as a table of
contents: the icons above the three later chapter cards (shapes, green table,
red bar chart) all come from it.

**How many seconds each feature gets, and which "one action → one result" proves
it** [verified]

| Chapter | Time | Length (share of film) | Action | Result | Action to first result |
|---|---|---|---|---|---|
| Opening | 0–4.7 | 4.7 s (8 %) | The cursor types | The title becomes the product family | — |
| Whiteboards | 4.7–21.8 | 17.1 s (30 %) | One sentence typed on the whiteboard with an @mention (finished at 13.28) | Claude draws a 12-item illustrated timeline within 3.3 s; teammates respond | 2.2 s, bridged by a whip + riser |
| Sheets | 21.8–32.0 | 10.2 s (18 %) | One chat bubble (23.92) | "You got it." → a forecast sheet with formulas, colored by scenario | 1.6 s to the reply, 4.5 s to the first cell |
| Data | 32.0–45.8 | 13.8 s (24 %) | Clicks Design → Scrollyteller (38.92) | The same data remade as a scrolling data story | 0.43 s |
| Ecosystem | 45.8–48.0 | 2.2 s (4 %) | Clicks Share (about 45.5) | About 22 third-party icons fly past the camera | 0.3 s |
| Ending | 48.0–57.8 | 9.8 s (17 %) | Claude selects words and swaps them | "Work at the speed of thought" → logo | — |

The three acts each use **a different input gesture**: an @mention typed on the
whiteboard, a chat bubble, a button click. No action is used twice. Both
boundaries from a product to the next chapter card (into Sheets, into Data) are
a whole-frame push out to the left, while the three entries into a product each
differ (dragged in by cursors, a bubble shrinking into the chat column, a
dashboard growing beside the card) [verified].

**How the ending closes** [verified]: in one line only the first word is swapped
(Plan → Build → Share → Work, 0.72 / 0.58 / 0.58 s apart) → teammate cursors
enter one after another and stamp stickers on the line → everything gathers into
a point → the point becomes the Claude starburst → the wordmark writes on → hold
2.5 s, with no fade to black: the film ends holding on the wordmark [verified].
The closing line is itself a recap of the three acts, so no list of features is
needed.

**Objects or motifs that run through the whole film** [verified]
1. The Claude cursor and its insertion point: it types the opening, drags in the
   first title, draws the whiteboard, fills the sheet, selects the words to
   swap, and finally leaves, with the logo taking over.
2. Named teammate cursors (Mia, Rosa, Dev, June, MK): in every act.
3. The pie company's project and its figures.
4. The three verbs.
5. The artifact icon family.

The cursor is carried all the way to the end; the film's last frame, however, is
the brand wordmark, not something it made [verified].

---

## 4. How the product is shown

- **Real UI, rebuilt, or mixed?** [inferred] It is high-fidelity product UI (the
  full window chrome: `Artifacts` tab, document name, avatars, `Share`, zoom
  `100%`, toolbar, formula bar, certification badge), with the content and the
  actions choreographed for the film. My judgment is "rebuilt from the real
  design, then animated", not a straight screen recording, because:
  - every element has its own spring-like pop-in;
  - numbers count up like an odometer (33.5–34.5 s);
  - the blocking of the 6 cursors is clearly choreographed;
  - the prompt is typed at about 55 cps, far beyond a human hand;
  - every pushed-in view is sharp.

  But I cannot rule out "the real product, driven by a script" [uncertain].
- **How much detail is kept, and how large** [verified, measured]:
  - The whiteboard window takes about 85 % of the frame width (20.0 s: x
    135→1775), the sheet about 90 % (31.0 s), and the dashboard fills the frame
    or even runs past it.
  - Detail is made readable by pushing in: the Design panel is pushed to ×1.34,
    its body text about 40 px in line height; the prompt's text stands ≈45 px
    tall after the push-in; the Share corner about 2–3×.
  - Text in the full-frame product shots (probe OCR line height) is about
    20–28 px, which on a 390 px-wide phone is only 4–6 px: **unreadable, and not
    meant to be read**; text that is meant to be read is always pushed in large.
- **3D / perspective**: no perspective tilt anywhere in the film. Only flat
  scaling and panning, and the 2.5D of stretch S, "logos flying past the camera"
  (scaling plus depth-of-field blur) [verified].
- **Whitespace and background**:
  - Stage ground RGB (249,246,243) ≈ `#F9F6F3`, a warm white [verified].
  - The "ink coverage" (non-light pixels) of the chapter cards is only 1–3 %;
    product shots 5–26 % (counted as RGB distance >12 from the ground).
  - Each chapter card's background changes to that product's ground pattern: a
    grid for the whiteboard, horizontal rows for Sheets, plain for Data.
- **Colors** [verified, sampled]:
  - Claude terracotta (214,117,84); teammates Mia magenta (197,88,153), Rosa
    teal (10,123,115), Dev blue (56,109,210), June green (60,144,79).
  - The client brand: dark green (28,88,65) with pink.
  - Illustrations mostly yellow and orange sticky notes.
- **Type** [inferred; typeface names not identified]: the film's own words
  (titles, closing line, wordmark, the enlarged "You got it.") use a
  transitional serif in two weights; product UI and user messages use a
  sans-serif. Sizes by probe's OCR line height: chapter cards 59–69 px, closing
  line 87–98 px, end wordmark 114–120 px; median across the film 45 px, median
  share of the frame covered by text 6 % [verified: `film probe`].
- **How the cursors are drawn** [verified]:
  - Collaboration cursors: a small solid triangular arrow (about 20 px) with a
    rounded name pill at its lower right (white text on that person's color).
    The pill can turn into a line of chat (`Soooo cool!`, `Perfect!`).
  - MK is an avatar pin, not an arrow.
  - In the Data act a "person" operates, and the cursor becomes the standard
    black system arrow (white outline, about 45 px in the pushed-in shot).
  - When Claude types, the insertion point is terracotta, and new letters start
    terracotta and cool to ink (the gradient is visible in the frame at 1.3 s).

---

## 5. Rhythm

**Shot and stretch lengths** [verified]
- Shots: 1 (no hard cut). Probe measured 59 camera moves with 14 reversals of
  direction [verified]. Probe also found 11 small one-frame jumps (2–12 % of the
  frame, e.g. word swaps, pop-ins), 11.4 per minute.
- Stretches: 23, 0.8–4.4 s, median 2.5 s, mean 2.51 s; only E (typing the
  prompt, 4.3 s) and Q (the data story, 4.4 s) run over 4 s.

**How often something changes (change density)** [verified: per-frame difference
curve]
- Frames with visible change (changed pixels >0.2 %): **73 %**.
- Fully still stretches of ≥0.5 s: only 14, 8.5 s in all (15 %); **the longest
  is 0.79 s** (11.25–12.0, during typing). Even the end card has about 0.2 %
  micro-motion per frame.
- Intervals between dense arrivals: 12 whiteboard items, one every 0.26 s on
  average; 6 closing stickers, one every 0.21 s (intervals 0.1–0.3 s); the
  sheet's columns fill in at about one every 0.15 s. Across the film, pop-ins
  come 0.21–0.28 s apart [verified].
- **Each act is busier than the one before; only the close calms down** (mean
  share of changed pixels per frame):

  | Stretch | Mean changed pixels | Frames with change |
  |---|---|---|
  | Opening | 0.33 % | 54 % |
  | Whiteboards | 2.1 % | 73 % |
  | Sheets | 3.2 % | 76 % |
  | Data | 5.4 % | 88 % |
  | Logo burst | 9.7 % | 100 % |
  | Closing line | 1.2 % | 61 % |
  | End | 0.4 % | 35 % |

**Holds** [verified]

| What holds | Time | Length |
|---|---|---|
| "Artifacts" typed | 1.75–2.45 | 0.7 s |
| Whiteboard chapter card (cursors still moving) | 6.6–9.5 | 2.9 s |
| Prompt finished | 13.28–13.79 | 0.5 s |
| Finished whiteboard (teammates still moving) | 19.0–21.75 | 2.75 s |
| Sheets card | 23.0–25.5 | 2.5 s (bubble from 23.9) |
| Data card | 32.75–33.3 | 0.55 s still (then the dashboard starts growing on the right; the card stays until 35.3) |
| Whole dashboard | 36.0–37.1 | 1.1 s |
| Scrollyteller first screen | 39.4–40.9 | 1.5 s |
| "Plan at…" | 48.2–49.3 | 1.1 s |
| Word swaps | — | 0.58 s each |
| "Work at…" (teammates moving) | 51.17–54.3 | 3.1 s |
| End card | 55.3–57.75 | 2.45 s |

**How many words appear at a time, and for how long** [verified]
- The film's own words come to about 30 English words in all: opening 4 words,
  the three chapter cards 6 / 6 / 7 words, closing line 6 words (with 3 word
  swaps), wordmark 1 word.
- Chapter cards appear with both lines at once (not word by word). They hold
  2.5–2.9 s; the last line holds 3.1 s.
- Long sentences always sit inside the product UI:
  - the whiteboard prompt, 18 words, **is read while it types**; once finished
    it holds only 0.5 s;
  - the Sheets bubble, 13 words, holds about 3 s;
  - the Design panel's description, 21 words, holds only 1.5 s and is not
    expected to be read in full.
- Typing speed [verified: characters counted every 0.125 s]:
  - "Artifacts": 9 letters in 0.75 s, about 12 cps (one letter every 2 frames);
  - the prompt: the @mention becomes a chip within 0.25 s, then 103 characters
    in 1.875 s, **about 55 cps on average** (about 40 cps over the first 0.5 s,
    about 75 cps after that, arriving in word-sized chunks).

---

## 6. Sound

### 6.1 The music, described objectively
- **Tempo** [estimated]:
  - Basic pulse 0.325 s: `film beats` reads 185 BPM, confidence 0.7, with an
    onset within 40 ms of 85 % of the beats.
  - librosa's tempogram candidates, in order: 184.6, 123.0, 92.3, 73.8 BPM. The
    autocorrelation peak of the low end (kick) in the main section is at
    **0.650 s (92.3 BPM)**.
  - Every period is a whole multiple of 0.1625 s (2, 3, 4, 5, 7, 8 times), which
    means syncopation on a 16th-note grid.
  - Whether it is felt as 185 or 92 BPM I cannot judge; this report describes it
    as "a 0.325 s pulse, a 2.6 s bar (8 pulses)", **with the phase set by the
    drop at 15.62**.
- **Key** [estimated]:
  - Intro (0–15.5): Krumhansl correlation D major 0.84, B minor 0.62;
  - Outro (51.95–57.05): B minor 0.72;
  - Main section only 0.34 (F# minor); the drums contaminate the chroma,
    **uncertain**.
  - Conclusion: roughly D major / B minor (two sharps), medium confidence.
  - `film listen`: the whole track sits at A440 −6 cents; 78 % of pitched frames
    in the low range and 74 % in the mid range are within 15 cents (no "notes
    between the notes" problem).
- **Spectrum** [verified]: median librosa spectral centroid, intro 1850 Hz, main
  section 2053 Hz, outro 1382 Hz. `film listen` gives 565 / 174 / 902 Hz; the
  algorithms differ, so only the relative sizes count: the main section is
  heaviest in the low end.
- **Band energy** (mean dB per 0.5 s, relative values):

  | Band | Intro | Riser | Main (before 34 s) | Main (after 34 s) | Breakdown | Outro |
  |---|---|---|---|---|---|---|
  | 30–80 Hz | 5.0 | 11.9 | 39.6 | 40.8 | −0.3 | 2.7 |
  | 80–250 Hz | 15.1 | 16.7 | 36.2 | 35.7 | 21.5 | 19.6 |
  | 250–2k | 35.1 | 36.1 | 37.5 | 34.0 | 31.9 | 30.1 |
  | 2–6k | 19.8 | 26.4 | 25.6 | 25.8 | 11.5 | 12.5 |
  | 6–11k | 12.7 | 18.6 | 20.4 | 20.2 | −2.9 | 2.1 |

  → The intro has **almost no sub (about 35 dB below the main section)**, while
  the mid-range melody and harmony are there from start to end; the main section
  adds kick, sub-bass and hats; the breakdown takes out all of the sub and the
  air.
- **Timbre** [inferred]: from the spectrum, the intro is short-decay plucked or
  mallet-type chords (neat stacks of partials, 6–8 notes per second); the main
  section's kick is a "J"-shaped low end falling in pitch; the breakdown has a
  lead line at about 1–1.3 kHz with glides. I cannot hear it; this is a judgment
  from shapes only.
- **Not a loop**: `film listen` finds **0 of 44 bars repeated verbatim** (band
  energy within 1.5 dB and correlation ≥0.95) [verified].
- **Dynamics** [verified]:

  | Measure | Value |
  |---|---|
  | integrated | −15.5 LUFS |
  | LRA | 7.2 LU (−20.8 → −13.6) |
  | true peak | −1.5 dBFS |
  | momentary 400 ms | p10 −22.7, median −15.4, p90 −13.4 LUFS |
  | crest | 15.1 dB (peak to RMS) |
  | median RMS | intro −23.3, main section −16.3, outro −28.0 dBFS |
  | stereo (L/R correlation, side against mid) | intro 0.96, −17 dB (nearly mono); main section 0.87, −11 dB |

### 6.2 Section structure: when things come in, add layers, and leave
(Bar lines = 0.05, 2.65, 5.24, 7.84, 10.43, 13.03, **15.62**, 18.22, 20.81,
23.41, 26.00, 28.60, 31.19, 33.78, 36.38, 38.98, 41.57, 44.16, 46.76, 49.35,
**51.95**, **54.54**, 57.14)

| Time | Sound (measured) | Picture at the same time |
|---|---|---|
| 0.05–15.62 (6 bars) | Intro: no low end, mono, plucked chords | Title, icons, whiteboard card, comment box, prompt |
| 11.02 | Low-end hits 6.3→10.3 per s, mid-range 3.7→8.3 per s (`film listen` "changes") | 10.9 the prompt starts typing |
| 14.0–15.6 | 2–10 kHz airy rise (+7 to +9 dB, 14.25–14.75); 14.8–15.6 a whole set of partials glides down in pitch together; from 14.19, 40–159 Hz comes in (+18 dB) | 13.79 whip out, empty canvas, Claude enters |
| **15.62** | **Drop**: kick + sub come in, level +7 dB | 15.5 Claude starts drawing the path (0.12 s apart) |
| 34.03 | The low pulse doubles (one hit per 0.65 s → per 0.33 s) | 33.3–36.3 the Data dashboard builds itself |
| **51.95** | Drums and bass leave (52.44: 40–142 Hz −22 dB, 564 Hz–1.6 kHz +10 dB), the lead remains | 51.7 the word swap settles, 51.8 teammates enter |
| **54.54** | Hits drop sharply (`film listen` rates it the biggest change in the film) | 54.5 the Claude starburst appears |
| 55.7 | Last chord; silence follows 1.1 s after the wordmark | The wordmark finishes and holds |
| 56.1–57.05 | A sharp fall, then the tail; below −50 dBFS from 57.05 | End card |

→ The four turns of the arrangement (drop, doubling, drums out, logo) all match
turns in the story, and three of them land on 2.6 s bar lines (15.62, 51.95,
54.54). The chapter cards' appearance times (6.6, 22.6, 32.75) are **not** on
bar lines [verified: measured / estimated].

### 6.3 Kinds of sound effect and the picture events they go with [inferred; basis = shape in zoomed spectrograms + coincidence in time]

| Sound (spectrum) | Time (s) | Picture event | Basis |
|---|---|---|---|
| Short upward-gliding blip, about 300→600/900 Hz, 60–80 ms | 16.20, 16.60, 16.95, 18.25, 18.70 | Sticky notes / illustrations pop in, 16.18–16.26, 16.51–16.76, 16.94, 18.20, 18.65 | Zoomed spectrogram marked with the picture events; about 5 of the 12 pop-ins within 50 ms |
| Same | 52.88, 52.98, 53.07, 53.62, 54.00, 54.22 | Stickers 52.875, 52.94, 53.06, 53.52, 53.94, 54.15 | Zoomed spectrogram marked with the picture events; **6/6** within about 0.1 s |
| Airy rise + a whole set of partials gliding down (riser / downlifter) | 14.0–15.6 | Whip to the empty canvas → Claude starts work at the drop | Spectrogram; 2–10 kHz spectral flatness: 14.25–14.75 +7 to +9 dB |
| Noise whoosh, 2–10 kHz flatness 0.46–0.48, +6 to +8 dB | 22.45–23.2 (≈0.7 s, strongest as the next card settles) | Whiteboard pushed out → Sheets card settles (22.6–23.0) | One of the 3 stretches found by searching for noise swells |
| Weak noise swell, flatness 0.32–0.39, +6 to +7 dB | 45.75–46.0 | Logo burst 45.79 | Uncertain; may be the arrangement itself |
| High shimmer, 4–10 kHz, flatness 0.38–0.39 | 54.6–54.9, 55.1–55.5 | Starburst 54.5, wordmark 55.0–55.3 | Spectrogram; very clear in the quiet stretch |
| Low thud / glide | 2.65–2.75, 3.2–3.3, 6.0–6.3 | Letters turning into icons (2.46–3.4), whiteboard icon dropping (6.0–6.4) | Uncertain; may be bass notes |
| (none found) | 0.67–1.42, 10.9–13.28 | The two typing passages | High-frequency onset rate while typing 3.7/s, against 4.8/s in 6.6–9.5 before the typing, so no increase → no keyboard sound can be measured |
| (none found) | 37.3, 38.92, about 45.5 | The three clicks | No onset at all within 60 ms either side of 38.92; at 37.3 and 45.5 only onsets that coincide with the music's beats |
| The Sheets act change (31.96), the Data act change, the scrollyteller cross-fade (39.1) | — | — | High-frequency flatness does not rise → no whoosh |

**Narration**: none [inferred]. The spectrum shows no speech-formant patterns,
and the official description has no narration text.

### 6.4 How many cuts and transitions land on the beat [verified: measured, event times ±1 frame]
35 picture events (arrivals, clicks, word swaps, the start of each move):

| Reference | Within ±42 ms | Chance baseline | Within ±83 ms | Chance baseline |
|---|---|---|---|---|
| Music onsets (6.6 per s) | 60.0 % | 53.2 % | 88.6 % | 88.1 % |
| 0.325 s beat grid | 31.4 % | 25.9 % | 51.4 % | 52.0 % |
| 0.649 s (half-time beat) | 17.1 % | 12.1 % | 34.3 % | 26.0 % |
| 2.6 s bar lines | 0 % | 2.8 % | 8.6 % | 6.7 % |

→ Overall about the same as chance: **small events are not on the beat**. The
only ones that are:
- Claude starts work 0.12 s before the drop;
- 38.92, clicking Scrollyteller (−0.06 from the bar line);
- 49.29, selecting "Plan" (−0.06);
- 54.5, the starburst (−0.04);
- of the word swaps, "Build" is exactly on the 0.649 beat (−0.002), but the next
  two drift off step by step (−0.068, −0.132), because the interval is 14 frames
  (0.583 s), not one beat (0.649 s).

Also, the Spearman correlation between picture change and loudness, per 0.5 s:
0.33 over the whole film (p<0.001), 0.22 inside the main section (p=0.057). The
5 loudest half-seconds and the 5 busiest half-seconds that `film listen` lists
**do not overlap at all**:
- 18.5–21.5 the picture is almost still, yet the sound is at −13.8 LUFS;
- 9.5–11 and 13.5–16 the picture is at its busiest, and the sound is lighter.

→ The sound follows the acts, not the frames; at the loudest moment of the film
the picture is holding on the finished whiteboard.

---

## 9. Uncertain, to be confirmed

- Whether the UI is "motion graphics rebuilt from the design" or "the real
  product, scripted and recorded": needs a statement from the makers, or a
  comparison with the real product [uncertain].
- Whether the "sound effects" above really are separate effects or sounds inside
  the arrangement: needs stems, or confirmation by ear [uncertain].
- Whether it is heard as 92 or 185 BPM: needs a human ear [uncertain].
- Whether the Threads version is the same edit and mix as the YouTube version:
  the Threads original could not be obtained [uncertain].
- The beat-alignment figures are affected by the hand-marking of events
  (±1 frame) and the possible 20–40 ms AAC offset; the conclusion "small events
  are about the same as chance" is not sensitive to this error, but do not read
  too much into individual events' offsets at the millisecond level.
