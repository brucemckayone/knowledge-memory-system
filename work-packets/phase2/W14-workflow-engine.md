# Work Packet W14: Workflow Engine

**Status:** Ready to Implement (Optional for Phase 2)  
**Dependencies:** W08 (Skill Framework)  
**Estimated Time:** 3-4 hours

---

## Objective

Create a workflow engine that can execute configurable pipelines of skills. For Phase 2 MVP, we'll implement a TypeScript-based engine with hardcoded workflows. YAML configuration is deferred to Phase 3.

---

## Background

### Current State
- Skills are individual units (W08)
- Workflows are hardcoded in separate files (process-link.ts, process-task.ts)
- No unified execution engine

### Target State (Phase 2 MVP)
- Unified workflow engine
- Registered workflows
- Standard execution context
- Logging and error handling

### Future State (Phase 3)
- YAML workflow definitions
- Dynamic workflow loading
- Parallel execution blocks
- Conditional steps

---

## Architecture

### Workflow Engine Design

```typescript
// Core workflow types
interface Workflow {
  name: string;
  description: string;
  version: string;
  triggers: string[];  // e.g., ['intent:link', 'type:url']
  steps: WorkflowStep[];
}

interface WorkflowStep {
  name: string;
  skill: string;
  input: (envelope: Envelope, context: WorkflowContext) => unknown;
  output?: string;  // Key to store result in context
  condition?: (context: WorkflowContext) => boolean;
}

interface WorkflowContext extends SkillContext {
  results: Record<string, unknown>;  // Accumulated step results
}
```

---

## Step 1: Create Workflow Types

Create `platform/src/workflows/types.ts`:

```typescript
import type { Envelope } from '../types/envelope.js';
import type { SkillContext } from '../skills/types.js';

/**
 * Result accumulator for workflow execution
 */
export interface WorkflowResults {
  [stepName: string]: unknown;
}

/**
 * Extended context for workflow execution
 */
export interface WorkflowContext extends SkillContext {
  results: WorkflowResults;
}

/**
 * Single step in a workflow
 */
export interface WorkflowStep<TInput = unknown, TOutput = unknown> {
  /** Step name for logging */
  name: string;
  
  /** Skill to execute */
  skill: string;
  
  /** Function to build skill input from context */
  buildInput: (envelope: Envelope, ctx: WorkflowContext) => TInput;
  
  /** Key to store result in context.results (optional) */
  outputKey?: string;
  
  /** Condition to run this step (optional) */
  condition?: (ctx: WorkflowContext) => boolean;
  
  /** Error handling: 'fail' | 'skip' | 'continue' */
  onError?: 'fail' | 'skip' | 'continue';
}

/**
 * Workflow definition
 */
export interface WorkflowDefinition {
  name: string;
  description: string;
  version: string;
  
  /** Intent types that trigger this workflow */
  triggers: string[];
  
  /** Ordered list of steps */
  steps: WorkflowStep[];
  
  /** Called after all steps complete */
  onComplete?: (envelope: Envelope, ctx: WorkflowContext) => Promise<void>;
}

/**
 * Result of workflow execution
 */
export interface WorkflowResult {
  success: boolean;
  workflow: string;
  steps_executed: number;
  steps_total: number;
  results: WorkflowResults;
  duration_ms: number;
  error?: string;
}
```

---

## Step 2: Create Workflow Engine

Create `platform/src/workflows/engine.ts`:

