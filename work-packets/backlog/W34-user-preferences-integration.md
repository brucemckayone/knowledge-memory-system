# W34: User Preferences Integration

**Status:** 📋 Backlog
**Priority:** P1 (High)
**Estimated Time:** 1-2 hours
**Phase:** 2 Enhancement
**Dependencies:** None

---

## Objective

Implement user preference querying and integrate preferences into task extraction ML service to enable personalized task management (working hours, urgency calibration, priority weighting).

---

## Prerequisites

- ✅ `user_preferences` table exists (from Packet 2 verification)
- ✅ Task extraction ML service exists (`ml-services/app/extract_task.py`)
- ✅ Task processing workflow exists (`platform/src/workflows/process-task.ts`)
- ⚠️ Stub function at line 366 needs implementation

---

## Implementation Steps

### Step 1: Implement `getUserPreferences()` Query (30 minutes)

**File:** `platform/src/workflows/process-task.ts`

**Current Stub (line 366):**
```typescript
// TODO: Implement user preferences query
const userPreferences = await getUserPreferences(userId);
```

**Implementation:**
```typescript
interface UserPreferences {
  user_id: string;
  working_hours_start: string;  // e.g., "09:00"
  working_hours_end: string;    // e.g., "18:00"
  timezone: string;              // e.g., "America/Los_Angeles"
  default_urgency: 'low' | 'medium' | 'high';
  priority_keywords: Record<string, number>;  // {"urgent": 2, "asap": 1.5}
  excluded_hours: number[];      // Hours when user shouldn't be disturbed
}

async function getUserPreferences(userId: string): Promise<UserPreferences | null> {
  const result = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.user_id, userId))
    .limit(1);

  return result[0] || null;
}
```

### Step 2: Update Task Extraction ML Call (30 minutes)

**File:** `platform/src/workflows/process-task.ts` (task extraction call)

**Add preferences to ML service call:**
```typescript
const taskExtractionPrompt = buildTaskExtractionPrompt(content, {
  workingHours: userPreferences?.working_hours
    ? `${userPreferences.working_hours_start}-${userPreferences.working_hours_end}`
    : "09:00-18:00",
  timezone: userPreferences?.timezone || "UTC",
  defaultUrgency: userPreferences?.default_urgency || "medium",
  priorityKeywords: userPreferences?.priority_keywords || {},
});

const task = await ml.extractTask(taskExtractionPrompt);
```

### Step 3: Calibrate Due Dates from Preferences (30 minutes)

**Logic:**
- If user says "tomorrow" but current time is outside working hours
- Adjust due date to next working hour
- Respect user's timezone

```typescript
function adjustDueDateForWorkingHours(
  dueDate: Date,
  preferences: UserPreferences
): Date {
  const hour = dueDate.getHours();
  const startHour = parseInt(preferences.working_hours_start.split(':')[0]);
  const endHour = parseInt(preferences.working_hours_end.split(':')[0]);

  // If due date falls outside working hours, move to next working day
  if (hour < startHour || hour >= endHour) {
    dueDate.setHours(startHour, 0, 0, 0);
  }

  return dueDate;
}
```

### Step 4: Add User Preferences Seed Data (optional, 15 minutes)

**File:** `platform/src/db/seed.ts` or new migration

```sql
-- Default user preferences for single-user system
INSERT INTO user_preferences (user_id, working_hours_start, working_hours_end, timezone, default_urgency, priority_keywords)
VALUES (
  'default',
  '09:00',
  '18:00',
  'America/Los_Angeles',
  'medium',
  '{"urgent": 2.0, "asap": 1.5, "today": 1.8, "tomorrow": 1.2, "this week": 1.0}'::jsonb
)
ON CONFLICT (user_id) DO NOTHING;
```

---

## Testing

### Unit Tests

**File:** `platform/src/test/integration/user-preferences.test.ts`

```typescript
describe('W34: User Preferences Integration', () => {
  it('should retrieve user preferences from database', async () => {
    const prefs = await getUserPreferences('default');
    expect(prefs).toBeDefined();
    expect(prefs?.working_hours_start).toBe('09:00');
  });

  it('should adjust due dates to working hours', async () => {
    const prefs = { working_hours_start: '09:00', working_hours_end: '18:00', timezone: 'UTC' };
    const dueDate = new Date('2026-01-29T02:00:00Z');  // 2 AM
    const adjusted = adjustDueDateForWorkingHours(dueDate, prefs);
    expect(adjusted.getHours()).toBe(9);  // Moved to 9 AM
  });

  it('should pass preferences to task extraction', async () => {
    // Integration test with ML service
  });
});
```

### Manual Testing

1. Set different working hours in database
2. Send task: "Call John tomorrow at 2 AM"
3. Verify due date adjusted to 9 AM (working hours)

---

## Success Criteria

- [ ] `getUserPreferences()` function implemented and working
- [ ] Task extraction ML service receives user preferences
- [ ] Due dates respect working hours configuration
- [ ] Priority keywords weighted correctly (e.g., "urgent" = 2x priority)
- [ ] User timezone handled correctly
- [ ] Tests pass (unit + integration)

---

## Files to Modify

1. `platform/src/workflows/process-task.ts` - Implement stub at line 366
2. `platform/src/db/schema.ts` - Verify `user_preferences` table schema
3. `platform/src/test/integration/user-preferences.test.ts` - Add tests

---

## Related Work Packets

- **W10**: Voice Transcription (uses user preferences for transcription timing)
- **W35**: Conversation Context Retrieval (completes context picture)
- **W36**: Resource Conflict Detection (uses working hours for conflict detection)

---

## Notes

- **User ID System:** Currently single-user system, hardcode `userId = 'default'`
- **Future Enhancement:** Multi-user support with per-user preferences
- **ML Service Update:** May need to update `extract_task.py` to accept preferences parameter
- **Backwards Compatibility:** If no preferences found, use sensible defaults

---

**Created:** 2026-01-29 (Documentation Synchronization Project, Packet 10)
**Source:** `work-packets/PACKET4_TODO_ANALYSIS.md` (Critical Stub #4)
