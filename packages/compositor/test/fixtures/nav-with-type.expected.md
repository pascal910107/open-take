# Acceptance: `nav-with-type` → director output

Proposed `DEFAULT_CAMERA` used below (these are the tunables — argue here):

| knob | value | role |
|---|---|---|
| `fillFrac` | 0.60 | ROI fills this fraction of the frame when framed |
| `maxScale` | 2.40 | hard ceiling only — **ROI size drives actual scale** |
| `minHoldMs` | 1200 | a punch must stay on screen ≥ this (else drop to full) |
| `coalesceWindowMs` | 900 | gap > this ⇒ hard break |
| `travelThreshold` | 0.18·videoW = 346px | ROI centres closer than this MAY coalesce |
| `coalesceMinScale` | 1.25 | union-ROI fit must stay ≥ this to coalesce (else chain/pull) |
| `padding` | 0.12 | ROI padding (frac) before fit |
| `pullOutCoverage` | 0.55 | `changeCoverage` ≥ this ⇒ global repaint ⇒ full view |

`rest = insetFrac(0.92) · min(1,1) = 0.92`. Same-size output, viewport==video, so video-px == viewport-px (no mapping) in this fixture.

`fit(w,h) = clamp( min(1920·0.60/w, 1080·0.60/h), rest, 2.40 )`.

## The three-phase pipeline on this log

**Phase 1 — hard breaks** split the run at: `scroll` (E8), `always`/`never` overrides (none here), `changeCoverage ≥ 0.55` (E1 0.82, E2 0.78 → each a full-view segment + boundary), gap > 900ms (E4→E5 gap 300 ok; but E4 and E5 are ~720px apart → not a *coverage* break, handled in phase 2).

**Phase 2 — similarity coalesce** within surviving runs.

**Phase 3 — min-hold** extends a short segment's hold into the gap before the next break (never merges across a break).

## Expected `ZoomDecision` per beat

| # | beat | enabled | scale | center | why |
|---|---|---|---|---|---|
| 1 | click Features | **false** | rest | — | beat 1 orienting **and** coverage 0.82 ≥ 0.55 → full view |
| 2 | click Pricing | **false** | rest | — | coverage 0.78 ≥ 0.55 (global repaint) → full view — *this is the beat bbox-only can't get right; needs the annotation* |
| 3 | type query | **true** | **≈1.69** | (960, **320**) | ROI = `effectBox` 680×340 (field grown into result region), fit = min(1920·.6/680=1.69, 1080·.6/340=1.90) = **1.69**; centre **below** the field |
| 4 | press Enter | **true** | **1.69** | (960, 320) | `cluster[search] 2/2 · hold` — E4 box centre (970,355) is 43px from E3, union ≈ E3's ROI, fit 1.69 ≥ 1.25, gap 300<900 → shares E3's framing (camera holds, no re-punch) |
| 5 | click thumb 1 | **true** | **2.40** | (382, 622) | `cluster[rail] 1/3` — union of E5–E7 boxes = x[280..484]=204w, 44h → fit min(5.6, 14.7)=**2.40** (ceiling); tiny ROI ⇒ naturally tight |
| 6 | click thumb 2 | **true** | 2.40 | (382, 622) | `cluster[rail] 2/3 · hold shared framing` |
| 7 | click thumb 3 | **true** | 2.40 | (382, 622) | `cluster[rail] 3/3 · hold shared framing` |
| 8 | scroll | **false** | rest | — | scroll → full view (**hard break, overrides min-hold**) |

## The rules this fixture pins

- **E2 pull-out** = coverage-driven, independent of the first-beat rule (E1). Without `changeCoverage`, a bbox-only director would *punch* E2's small nav bbox → the exact flatten-inducing wrong call.
- **E3 type** = ROI-driven medium scale + downward centre — **not** a hard punch on the 638×44 strip (which would frame dead header above and cut the result below).
- **E3+E4 coalesce** = a `type`→`press(Enter)` that reveals the already-framed result *holds* one frame instead of re-punching.
- **E4→E5 is NOT coalesced** (720px apart) → a re-frame/travel to a new segment, even though the 300ms gap is tiny. Proximity, not time, gates coalesce.
- **E5–E7 cluster** = three quick icon hits become one sustained tight frame (the "縮圖列" case), not three punch/pull flickers.
- **E5–E7 min-hold** = on-screen span 8600→9400 = 800ms < 1200; Phase 3 extends the hold to the scroll's ramp-in (~9840ms) ⇒ ~1240ms ≥ 1200. Extended into the gap, **not** merged past the scroll break.
- **E8 scroll** breaks immediately regardless of the rail's min-hold want.

## Open number to sanity-check by eye (Phase B)

`pullOutCoverage = 0.55` is the nav-vs-modal divider: a full-page nav ~0.8, a half-screen modal ~0.4–0.6 (frame the modal, don't pull out), a popover <0.2 (punch). This threshold is the one knob to tune on real captures.
