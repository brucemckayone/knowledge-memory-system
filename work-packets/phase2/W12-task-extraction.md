# Work Packet W12: Task Extraction

**Status:** Ready to Implement  
**Dependencies:** W08 (Skill Framework), W09 (LLM Router)  
**Estimated Time:** 2-3 hours

---

## Objective

When a message is classified as a task, extract structured data (action, due date, priority) and store in both the tasks table and Qdrant for searchable memory.

---

## Background

### Current State
- Messages classified as `task` by router
- Tasks table exists in database (from Phase 1)
- No task extraction or parsing

### Target State
- LLM extracts task details:
  - **Action**: What needs to be done
  - **Due date**: Parsed from natural language
  - **Priority**: Inferred from urgency
- Task stored in Postgres `tasks` table
- Also stored in Qdrant for semantic search
- User receives confirmation with parsed details

---

## Architecture

### Task Processing Flow

```
"Remind me to call John tomorrow at 3pm"
                 ↓
          [Classify] → intent: task
                 ↓
          [Extract Task] LLM parsing
                 ↓
    { action: "call John", due: "2026-01-25T15:00", priority: "medium" }
                 ↓
          [Create Task] Insert to Postgres
                 ↓
          [Embed] Generate vector
                 ↓
          [Store Memory] Save to Qdrant
                 ↓
          Reply: "✅ Task created: call John\n📅 Due: Tomorrow 3:00 PM"
```

---

## Step 1: Create Python Task Extractor

Create `ml-services/app/extract_task.py`:

```python
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timedelta
import ollama
import json
import re

router = APIRouter()

EXTRACT_TASK_PROMPT = """Extract task details from this message. Today is {today}.

Message: "{message}"

Parse the following:
1. action: What needs to be done (verb + object)
2. due_date: When it should be done (ISO format or null if not specified)
3. priority: high, medium, or low based on urgency words

Urgency indicators:
- high: urgent, asap, critical, important, immediately
- medium: tomorrow, soon, this week (default)
- low: when you can, eventually, someday

For relative dates:
- "tomorrow" = {tomorrow}
- "next Monday" = parse to actual date
- "in 2 hours" = add to current time
- "by Friday" = that Friday at 5pm
- No date mentioned = null

Return ONLY valid JSON:
{{
  "action": "the task to do",
  "due_date": "2026-01-25T15:00:00" or null,
  "priority": "medium",
  "confidence": 0.9
}}"""


class ExtractTaskRequest(BaseModel):
    """Request body for task extraction"""
    text: str


class ExtractTaskResponse(BaseModel):
    """Extracted task details"""
    action: str
    due_date: Optional[str] = None
    priority: str = "medium"
    confidence: float = 0.8
    raw_due_text: Optional[str] = None  # Original date phrase


def get_date_context() -> dict:
    """Get date context for LLM prompt"""
    now = datetime.now()
    return {
        "today": now.strftime("%Y-%m-%d %A"),
        "tomorrow": (now + timedelta(days=1)).strftime("%Y-%m-%d"),
    }


def extract_json(text: str) -> dict:
    """Extract JSON from LLM response"""
    json_match = re.search(r'\{[\s\S]*\}', text)
    if json_match:
        try:
            return json.loads(json_match.group())
        except json.JSONDecodeError:
            pass
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise ValueError(f"Could not parse JSON from: {text[:200]}")


def validate_date(date_str: Optional[str]) -> Optional[str]:
    """Validate and normalize date string"""
    if not date_str:
        return None
    
    try:
        # Try parsing ISO format
        dt = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
        return dt.isoformat()
    except ValueError:
        pass
    
    # Common relative date patterns
    lower = date_str.lower()
    now = datetime.now()
    
    if 'tomorrow' in lower:
        dt = now + timedelta(days=1)
        # Default to 9am for "tomorrow"
        return dt.replace(hour=9, minute=0, second=0).isoformat()
    
    if 'today' in lower:
        return now.replace(hour=17, minute=0, second=0).isoformat()
    
    return None


def validate_priority(priority: str) -> str:
    """Normalize priority value"""
    priority = priority.lower().strip()
    if priority in ('high', 'urgent', 'critical', 'important'):
        return 'high'
    if priority in ('low', 'eventually', 'someday'):
        return 'low'
    return 'medium'


@router.post("/extract-task", response_model=ExtractTaskResponse)
async def extract_task(request: ExtractTaskRequest):
    """
    Extract task details from text using LLM.
    
    Returns structured task data with action, due date, and priority.
    """
    try:
        # Build prompt with date context
        date_ctx = get_date_context()
        prompt = EXTRACT_TASK_PROMPT.format(
            message=request.text,
            **date_ctx
        )
        
        # Call Ollama
        response = ollama.generate(
            model="llama3.2:3b",
            prompt=prompt,
            options={
                "temperature": 0.1,
                "num_predict": 256,
            }
        )
        
        # Parse response
        result = extract_json(response['response'])
        
        # Validate and normalize
        action = result.get('action', request.text.strip())
        due_date = validate_date(result.get('due_date'))
        priority = validate_priority(result.get('priority', 'medium'))
        confidence = min(1.0, max(0.0, float(result.get('confidence', 0.8))))
        
        # Extract raw date phrase for display
        raw_due = None
        date_patterns = [
            r'(tomorrow|today|tonight)',
            r'(next\s+\w+day)',
            r'(in\s+\d+\s+(?:hour|day|week)s?)',
            r'(by\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))',
            r'(at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)',
        ]
        for pattern in date_patterns:
            match = re.search(pattern, request.text, re.IGNORECASE)
            if match:
                raw_due = match.group(1)
                break
        
        return ExtractTaskResponse(
            action=action,
            due_date=due_date,
            priority=priority,
            confidence=confidence,
            raw_due_text=raw_due
        )
        
    except Exception as e:
        # Fallback: treat entire message as action
        return ExtractTaskResponse(
            action=request.text.strip(),
            due_date=None,
            priority="medium",
            confidence=0.5,
            raw_due_text=None
        )


@router.get("/extract-task/test")
async def test_task_extraction():
    """Test task extraction with sample messages"""
    samples = [
        "Remind me to call John tomorrow at 3pm",
        "I need to finish the report by Friday",
        "TODO: update the documentation",
        "Don't forget to buy groceries",
        "URGENT: fix the production bug",
        "Schedule a meeting with the team next Monday",
    ]
    
    results = []
    for sample in samples:
        try:
            result = await extract_task(ExtractTaskRequest(text=sample))
            results.append({
                "input": sample,
                "action": result.action,
                "due_date": result.due_date,
                "priority": result.priority,
            })
        except Exception as e:
            results.append({"input": sample, "error": str(e)})
    
    return {"test_results": results}
```

