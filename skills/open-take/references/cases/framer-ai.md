# Framer AI launch film — an external reference

Framer's 85.5 s launch film for its AI site generator (public on YouTube,
`BSRkq1UCda0`), made by people, not by open-take. It is here because it is the
launch film the project's owner liked best of the human-made ones he watched,
and because it is built differently from every film above: it never shows a
whole page for long, the cut density changes a lot from section to section,
and its richness comes from the many different things the product made.

**The comments it got** (the owner, 2026-10-05, after watching five human-made
launch films; not blind):

> 我只覺得Framer AI的很好，就是他快速切換搭配聲音的感覺是我很喜歡的(但這可能是個人喜好)，而且他內容很豐富，配樂也很有層次(不過內容豐富度可能也跟該次launch的功能數量有關？)

> framer比起我們內容就豐富很多(但應該也不用到他們那麼多 就是有內容有故事我覺得就可以) 也很有節奏感(這點我覺得滿重要)

(Translation: "I just think Framer AI's is very good — the feeling of quick
switching together with the sound is something I really like (but that may be
personal taste); its content is very rich and the music has a lot of layers
(though the richness may have to do with how many features that launch had)."
/ "Framer's content is much richer than ours (but we probably don't need that
much — content and a story are enough, I think) and it has a strong sense of
rhythm (which I think matters a lot).") He described what he liked; he did
not ask for its density or its look.

## Structure: manifesto → product action → bursts and breaths → montage → logo

Measured on the published file (ffmpeg scene score, hard cut ≥ 0.30): 74 cuts,
51.9 a minute; median gap 0.85 s; one gap in ten under 0.17 s; several holds
over 2 s; no cut at all in the first 11 s. Five-second counts:
`0 0 3 2 10 9 9 6 10 2 1 1 2 8 5 4 2 0`.

| Time | Wants to express | Moves | Holds | Handoff / cuts | Sound |
|---|---|---|---|---|---|
| 0–11 | what changed: "for close to a decade… it doesn't just work, it writes, it designs, it builds" | words appear one or two at a time on a soft gradient, size changing with emphasis ("work", "a decade" large) | the gradient | **no cuts**; words replace words in place | voice-over and track; each word on the voice |
| 11–20.6 | you start with one button and one sentence | the real editor, small → a big "Start with AI" button; a prompt box types "…photographer from Amsterdam"; Start clicked | the gradient behind | cuts at 11.1, 12.2, 14.3, 18.6, 19.5 | — |
| 20.6–27.6 | it builds a site from that | a generated page assembles itself section by section (headline grows word by word, list rows add one at a time); then a burst through other generated pages | — | **five cuts 0.1 s apart at 21.5–21.9**; ten more 24.2–26.2 | the track's busiest stretch |
| 27.6–38.3 | it is generated, then human-curated; you choose the fonts | "Ge → Gene → Genera → Generated" grows letter by letter; "Human curated"; tilted 3D cards of one page re-rendered on each real Shuffle click | — | cuts ~0.25 s apart at 31.9–33.0, then 33.8–37.1 | — |
| 38.3–49.3 | find font combinations, see every breakpoint; "You are the art director" | a title card whose words flick into a display face; desktop / tablet / phone previews | the title cards | **nine cuts ~0.2 s apart at 42.9–44.8** | — |
| 49.3–64.4 | your personal copywriter | a paragraph rewrites itself in place, longer, shorter; a joke prompt "Take over the world. Oops, I mean, Rewrite this"; the CEO types "Make the web more creative" (name on screen) | long holds on single text blocks | sparse: 52.4, 58.1, 60.0 — a breath | voice-over carries it |
| 64.4–76.5 | look at everything it made | a montage of generated sites, each a full-bleed hero (JAZZ AMSTERDAM, JORN, MIA, CINEMA, PLOUGHPOWER, IMPACT…) | — | **regular, about every 0.95 s** | steady pulse |
| 76.5–85.5 | sign-off | "your", "A" as huge single words → the logo on black | black | cuts 78.4, 78.9, 80.5, 80.9 | out |

The section shape in cut density: none → bursts → a quieter, text-led stretch
→ a regular pulse → out.

## Material

- **Real product interaction**: the editor, the prompt box, real buttons
  being clicked (Start with AI, Shuffle).
- **Real outputs, many of them**: generated sites in very different styles —
  most of the film's frames are things the product made, not the product's
  interface.
- **Type as picture**: the opening manifesto and section titles are set large
  on one recurring gradient that works as the film's "home" between bursts.
- **A person**: the CEO's voice and his own prompt.

## Measured sound (labels as `film listen` would give them)

- Loudness −7.1 LUFS, loudness range 2.5 LU (measured) — a commercial master,
  dense and level throughout; 6.3 onsets a second (measured).
- Tempo: 167 BPM detected with weak strength (.46); the grid that fits the
  cuts best is about 126 BPM (estimated).
- Cuts within 40 ms of an onset: 54 % against 49 % by chance; within 80 ms:
  93 % against 78 % (measured). Alignment to the beat is not what stands out.
- What changes between sections is how often the picture switches against a
  track that stays dense — not the music's loudness, and not pauses (6 % of
  the time quiet).

## Techniques worth seeing (descriptions only — no code exists for this film)

- **One thing at a time, big.** A button, a sentence, a headline, a single
  generated hero. Interface is shown at the size where its one relevant part
  fills the frame.
- **Words that build in place** (a headline growing word by word, a word
  growing letter by letter) — the product's "it writes" shown as typography.
- **Bursts of very short shots** of one kind of thing (generated pages,
  breakpoints) read as "a lot", without asking the viewer to read any one.
- **A breath** — the copywriting section slows to a few cuts in 15 s and a
  joke — between two bursts.
