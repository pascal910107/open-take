# Directing a launch story

Read this when authoring a launch film, or when the user says a draft feels thin,
unfocused or like disconnected screenshots. A clean recording request does not
need launch-story metadata, a sales pitch or additional alignment questions.

## Decide what the film must communicate

Use the audience, distribution context and purpose already supplied. If missing,
infer a reasonable direction from the product and state that assumption. Ask
only when the answer would materially change the story. Do not turn the fields
below into a question-by-question form for the user.

Write one sentence the viewer should remember, then inventory the sources that
can substantiate it. A teaser introduces an idea; a launch establishes a reason
to care and credible proof; a walkthrough teaches a task. These intentions can
share footage but need different emphasis. There is no minimum feature count or
house duration. One complete workflow can carry a launch; several unrelated
features can still leave it without a point.

For each proposed beat, identify its viewer question, the visible answer, and
why it advances the main message. Useful functions include context, promise,
proof, payoff and next action. They are not mandatory shots in a fixed order:
context can be apparent in the opening action, and one continuous scene can
contain several beats. Avoid a logo-only delay, unexplained cursor travel,
repeated cards with the same information, and a generic closer that supplies no
useful next step. An intentionally atmospheric teaser may omit explicit proof.

Decide the length after the inventory. Use recorded action/result windows and
the reading needs of the actual copy; reserve time after entrances. Do not pad
to a target duration or add unverified features to make the film feel larger.
If evidence supports only a feature story, describe that scope. Capture more
only when it proves an essential missing point. Do not imply that viewing a
price demonstrates a payment, that a generated illustration proves a working
feature, or that an endpoint still shows a completed action.

## Connect the plan to the actual composition

The optional root `story` field is supported by both `launch compose` briefs and
ordinary launch JSON. It is editorial metadata, not rendered copy. It survives
composition generation and asset rebasing. Older files without it remain valid.

```json
{
  "intent": "launch",
  "audience": "Teams coordinating a handoff",
  "takeaway": "See who owns the next step before handing work over.",
  "beats": [
    {
      "id": "orientation", "sceneId": "opening", "role": "context",
      "message": "A handoff needs a next owner."
    },
    {
      "id": "main-message", "sceneId": "opening", "role": "promise",
      "message": "Make the next owner visible."
    },
    {
      "id": "operation", "sceneId": "assign", "role": "proof",
      "startS": 0.5, "endS": 4.5,
      "message": "Assign and see the result.",
      "evidence": [{"kind": "recording", "layerId": "actual-operation"}]
    },
    {
      "id": "next-step", "sceneId": "closing", "role": "action",
      "message": "Open a task and choose its owner."
    }
  ]
}
```

Place this object under `story`; the referenced scenes/layers must exist in the
same composition. `intent` is `teaser`, `launch` or `walkthrough`. Beat roles are
`context`, `promise`, `proof`, `payoff` and `action`. `startS`/`endS` are **local to
the referenced scene**, defaulting to zero and its full duration. They describe
where the beat is communicated, not the timestamp of the source recording.

Evidence kinds are `recording`, `screenshot` and `illustration`. A recording
points to a video layer; a screenshot points to an image layer, including nested
layers. A `footage` scene uses `recording` without `layerId`. An illustration can
omit a layer reference and does not count as actual UI proof. For recipes,
inspect the generated image layer IDs before binding story evidence; do not
guess IDs from display copy. Message fields record intent; the checker does not
establish that the rendered copy actually says it.

`launch check` validates references, kinds and timing and adds advisory findings
about missing story functions, competing declared promises, rushed message
windows and absent actual-source evidence. It can identify references hidden
by opacity/scale for the entire window and recording windows that only show a
held endpoint. It cannot verify occlusion, crop relevance, asset truth or whether
the story is persuasive. A screenshot declaration alone does not authenticate
an image. Do not describe a warning-free file as an accepted launch film.

## Make motion express the story

Choose a visual treatment from the brand, content and desired emphasis. The
protected recipe styles `editorial`, `product` and `technical` provide bounded
alternatives; use free layers when another structure better communicates the
idea. Keep one dominant focal element, and use movement to establish a relationship: reveal a
real result, preserve the same object across states, compare aligned peers, or
shift attention after the product's response has appeared.

For video, use visibly painted frames to time the camera. Dispatch and DOM-ready
timestamps can precede the encoded picture. Hold framing through a click and
its response; reframe when the result exists. A source waiting for navigation
can be trimmed with an explicit edit record. Preserve the original recording
and distinguish a source still extended for reading from continued live action.

## Review the result, not just the plan

Inspect the whole sequence at normal speed and the key transitions in dense
frames. Review at the delivery size, with the requested sound choice; a silent
film must communicate its point visually. After viewing, answer without relying
on the JSON: who is this for, what should I remember, what did I actually see
happen, and what is the useful next step? If an answer depends on explanatory
delivery notes, revise the film itself.

When comprehension is in doubt, get a cold view from someone (or an agent) who
has not seen the plan: hand over only the video, not the intended answer.
Separate missing context or evidence from taste. Recheck revised transitions
and the final sequence.