---

## Step 2: Register Router in FastAPI

Update `ml-services/app/main.py`:

```python
from app.extract_task import router as extract_task_router

# Add to app
app.include_router(extract_task_router)

@app.get("/health")
def health():
    return {
        "status": "ok",
        "services": ["embed", "transcribe", "classify", "extract-task"]
    }
```

---

## Step 3: Create TypeScript Extract Task Service

Create `platform/src/services/task.ts`:

```typescript
import { config } from '../config.js';

export interface ExtractedTask {
  action: string;
  due_date: string | null;
  priority: 'high' | 'medium' | 'low';
  confidence: number;
  raw_due_text?: string;
}

/**
 * Extract task details from text using LLM
 */
export async function extractTask(text: string): Promise<ExtractedTask> {
  const response = await fetch(`${config.ML_SERVICES_URL}/extract-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    throw new Error(`Task extraction failed: ${response.statusText}`);
  }

  return response.json() as Promise<ExtractedTask>;
}
```

---

## Step 4: Create Extract Task Skill

Create `platform/src/skills/core/extract-task.skill.ts`:

```typescript
import type { Skill, SkillContext } from '../types.js';
import { extractTask, ExtractedTask } from '../../services/task.js';

export interface ExtractTaskInput {
  text: string;
}

export type ExtractTaskOutput = ExtractedTask;

export const extractTaskSkill: Skill<ExtractTaskInput, ExtractTaskOutput> = {
  name: 'extract-task',
  description: 'Extract task details from text using LLM',
  version: '1.0.0',

  async execute(input: ExtractTaskInput, context: SkillContext): Promise<ExtractTaskOutput> {
    context.log(`Extracting task from: "${input.text.slice(0, 50)}..."`);
    
    const result = await extractTask(input.text);
    
    context.log(`Extracted: "${result.action}" (${result.priority}, ${result.due_date || 'no date'})`);
    
    return result;
  },
};
```

---

## Step 5: Create Create Task Skill

Create `platform/src/skills/core/create-task.skill.ts`:

```typescript
import type { Skill, SkillContext } from '../types.js';
import { tasks } from '../../db/schema.js';

