# Phase 5: Intelligence & Insights

> **Goal:** Enable advanced knowledge discovery through graph analysis, insight generation, and proactive briefings.

---

## Phase Status

| Packet | Name | Status | Dependencies |
|--------|------|--------|--------------|
| W30 | Community Detection | 📋 Ready | W18 |
| W31 | Insight Generation | 📋 Ready | W30 |
| W32 | Morning Briefing | 📋 Ready | W31 |
| W33 | Scheduled Contradiction Detection | 📋 Ready | W28 |

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
