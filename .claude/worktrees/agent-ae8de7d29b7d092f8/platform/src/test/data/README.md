# Test Data — Reasoning Layer Hardening

Fixtures, expected outputs, and benchmark reports for the reasoning-layer phases.
See `docs/architecture/truth-graph/18-test-data-hardening-protocol.md` for the full protocol.

## Layout

```
data/
├── README.md                           # this file
├── common/                             # shared across phases
│   ├── entities.json                   # stable entity fixtures with known UUIDs
│   └── predicates.json                 # known predicates + categories
├── phase<n>-<name>/                    # per-phase data
│   ├── fixtures/                       # .sql seed files
│   ├── expected/                       # .expected.json assertion files
│   └── benchmark-reports/              # YYYY-MM-DD-<scenario>.md
└── integration/                        # cross-phase and end-to-end
    ├── full-pipeline/
    └── end-to-end/
```

## Running

Fixtures are loaded via test helpers in `src/test/setup.ts`:

```typescript
import { loadFixture } from '../setup.js';

await loadFixture('phase1-audit/fixtures/simple-mutations.sql');
```

The `loadFixture` helper is NEW — added as part of Phase 1. It:
1. Resolves the path under `platform/src/test/data/`
2. Executes the SQL in a single transaction
3. Reports timing

## Conventions

### UUIDs in fixtures

Use **predictable UUIDs** for fixture rows so assertions can reference them:

```sql
INSERT INTO entities (id, canonical_name, ...)
VALUES ('00000000-0000-0000-0000-000000000001', 'Alice', ...);
```

Pattern: `<type-prefix>-...-<seq>`:
- `000...001` for first entity
- `100...001` for first fact
- `200...001` for first causal_event
- `300...001` for first causal_edge

Document the UUID map in each fixture's header comment.

### Expected JSON format

Keys are descriptive (no one-liner names). Every assertion has a `because` field explaining the invariant.

```json
{
  "scenario": "simple-mutations",
  "assertions": [
    {
      "type": "row_count",
      "table": "fact_history",
      "filter": { "fact_id": "10000000-0000-0000-0000-000000000001" },
      "expected": 2,
      "because": "Fact was created then had confidence raised — two events"
    }
  ]
}
```

### Benchmark report format

See `phase1-audit/benchmark-reports/TEMPLATE.md`.

## Protocol

1. Write fixture describing a scenario
2. Write expected.json capturing invariants
3. Run test against implementation
4. Measure latency + assert correctness
5. Record results in dated benchmark report
6. If any fixture regresses, investigate before any further data complexity work
7. When scenarios plateau (all pass consistently), graduate to next level