export interface CreateTaskInput {
  action: string;
  due_date?: string | null;
  priority: 'high' | 'medium' | 'low';
  context_id: string;
  memory_id: string;
}

export interface CreateTaskOutput {
  task_id: string;
  created_at: string;
}

export const createTaskSkill: Skill<CreateTaskInput, CreateTaskOutput> = {
  name: 'create-task',
  description: 'Create a task in the database',
  version: '1.0.0',

  async execute(input: CreateTaskInput, context: SkillContext): Promise<CreateTaskOutput> {
    context.log(`Creating task: "${input.action}"`);
    
    const created_at = new Date().toISOString();
    
    const [task] = await context.services.db
      .insert(tasks)
      .values({
        content: input.action,
        dueDate: input.due_date ? new Date(input.due_date) : null,
        priority: input.priority,
        contextId: input.context_id,
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: tasks.id });
    
    context.log(`Task created: ${task.id}`);
    
    return {
      task_id: task.id,
      created_at,
    };
  },
};
```

---

## Step 6: Create Task Processing Workflow

Create `platform/src/workflows/process-task.ts`:

```typescript
import type { Envelope } from '../types/envelope.js';
import type { SkillContext } from '../skills/types.js';
import { addEnrichment } from '../core/envelope-factory.js';
import { extractTaskSkill } from '../skills/core/extract-task.skill.js';
import { createTaskSkill } from '../skills/core/create-task.skill.js';
import { embedSkill } from '../skills/core/embed.skill.js';
import { storeMemorySkill } from '../skills/core/store-memory.skill.js';

export interface ProcessTaskResult {
  success: boolean;
  task_id?: string;
  action?: string;
  due_date?: string | null;
  priority?: string;
  error?: string;
}

/**
 * Process a message classified as a task
 */
export async function processTask(
  envelope: Envelope,
  context: SkillContext
): Promise<ProcessTaskResult> {
  const content = envelope.raw.content || '';
  const startTime = Date.now();
  
  try {
    // Step 1: Extract task details
    context.log('Step 1: Extracting task details');
    const extractStart = Date.now();
    const extracted = await extractTaskSkill.execute({ text: content }, context);
    
    addEnrichment(envelope, 'extract_task', {
      action: extracted.action,
      due_date: extracted.due_date,
      priority: extracted.priority,
    }, extractStart);
    
    // Step 2: Create task in database
    context.log('Step 2: Creating task');
    const createStart = Date.now();
    const taskResult = await createTaskSkill.execute({
      action: extracted.action,
      due_date: extracted.due_date,
      priority: extracted.priority,
      context_id: envelope.origin.context.conversation_id,
      memory_id: envelope.trace_id,
    }, context);
    
    addEnrichment(envelope, 'create_task', {
      task_id: taskResult.task_id,
    }, createStart);
    
    // Step 3: Generate embedding
    context.log('Step 3: Embedding');
    const embedStart = Date.now();
    const embedResult = await embedSkill.execute({ text: content }, context);
    
    addEnrichment(envelope, 'embed', {
      vector: embedResult.vector,
      model: embedResult.model,
    }, embedStart);
    
    // Step 4: Store memory
    context.log('Step 4: Storing memory');
    const storeStart = Date.now();
    await storeMemorySkill.execute({
      id: envelope.trace_id,
      vector: embedResult.vector,
      type: 'task',
      content: content,
      summary: extracted.action,
      tags: [extracted.priority, 'task'],
      metadata: {
        task_id: taskResult.task_id,
        action: extracted.action,
        due_date: extracted.due_date,
        priority: extracted.priority,
      },
    }, context);
    
    addEnrichment(envelope, 'store', { memory_id: envelope.trace_id }, storeStart);
    
    envelope.routing.status = 'completed';
    
    return {
      success: true,
      task_id: taskResult.task_id,
      action: extracted.action,
      due_date: extracted.due_date,
      priority: extracted.priority,
    };
    
  } catch (error) {
    context.log(`Task processing failed: ${error}`, 'error');
    envelope.routing.status = 'failed';
    return { success: false, error: String(error) };
  }
}