```typescript
import type { Envelope } from '../types/envelope.js';
import type { WorkflowDefinition, WorkflowContext, WorkflowResult, WorkflowStep } from './types.js';
import { registry, createSkillContext } from '../skills/index.js';
import { addEnrichment, logFailure } from '../core/envelope-factory.js';

/**
 * Workflow Engine
 * 
 * Executes registered workflows by chaining skills together.
 */
class WorkflowEngine {
  private workflows: Map<string, WorkflowDefinition> = new Map();
  private triggerIndex: Map<string, string[]> = new Map();  // trigger -> workflow names
  
  /**
   * Register a workflow
   */
  register(workflow: WorkflowDefinition): void {
    if (this.workflows.has(workflow.name)) {
      throw new Error(`Workflow '${workflow.name}' already registered`);
    }
    
    this.workflows.set(workflow.name, workflow);
    
    // Index triggers
    for (const trigger of workflow.triggers) {
      const existing = this.triggerIndex.get(trigger) || [];
      existing.push(workflow.name);
      this.triggerIndex.set(trigger, existing);
    }
    
    console.log(`📋 Registered workflow: ${workflow.name} (triggers: ${workflow.triggers.join(', ')})`);
  }
  
  /**
   * Find workflows for a trigger
   */
  findByTrigger(trigger: string): WorkflowDefinition[] {
    const names = this.triggerIndex.get(trigger) || [];
    return names.map(name => this.workflows.get(name)!).filter(Boolean);
  }
  
  /**
   * Find workflow by name
   */
  get(name: string): WorkflowDefinition | undefined {
    return this.workflows.get(name);
  }
  
  /**
   * Execute a workflow
   */
  async execute(
    workflowName: string,
    envelope: Envelope
  ): Promise<WorkflowResult> {
    const startTime = Date.now();
    
    const workflow = this.workflows.get(workflowName);
    if (!workflow) {
      return {
        success: false,
        workflow: workflowName,
        steps_executed: 0,
        steps_total: 0,
        results: {},
        duration_ms: Date.now() - startTime,
        error: `Workflow '${workflowName}' not found`,
      };
    }
    
    console.log(`\n🚀 Starting workflow: ${workflow.name}`);
    
    // Create context
    const baseContext = createSkillContext(envelope);
    const context: WorkflowContext = {
      ...baseContext,
      results: {},
    };
    
    let stepsExecuted = 0;
    
    try {
      // Execute steps
      for (let i = 0; i < workflow.steps.length; i++) {
        const step = workflow.steps[i];
        
        // Check condition
        if (step.condition && !step.condition(context)) {
          context.log(`⏭️ Skipping step ${i + 1}: ${step.name} (condition not met)`);
          continue;
        }
        
        context.log(`📌 Step ${i + 1}/${workflow.steps.length}: ${step.name}`);
        
        try {
          const stepStart = Date.now();
          
          // Build input
          const input = step.buildInput(envelope, context);
          
          // Get skill and execute
          const skill = registry.get(step.skill);
          const result = await skill.execute(input, context);
          
          // Store result
          if (step.outputKey) {
            context.results[step.outputKey] = result;
          }
          context.results[step.name] = result;
          
          // Log to envelope
          addEnrichment(envelope, step.name, result, stepStart);
          
          stepsExecuted++;
          
        } catch (stepError) {
          context.log(`❌ Step failed: ${step.name} - ${stepError}`, 'error');
          logFailure(envelope, step.name, String(stepError), Date.now());
          
          const errorHandling = step.onError || 'fail';
          
          if (errorHandling === 'fail') {
            throw stepError;
          } else if (errorHandling === 'skip') {
            context.log(`⏭️ Skipping failed step: ${step.name}`);
            continue;
          } else {
            // continue - log and proceed
            context.log(`⚠️ Continuing despite error in: ${step.name}`, 'warn');
          }
        }
      }
      
      // Run completion handler
      if (workflow.onComplete) {
        await workflow.onComplete(envelope, context);
      }
      
      envelope.routing.status = 'completed';
      
      const duration = Date.now() - startTime;
      console.log(`✅ Workflow complete: ${workflow.name} (${duration}ms)`);
      
      return {
        success: true,
        workflow: workflow.name,
        steps_executed: stepsExecuted,
        steps_total: workflow.steps.length,
        results: context.results,
        duration_ms: duration,
      };
      
    } catch (error) {
      envelope.routing.status = 'failed';
      
      return {
        success: false,
        workflow: workflow.name,
        steps_executed: stepsExecuted,
        steps_total: workflow.steps.length,
        results: context.results,
        duration_ms: Date.now() - startTime,
        error: String(error),
      };
    }
  }
  
  /**
   * List registered workflows
   */
  list(): Array<{ name: string; description: string; triggers: string[] }> {
    return Array.from(this.workflows.values()).map(w => ({
      name: w.name,
      description: w.description,
      triggers: w.triggers,
    }));
  }
}

// Singleton instance
export const engine = new WorkflowEngine();
```

---

## Step 3: Convert Existing Workflows

Convert `platform/src/workflows/process-thought.ts`:

