# W36: Resource Conflict Detection

**Status:** 📋 Backlog
**Priority:** P0 (Critical - blocks core feature)
**Estimated Time:** 4-6 hours
**Phase:** 2 Enhancement
**Dependencies:** W16 (Entity Extraction), W20 (Entity Extraction Skill)

---

## Objective

Implement `detectResourceConflicts()` function to identify when the same entity (person, location, resource) is double-booked in overlapping time windows, enabling users to avoid scheduling conflicts.

---

## Prerequisites

- ✅ `tasks` table exists with `due_date`, `status` columns
- ✅ `entities` table exists with entity extraction
- ✅ Entity extraction agent working (W20, W25)
- ✅ Task extraction working (W10)
- ❌ Stub function at line 201 needs implementation

---

## Implementation Steps

### Step 1: Implement Entity Extraction from Tasks (1.5 hours)

**File:** `platform/src/services/task-conflicts.ts`

**Current Stub (line 201):**
```typescript
// TODO: Implement resource conflict detection
const conflicts = await detectResourceConflicts(newTask);
```

**First, extract entities from task description:**
```typescript
async function extractEntitiesFromTask(taskDescription: string): Promise<string[]> {
  // Call ML entity extraction service
  const response = await fetch(`${ML_SERVICES_URL}/extract-entities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: taskDescription })
  });

  const data = await response.json();
  return data.entities.map((e: any) => e.canonical_name);
}
```

### Step 2: Implement Conflict Detection Logic (2 hours)

**File:** `platform/src/services/task-conflicts.ts`

```typescript
interface TaskConflict {
  existingTask: {
    id: string;
    action: string;
    due_date: string;
  };
  conflictingEntity: string;
  conflictType: 'exact-overlap' | 'time-proximity' | 'resource-overload';
}

async function detectResourceConflicts(
  newTask: { action: string; due_date: Date },
  userId: string
): Promise<TaskConflict[]> {
  const conflicts: TaskConflict[] = [];

  // Step 1: Extract entities from new task
  const entities = await extractEntitiesFromTask(newTask.action);

  // Step 2: Query pending tasks with same entities
  for (const entity of entities) {
    const conflictingTasks = await db
      .select({
        id: tasks.id,
        action: tasks.action,
        dueDate: tasks.dueDate
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.status, 'pending'),
          isNotNull(tasks.dueDate),
          // Check if task action mentions this entity
          sql`${tasks.action} ILIKE ${`%${entity}%`}`
        )
      );

    // Step 3: Detect time overlaps
    for (const existingTask of conflictingTasks) {
      if (isOverlapping(newTask.due_date, existingTask.dueDate)) {
        conflicts.push({
          existingTask: existingTask,
          conflictingEntity: entity,
          conflictType: 'exact-overlap'
        });
      } else if (isProximate(newTask.due_date, existingTask.dueDate, 60)) {
        // Within 60 minutes
        conflicts.push({
          existingTask: existingTask,
          conflictingEntity: entity,
          conflictType: 'time-proximity'
        });
      }
    }
  }

  return conflicts;
}

function isOverlapping(date1: Date, date2: Date): boolean {
  // Assume tasks take 1 hour by default
  const duration = 60 * 60 * 1000; // 1 hour in ms
  const start1 = date1.getTime();
  const end1 = start1 + duration;
  const start2 = date2.getTime();
  const end2 = start2 + duration;

  return (start1 < end2) && (end1 > start2);
}

function isProximate(date1: Date, date2: Date, thresholdMinutes: number): boolean {
  const threshold = thresholdMinutes * 60 * 1000;
  const diff = Math.abs(date1.getTime() - date2.getTime());
  return diff < threshold;
}
```

### Step 3: Add Conflict Severity Scoring (1 hour)

**File:** `platform/src/services/task-conflicts.ts`

```typescript
interface ConflictSeverity {
  level: 'critical' | 'high' | 'medium' | 'low';
  score: number;
  reason: string;
}

function scoreConflict(conflict: TaskConflict): ConflictSeverity {
  const { existingTask, conflictType, conflictingEntity } = conflict;

  if (conflictType === 'exact-overlap') {
    return {
      level: 'critical',
      score: 1.0,
      reason: `${conflictingEntity} is double-booked at the same time`
    };
  }

  if (conflictType === 'time-proximity') {
    const timeDiff = Math.abs(
      new Date(existingTask.due_date).getTime() - new Date().getTime()
    );

    if (timeDiff < 30 * 60 * 1000) { // Within 30 min
      return {
        level: 'high',
        score: 0.8,
        reason: `${conflictingEntity} has back-to-back tasks`
      };
    } else {
      return {
        level: 'medium',
        score: 0.5,
        reason: `${conflictingEntity} has tasks within 1 hour`
      };
    }
  }

  return {
    level: 'low',
    score: 0.3,
    reason: 'Potential resource contention'
  };
}
```

### Step 4: Integrate into Task Creation Workflow (30 minutes)

**File:** `platform/src/workflows/process-task.ts`

```typescript
// After extracting task, check for conflicts
const task = await ml.extractTask(content);

