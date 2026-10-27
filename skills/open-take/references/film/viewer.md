## A first-time viewer

You made the film, so you know what every shot means and why it is there.
Someone who scrolls past it in a feed knows none of that. Before the master
is the last word, let someone who has not seen how it was made watch it:

```sh
npx open-take film viewer film.mp4
```

It writes `film.viewer/1/` — a copy of the film and `BRIEF.md` — and prints
how to start the viewer: an agent that has seen nothing of this work, given
only that brief. In Claude Code that is a subagent (the Agent tool) whose
whole prompt is `Read <path>/BRIEF.md and do what it says.`; anywhere else, a
fresh session in that folder (`claude -p < BRIEF.md`). The viewer watches
the film the only way an agent can — frames, sheets, the words on screen,
the sound — and writes `VIEWER.md` there: at which second it would scroll on
and why, what it did not follow, what bored it or felt forced, what was good.

Give it nothing of your own: not the plan, not your notes, not the product's
pitch, not what to look for. What it notices without them is what a stranger
notices. Its brief names no faults on purpose.

Then it is your film again. Read `VIEWER.md`, decide what to change, and say
in your notes what you took, what you did not and why — a viewer can be
wrong, can want what the product does not offer, and the film still may
only claim what the product supports. A new cut gets a new viewer: run
`film viewer` again (`film.viewer/2/`) and start a fresh agent, not the one
that saw the last cut, which now knows the film. Go round as often as it
helps; a non-draft render says whether the film on disk has had a viewer.

In earlier films, a viewer working a few minutes found what the author's own
checks had missed — a fault in the first second, a screen that argued
against the product, a film speaking to two audiences at once.