```typescript
import type { WorkflowDefinition } from './types.js';

export const processThoughtWorkflow: WorkflowDefinition = {
  name: 'process-thought',
  description: 'Process and store a thought/note',
  version: '1.0.0',
  triggers: ['intent:thought', 'intent:question'],
  
  steps: [
    {
      name: 'embed',
      skill: 'embed',
      buildInput: (envelope) => ({
        text: envelope.raw.content || '',
      }),
      outputKey: 'embedding',
    },
    {
      name: 'store',
      skill: 'store-memory',
      buildInput: (envelope, ctx) => {
        const embedding = ctx.results.embedding as { vector: number[] };
        return {
          id: envelope.trace_id,
          vector: embedding.vector,
          type: 'thought',
          content: envelope.raw.content || '',
          tags: extractHashtags(envelope.raw.content || ''),
        };
      },
      outputKey: 'stored',
    },
  ],
};

function extractHashtags(text: string): string[] {
  const matches = text.match(/#\w+/g);
  return matches ? matches.map(tag => tag.slice(1).toLowerCase()) : [];
}
```

Convert to workflow definition format for `process-link` and `process-task` as well.

---

## Step 4: Create Workflow Registry

Create `platform/src/workflows/index.ts`:

```typescript
export * from './types.js';
export { engine } from './engine.js';

// Import workflow definitions
import { processThoughtWorkflow } from './process-thought.js';
// import { processLinkWorkflow } from './process-link-workflow.js';
// import { processTaskWorkflow } from './process-task-workflow.js';

import { engine } from './engine.js';

/**
 * Register all core workflows
 */
export function registerWorkflows(): void {
  engine.register(processThoughtWorkflow);
  // engine.register(processLinkWorkflow);
  // engine.register(processTaskWorkflow);
  
  console.log('✅ Workflows registered');
  console.log(`   Available: ${engine.list().map(w => w.name).join(', ')}`);
}
```

---

## Step 5: Update Application Startup

Update `platform/src/index.ts`:

```typescript
import { registerCoreSkills } from './skills/index.js';
import { registerWorkflows } from './workflows/index.js';

async function start() {
  // ... existing startup ...
  
  // Register skills
  registerCoreSkills();
  
  // Register workflows
  registerWorkflows();
  
  // ... rest of startup ...
}
```

---

## Step 6: Update Message Processor to Use Engine

Update `platform/src/workers/message-processor.ts`:

```typescript
import { engine } from '../workflows/index.js';

// In processMessage, replace workflow routing:

// Get suggested workflow from classification
const workflowName = classification.suggested_workflow;

// Execute workflow
if (engine.get(workflowName)) {
  console.log(`🚀 Executing workflow: ${workflowName}`);
  const result = await engine.execute(workflowName, envelope);
  
  if (result.success) {
    // Handle successful completion
    await notifyUser(data.chatId, workflowName, result.results);
  } else {
    console.error(`Workflow failed: ${result.error}`);
  }
  return;
}

// Fallback to default processing if no workflow matched
console.log('⚠️ No workflow matched, using default processing');
// ... existing default processing ...
```

---

## Usage Example

```typescript
import { engine } from './workflows/index.js';

// Execute a workflow
const result = await engine.execute('process-thought', envelope);

if (result.success) {
  console.log(`Completed in ${result.duration_ms}ms`);
  console.log(`Steps: ${result.steps_executed}/${result.steps_total}`);
  console.log('Results:', result.results);
}
```

---

## Testing

```bash
# Start the platform
pnpm dev

# Check logs for workflow registration
# Should see: "✅ Workflows registered"
# Should see: "   Available: process-thought, process-link, process-task"

# Send a message and check workflow execution logs
```

---

## Acceptance Criteria

- [ ] `src/workflows/types.ts` defines all interfaces
- [ ] `src/workflows/engine.ts` executes workflows
- [ ] Existing workflows converted to definitions
- [ ] Workflows registered at startup
- [ ] Message processor uses engine
- [ ] Step conditions work
- [ ] Error handling per step
- [ ] `pnpm typecheck` passes

---

## Phase 3 Extensions (Future)

The following are deferred to Phase 3:

### YAML Definitions
```yaml
name: process-link
triggers:
  - intent:link
steps:
  - name: extract-url
    skill: extract-url
    input:
      text: "{{ envelope.raw.content }}"
    output: url_result
```

### Parallel Blocks
```typescript
{
  parallel: [
    { name: 'summarize', skill: 'summarize', ... },
    { name: 'embed', skill: 'embed', ... },
  ]
}
```

### Dynamic Workflow Loading
```typescript
const workflows = await loadWorkflowsFromDirectory('./workflows/*.yaml');
```

---

## Next Packet

After completing W14, proceed to:
- [W15: Enhanced Telegram](./W15-enhanced-telegram.md) - Final integration