if (task.due_date) {
  const conflicts = await detectResourceConflicts(task, userId);

  if (conflicts.length > 0) {
    // Flag task for review
    task.needs_review = true;
    task.conflicts = conflicts.map(c => ({
      severity: scoreConflict(c).level,
      message: scoreConflict(c).reason
    }));

    // Send notification to user
    await bot.api.sendMessage(chatId, `⚠️ Scheduling conflict detected:\n${conflicts.map(c => scoreConflict(c).reason).join('\n')}`);
  }
}
```

### Step 5: Add Database Schema for Conflict Tracking (30 minutes)

**File:** New migration or add to existing schema

```sql
-- Task conflicts tracking
CREATE TABLE task_conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  conflicting_task_id UUID REFERENCES tasks(id),
  entity_id UUID REFERENCES entities(id),
  conflict_type VARCHAR(50) NOT NULL,  -- exact-overlap, time-proximity
  severity VARCHAR(20) NOT NULL,        -- critical, high, medium, low
  resolved BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_task_conflicts_task_id ON task_conflicts(task_id);
CREATE INDEX idx_task_conflicts_entity_id ON task_conflicts(entity_id);
```

---

## Testing

### Unit Tests

**File:** `platform/src/test/integration/task-conflicts.test.ts`

```typescript
describe('W36: Resource Conflict Detection', () => {
  it('should detect exact time overlaps for same entity', async () => {
    // Create two tasks with "John" at same time
    const task1 = await createTask({ action: 'Meeting with John', due_date: '2026-01-30T10:00:00Z' });
    const task2 = await createTask({ action: 'Call John', due_date: '2026-01-30T10:00:00Z' });

    const conflicts = await detectResourceConflicts(task2, 'user-123');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].conflictingEntity).toBe('John');
    expect(conflicts[0].conflictType).toBe('exact-overlap');
  });

  it('should detect time-proximity conflicts', async () => {
    const task1 = await createTask({ action: 'Meeting with John', due_date: '2026-01-30T10:00:00Z' });
    const task2 = await createTask({ action: 'Call John', due_date: '2026-01-30T10:45:00Z' });

    const conflicts = await detectResourceConflicts(task2, 'user-123');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].conflictType).toBe('time-proximity');
  });

  it('should not detect conflicts for different entities', async () => {
    const task1 = await createTask({ action: 'Meeting with John', due_date: '2026-01-30T10:00:00Z' });
    const task2 = await createTask({ action: 'Call Sarah', due_date: '2026-01-30T10:00:00Z' });

    const conflicts = await detectResourceConflicts(task2, 'user-123');
    expect(conflicts).toHaveLength(0);
  });

  it('should score conflicts by severity', async () => {
    const conflict = {
      existingTask: { id: '1', action: 'Meeting with John', due_date: '2026-01-30T10:00:00Z' },
      conflictingEntity: 'John',
      conflictType: 'exact-overlap' as const
    };

    const severity = scoreConflict(conflict);
    expect(severity.level).toBe('critical');
    expect(severity.score).toBe(1.0);
  });
});
```

### Integration Tests

```typescript
describe('W36: End-to-End Conflict Detection', () => {
  it('should flag conflicts during task creation', async () => {
    // Setup: Create existing task
    await createTask('Meeting with John at 10am tomorrow');

    // Test: Create conflicting task
    const result = await processMessage('Call John at 10am tomorrow');

    // Verify: Task flagged for review
    expect(result.task.needs_review).toBe(true);
    expect(result.task.conflicts).toBeDefined();
    expect(result.task.conflicts[0].severity).toBe('critical');
  });
});
```

### Manual Testing

1. Create task: "Meeting with John tomorrow at 10am"
2. Create task: "Call John tomorrow at 10am"
3. Verify: Conflict detected, notification sent
4. Verify: Task flagged for review

---

## Success Criteria

- [ ] `detectResourceConflicts()` function implemented
- [ ] Entity extraction from tasks working
- [ ] Overlapping tasks detected correctly
- [ ] Time-proximity conflicts detected (configurable threshold)
- [ ] Conflict severity scoring working
- [ ] Tasks flagged for review when conflicts found
- [ ] User notifications sent for critical conflicts
- [ ] Tests pass (unit + integration)
- [ ] Manual testing confirms conflicts detected

---

## Files to Modify

1. `platform/src/services/task-conflicts.ts` - Implement stub at line 201
2. `platform/src/workflows/process-task.ts` - Integrate conflict detection
3. `platform/src/db/schema.ts` - Add `task_conflicts` table
4. `platform/src/test/integration/task-conflicts.test.ts` - Add tests

---

## Related Work Packets

- **W16**: Entity Schema (entity extraction)
- **W20**: Entity Extraction Skill (ML service)
- **W34**: User Preferences Integration (working hours affect conflicts)
- **W37**: Context-Aware Task Deduplication (prevents duplicate tasks)

---

## Notes

- **Performance:** Conflict detection should be fast (indexed queries by `due_date` + `action`)
- **Entity Resolution:** May need fuzzy matching for entity names (John vs. John Smith)
- **Task Duration:** Assume 1 hour default; could be configurable per task
- **Multi-Entity Tasks:** Task with multiple entities checked against all

**Future Enhancements:**
- Calendar integration (detect conflicts with external calendars)
- Resource capacity limits (max N tasks per day for entity)
- Automatic conflict resolution (reschedule tasks)
- Conflict visualization (Gantt chart view)

---

**Created:** 2026-01-29 (Documentation Synchronization Project, Packet 10)
**Source:** `work-packets/PACKET4_TODO_ANALYSIS.md` (Critical Stub #1)
