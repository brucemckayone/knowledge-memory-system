# Cognitive Platform - Full System Map

This document renders the comprehensive system architecture using the D2 diagram definition found in `FULL_SYSTEM.d2`.

```d2
@import "architecture/FULL_SYSTEM.d2"
```

## Legend

- **Pink**: User & Interactions
- **Blue (Service)**: TypeScript Platform Core (API, Queue, Logic)
- **Green (ML)**: Python Machine Learning Services
- **Orange (Queue)**: Asynchronous Job Processing
- **Purple (DB)**: Storage (Postgres & Qdrant)
- **Yellow (Gardener)**: Autonomous Agents / KARMA System

## Key Flows

1.  **Ingestion**: Telegram/Voice -> VS Code -> Queue -> Router
2.  **Processing**: Skill Execution -> Python ML Services -> Storage
3.  **Intelligence**: Gardener Agents -> Batch Processing -> Knowledge Graph Updates
