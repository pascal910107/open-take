# Little Alchemy 2 — the product's own jokes, escalating

A 52 s, 1920×1080 film of Little Alchemy 2 (a browser game: combine elements
into new ones), made in October 2026 by Opus 5.5 writing its own film page.
The game already writes deadpan one-liners for every discovery; the film
writes no jokes of its own beyond short reactions — it lines the game's up so
they escalate, stops the music for one of them, and ends on scale.

**Brief it was given:** humorous and light — make people smile. Everything
else was the model's choice.

## Structure: setup → escalation → pause gag → escalation → scale → punchlines

Everything sits on the game's own purple sunburst, so even its cuts are soft
(measured: no change above 0.30; twelve above 0.12, at 11.9–35.7 s).

| Time | Wants to express | Moves | Holds | Handoff into next | Sound |
|---|---|---|---|---|---|
| 0–4.2 | you start with four things | "You get four things." pops; the four real icons drop in with squash and a thud; "That's the whole budget." | the line | cut to the game | the game's loop; thuds |
| 4.2–8 | drag one thing onto another | real game footage; fire dragged onto water | the board | the drop | the game's pick-up / drop sounds |
| 8–11.4 | it makes something new, and it jokes | fusion → steam reveal, camera 2×; the game's line "Hot air-sweats." enlarged; reaction "…it's like this the whole time." | — | cut | the game's charge-up and pop-up |
| 11.4–17.4 | keep adding water | per beat: two real icons collide (recipe below), cut to the real reveal — puddle, pond, lake | the backdrop | cut | game sounds per reveal |
| 17.4–20.8 | pond and lake define each other | pond and lake side by side, arrows chase in a loop; "Glad we cleared that up." | — | music returns | **the music stops dead**; two small clicks as the arrows chase |
| 20.8–28.4 | it gets absurd, then makes life | faster: lava → primordial soup → volcano → life "It finds a way."; "Uh-oh." | — | cut | the game's failure sound on "Uh-oh." |
| 28.4–35.7 | from a puddle to a human, even love | life + clay → human; "Twenty seconds ago, this was a puddle."; human + human → love; "Aww." | — | cut | — |
| 35.7–39.3 | 720 things to make | every icon in the game bursts from the centre and fills the frame; a counter 15 → 720 | the counter | cut | a run of the game's clone sound, getting denser |
| 39.3–46.1 | there is stranger stuff | three recipe cards with the game's lines: philosophy, cat, santa | — | cut | — |
| 46.1–52 | where, free | the game's logo pops; a URL button gets pressed; one last line; fade | — | fade | — |

## Material

- **Recording** of real play (open-take `make`, plus two screencast
  retakes for reveals the first take could not reach).
- **The product's own assets**: icons (all 720 for the burst), logo, font,
  colours, **its music loop and its sound effects** — nothing synthesized.
- **Real output as content**: the game's own description lines are the
  jokes; recipes checked against the official hint site.

## Techniques worth seeing

- **Silence as the punchline.** The game's loop gets a hard 30 ms stop for
  the pond/lake gag and comes back after it:

  ```js
  // the game's loop; it stops dead for the pond/lake gag, then picks up again
  if (t > G.start - .03 && t < G.end - .05) g *= Math.max(0, 1 - (t - (G.start - .03)) / .03);
  ```
- **Recipe beat, then reveal beat.** Each step is two parts on the beat —
  two icons colliding with the recipe underneath, then the game's real
  reveal — so the rhythm is the game's own loop of try / result.
- **The product's small text, made readable in place.** The game's line is
  ~16 px at 1080p; the film redraws the same words at 38–50 px in the same
  spot and colours, unchanged.
- **Scale as an explosion of the real inventory** rather than a number alone.

## Known limits (from its own notes)

- The real drag dropped frames in the recording; the drag second was redrawn
  with the game's own icon on a smooth arc and handed back to the recording
  at the drop.
- A clip cut on the game's own transition left a two-frame flash at 24.5 s.