/**
 * Format due date for display
 */
export function formatDueDate(isoDate: string | null | undefined): string {
  if (!isoDate) return 'No deadline';
  
  try {
    const date = new Date(isoDate);
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    // Check if today
    if (date.toDateString() === now.toDateString()) {
      return `Today at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    
    // Check if tomorrow
    if (date.toDateString() === tomorrow.toDateString()) {
      return `Tomorrow at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    
    // Otherwise show full date
    return date.toLocaleDateString([], { 
      weekday: 'short', 
      month: 'short', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoDate;
  }
}
```

---

## Step 7: Register Skills

Update `platform/src/skills/index.ts`:

```typescript
// Add imports
import { extractTaskSkill } from './core/extract-task.skill.js';
import { createTaskSkill } from './core/create-task.skill.js';

// Update registerCoreSkills
export function registerCoreSkills(): void {
  registry.register(embedSkill);
  registry.register(storeMemorySkill);
  registry.register(transcribeSkill);
  registry.register(classifySkill);
  registry.register(extractUrlSkill);
  registry.register(fetchWebpageSkill);
  registry.register(summarizeSkill);
  registry.register(extractTaskSkill);   // Add
  registry.register(createTaskSkill);    // Add
  
  console.log('✅ Core skills registered');
  console.log(`   Available: ${registry.list().map(s => s.name).join(', ')}`);
}
```

---

## Step 8: Update Message Processor

Update `platform/src/workers/message-processor.ts`:

```typescript
import { processTask, formatDueDate } from '../workflows/process-task.js';

// In processMessage, after classification:

// Route to task workflow
if (classification.primary_intent === 'task') {
  console.log('📋 Routing to task workflow');
  const context = createSkillContext(envelope);
  const result = await processTask(envelope, context);
  
  if (result.success) {
    const priorityEmoji = {
      high: '🔴',
      medium: '🟡',
      low: '🟢',
    }[result.priority || 'medium'];
    
    await bot.api.sendMessage(data.chatId, 
      `✅ **Task created!**\n\n` +
      `📋 ${result.action}\n` +
      `📅 ${formatDueDate(result.due_date)}\n` +
      `${priorityEmoji} Priority: ${result.priority}`,
      { parse_mode: 'Markdown' }
    );
  } else {
    console.warn('Task processing failed:', result.error);
  }
  return;
}
```

---

## Testing

### Test Extraction Endpoint

```bash
curl -X POST http://localhost:8000/extract-task \
  -H "Content-Type: application/json" \
  -d '{"text": "Remind me to call John tomorrow at 3pm"}'

# Expected:
{
  "action": "call John",
  "due_date": "2026-01-25T15:00:00",
  "priority": "medium",
  "confidence": 0.9,
  "raw_due_text": "tomorrow at 3pm"
}
```

### Test Sample Tasks

```bash
curl http://localhost:8000/extract-task/test | jq .
```

### Test End-to-End

1. Send: "Remind me to buy groceries tomorrow"
2. Should receive:
   ```
   ✅ Task created!
   
   📋 buy groceries
   📅 Tomorrow at 9:00 AM
   🟡 Priority: medium
   ```
3. Check database for task
4. Check Qdrant for memory

---

## Acceptance Criteria

- [ ] `/extract-task` endpoint works
- [ ] `/extract-task/test` shows correct parsing
- [ ] `extract-task.skill.ts` compiles
- [ ] `create-task.skill.ts` inserts to database
- [ ] `process-task.ts` workflow chains skills
- [ ] Tasks stored in Postgres
- [ ] Task memories in Qdrant
- [ ] Bot confirms with parsed details
- [ ] Due dates parsed correctly
- [ ] Priority inferred from urgency words

---

## Date Parsing Examples

| Input | Parsed Due Date |
|-------|----------------|
| "tomorrow" | Next day 9:00 AM |
| "tomorrow at 3pm" | Next day 3:00 PM |
| "by Friday" | Friday 5:00 PM |
| "in 2 hours" | Current time + 2h |
| "next Monday" | Next Monday 9:00 AM |
| "ASAP" | null (priority: high) |
| (no date) | null |

---

## Next Packet

After completing W12, proceed to:
- [W15: Enhanced Telegram](./W15-enhanced-telegram.md) - Full integration
