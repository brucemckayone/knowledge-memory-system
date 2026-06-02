# nmemo-lpy — Window-size extraction-completeness sweep

- Generated: 2026-06-02T23:08:20.392Z
- Axis: AGENT-PROCESSING window size (chars). Embedding unit fixed at 128/64 (yxj.1).
- Corpus: q0-degree-session first 5 turns (through degree turn), 6333 chars
- Gold set (6 obvious USER facts): degree: Business Administration; started a new job / new role; works a 9-to-5 schedule; will use Todoist; will use Trello; used a planner
- Cost = window count = graph-agent (Haiku) invocations (extract() runs once/window).

## Completeness vs window size

| window_size | windows (cost) | completeness | gold hit | total facts | degree? |
|---|---|---|---|---|---|
| 3000 | 4 | 0.67 | 4/6 | 13 | yes |
| 6000 | 2 | 0.50 | 3/6 | 5 | yes |

### Misses per size
- window 3000: will use Todoist, will use Trello
- window 6000: will use Todoist, will use Trello, used a planner

## Recommendation

- **window_size=6000** — default 6000 validated — best alternative (3000) gains only +0.17 completeness for 4/2x the Haiku-call cost, below the +0.25 margin worth a 2x cost change on a single small corpus
- Current shared default (yxj.4): 6000.
- The 6000 default is VALIDATED by this sweep; no constant change needed.

## Caveats

- Single small corpus (6333 chars, 6 gold facts) + Haiku run-to-run variance — treat the absolute completeness numbers as directional, not precise.
- Smaller windows trended to higher completeness (3000: 13 facts / 0.67; 6000: 5 facts / 0.50) at 2x the Haiku-call cost; the degree needle survived at BOTH sizes.
- The two consistent misses (Todoist/Trello "will try") are soft future-intent statements the agent declines to assert as facts regardless of window — not a window-size effect.
