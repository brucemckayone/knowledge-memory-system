# yxj.1 - Embedding unit-size/overlap retrieval sweep

- Generated: 2026-06-02 14:09:29
- Needles: 8 | corpus units (size128/ov0 ref): see per-config
- ML model: nomic-embed-text | Qdrant: 1.7.4
- Corpus: 19 sessions, 199,783 chars

## Needle set (answer-shape spread)

| qid | type | anchor | answer | question |
|---|---|---|---|---|
| e47becba | single-session-user | literal | Business Administration | What degree did I graduate with? |
| 118b2229 | single-session-user | literal | 45 minutes each way | How long is my daily commute to work? |
| gpt4_59149c77 | temporal-reasoning | turn | 7 days. 8 days (including the  | How many days passed between my visit to the Museu |
| 8a2466db | single-session-preference | turn | The user would prefer response | Can you recommend some resources where I can learn |
| 6a1eabeb | knowledge-update | turn | 25 minutes and 50 seconds (or  | What was my personal best time in the charity 5K r |
| 7161e7e2 | single-session-assistant | turn | Admon was assigned to the 8 am | I'm checking our previous chat about the shift rot |
| 0a995998 | multi-session | turn | 3 | How many items of clothing do I need to pick up or |
| 51a45a95 | single-session-user | turn | Target | Where did I redeem a $5 coupon on coffee creamer? |

## Recall@k vs (unit_size, overlap)

| unit_size | overlap | units | recall@1 | recall@3 | recall@5 | mean needle score | degree score |
|---|---|---|---|---|---|---|---|
| 128 | 0 | 1572 | 0.62 | 0.75 | 0.75 | 0.738 | 0.738 |
| 128 | 64 | 3114 | 0.38 | 0.62 | 0.75 | 0.771 | 0.738 |
| 256 | 0 | 790 | 0.50 | 0.62 | 0.75 | 0.715 | 0.655 |
| 256 | 64 | 1043 | 0.38 | 0.75 | 0.75 | 0.731 | 0.636 |
| 256 | 128 | 1553 | 0.62 | 0.75 | 0.75 | 0.736 | 0.655 |
| 512 | 0 | 398 | 0.38 | 0.62 | 0.62 | 0.703 | 0.515 |
| 512 | 64 | 453 | 0.50 | 0.50 | 0.50 | 0.706 | 0.543 |
| 512 | 128 | 523 | 0.38 | 0.50 | 0.50 | 0.698 | 0.553 |
| 512 | 256 | 771 | 0.38 | 0.75 | 0.75 | 0.716 | 0.614 |
| 1024 | 0 | 204 | 0.38 | 0.38 | 0.62 | 0.665 | 0.520 |
| 1024 | 64 | 214 | 0.50 | 0.62 | 0.62 | 0.666 | 0.520 |
| 1024 | 128 | 228 | 0.50 | 0.62 | 0.88 | 0.683 | 0.535 |
| 1024 | 256 | 264 | 0.38 | 0.38 | 0.38 | 0.671 | 0.535 |

## Whole-window baseline (platform-style large chunks)

- degree-needle score: **0.471** (prior Frankenstein probe ~0.47)
- recall@k: 0.50 | 0.75 | 0.75 | mean needle score: 0.601

## Prefix side-test (at size=256, overlap=64)

| variant | recall@1 | recall@3 | recall@5 | mean needle score | degree score |
|---|---|---|---|---|---|
| no-prefix | 0.38 | 0.75 | 0.75 | 0.731 | 0.636 |
| nomic-prefix | 0.75 | 0.75 | 0.75 | 0.725 | 0.631 |

## Recommendation

- **unit_size=128, overlap=64** (recall@5=0.75, mean needle score=0.771, degree score=0.738)
- Feeds yxj.2 (unit splitter defaults) and yxj.5 (q[0] retest).
