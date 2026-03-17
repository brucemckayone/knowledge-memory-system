# Phase 5: Intelligence & Insights

> **Goal:** Enable advanced knowledge discovery through graph analysis, insight generation, and proactive briefings.
> **Status:** ❌ Not Started
> **Last Updated:** 2026-03-12

---

## Phase Status

| Packet | Name | Status | Dependencies | Blockers |
|--------|------|--------|--------------|----------|
| W30 | Community Detection | ❌ Not Started | W18 | AGE underutilized (W18 partial) |
| W31 | Insight Generation | ❌ Not Started | W30 | Blocked by W30 |
| W32 | Morning Briefing | ❌ Not Started | W31, W15 | Blocked by W31 |
| W33 | Contradiction Detection | ❌ Not Started | W28 | W28 partial (detection OK, debate TODO). Note: evaluator agent no longer exists; controller metrics + `gardener_agent_stats` view now produce real data that W33 can consume. |

---

## Prerequisites & Blockers

### W18: Apache AGE (Phase 3) — Primary Blocker
AGE is installed but underutilized. Community detection (W30) depends on a working graph layer. Before starting W30, AGE queries must be exercised beyond the current hybrid search service.

### W28: Conflict Resolution (Phase 4) — Partial Blocker
Basic contradiction detection works, but the LLM debate system is not implemented. W33 (Scheduled Contradiction Detection) can build on the existing detection but won't have the full debate capability until W28 is completed.

### Phase 2 Dependencies
W32 (Morning Briefing) depends on W15 (Enhanced Telegram) for delivery — already complete.

---

## Recommended Implementation Order

```
W33 (Contradiction Detection) — most independent, only needs W28 (partially met)
  ↓
W30 (Community Detection) — requires W18 AGE to be fully utilized first
  ↓
W31 (Insight Generation) — builds on W30 communities
  ↓
W32 (Morning Briefing) — compiles W31 + W33 outputs for delivery
```

**W33 first** because it has the fewest blockers — W28's existing detection is sufficient to start. W30-W31-W32 form a strict chain and should not be started out of order.

---

## Intelligence Architecture

```
                    ┌─────────────────────────────┐
                    │     Knowledge Graph         │
                    │   (Entities + Facts + AGE)  │
                    └─────────────┬───────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
        ▼                         ▼                         ▼
┌───────────────┐         ┌───────────────┐         ┌───────────────┐
│   Community   │         │    Insight    │         │ Contradiction │
│   Detection   │────────▶│   Generation  │         │   Detection   │
│     (W30)     │         │     (W31)     │         │     (W33)     │
└───────────────┘         └───────────────┘         └───────────────┘
        │                         │                         │
        └─────────────────────────┼─────────────────────────┘
                                  │
                                  ▼
                    ┌─────────────────────────────┐
                    │     Morning Briefing        │
                    │         (W32)               │
                    └─────────────────────────────┘
                                  │
                                  ▼
                    ┌─────────────────────────────┐
                    │     User Notification       │
                    │   (Telegram / Email / UI)   │
                    └─────────────────────────────┘
```

---

## Processing Schedule

| Time | Agent | Description |
|------|-------|-------------|
| 00:00 | Community Detection | Nightly graph clustering |
| 01:00 | Contradiction Detection | Nightly fact validation |
| 02:00 | Insight Generation | Generate daily insights |
| 06:00 | Morning Briefing | Compile and send briefing |

---

## Success Criteria

- [ ] Communities detected in knowledge graph
- [ ] Insights generated from patterns
- [ ] Contradictions flagged proactively
- [ ] Morning briefing delivered on schedule
- [ ] User can configure briefing preferences

---

## Related Documents

- [Phase 4 README](../phase4/README.md) — KARMA agents (prerequisite)
- [Phase 6 README](../phase6/README.md) — Extended vision (next phase)
- [ARCHITECTURE.md](../../architecture/current.md)
- [TECHNICAL_PLAN.md](../../INDEX.md)
