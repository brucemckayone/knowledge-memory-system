# Work Packet W08: Skill Framework

**Status:** Ready to Implement  
**Dependencies:** None (Phase 1 Complete)  
**Estimated Time:** 2 hours

---

## Objective

Create a modular skill system that encapsulates atomic capabilities (embed, transcribe, summarize, etc.) with a standardized interface. This is the foundation for all Phase 2 processing.

---

## Background

Currently, `message-processor.ts` directly calls service functions like `embed()` and `storeMemory()`. This works but lacks:

- **Modularity**: Can't easily add new processing steps
- **Reusability**: Same logic might be needed in different contexts
- **Testability**: Hard to mock individual capabilities
- **Extensibility**: No plugin system for future skills

The Skill Framework provides a standard interface for all processing capabilities.

---

## Architecture

### Skill Interface

```typescript
// src/skills/types.ts

/**
 * Base skill interface
 * Every skill implements this contract
 */
export interface Skill<TInput = unknown, TOutput = unknown> {
  /** Unique skill identifier */
  name: string;
  
  /** Human-readable description */
  description: string;
  
  /** Semantic version */
  version: string;
  
  /**
   * Execute the skill
   * @param input - Skill-specific input
   * @param context - Shared context with services
   * @returns Skill-specific output
   */
  execute(input: TInput, context: SkillContext): Promise<TOutput>;
}

/**
 * Context passed to every skill execution
 */
export interface SkillContext {
  /** Current envelope being processed */
  envelope: Envelope;
  
  /** Application configuration */
  config: Config;
  
  /** Shared services */
  services: SkillServices;
  
  /** Logging function */
  log: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

/**
 * Services available to skills
 */
export interface SkillServices {
  /** ML service client */
  ml: {
    embed: typeof embed;
    transcribe: typeof transcribe;
  };
  
  /** Qdrant client */
  qdrant: {
    storeMemory: typeof storeMemory;
    searchMemories: typeof searchMemories;
  };
  
  /** Database client */
  db: typeof db;
  
  /** Queue for scheduling jobs */
  boss: PgBoss;
}
```

### Skill Registry

```typescript
// src/skills/registry.ts

import type { Skill, SkillContext } from './types.js';

/**
 * Registry for all available skills
 */
class SkillRegistry {
  private skills: Map<string, Skill> = new Map();
  
  /**
   * Register a skill
   */
  register<TInput, TOutput>(skill: Skill<TInput, TOutput>): void {
    if (this.skills.has(skill.name)) {
      throw new Error(`Skill '${skill.name}' already registered`);
    }
    this.skills.set(skill.name, skill as unknown as Skill);
    console.log(`📦 Registered skill: ${skill.name} v${skill.version}`);
  }
  
  /**
   * Get a skill by name
   */
  get<TInput, TOutput>(name: string): Skill<TInput, TOutput> {
    const skill = this.skills.get(name);
    if (!skill) {
      throw new Error(`Skill '${name}' not found`);
    }
    return skill as unknown as Skill<TInput, TOutput>;
  }
  
  /**
   * Check if a skill exists
   */
  has(name: string): boolean {
    return this.skills.has(name);
  }
  
  /**
   * List all registered skills
   */
  list(): Array<{ name: string; description: string; version: string }> {
    return Array.from(this.skills.values()).map(s => ({
      name: s.name,
      description: s.description,
      version: s.version,
    }));
  }
}

// Singleton instance
export const registry = new SkillRegistry();
```

---

## File Structure

```
platform/src/skills/
├── types.ts           # Skill interfaces
├── registry.ts        # Skill registry
├── context.ts         # Context factory
├── index.ts           # Exports + auto-registration
└── core/
    ├── embed.skill.ts
    ├── transcribe.skill.ts
    ├── store-memory.skill.ts
    └── classify.skill.ts (placeholder)
```

---

## Step 1: Create Types

Create `platform/src/skills/types.ts`:

```typescript
import type { Envelope } from '../types/envelope.js';
import type { Config } from '../config.js';
import type PgBoss from 'pg-boss';

/**
 * Base skill interface
 */
export interface Skill<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  version: string;
  execute(input: TInput, context: SkillContext): Promise<TOutput>;
}

/**
 * Context passed to every skill
 */
export interface SkillContext {
  envelope: Envelope;
  config: Config;
  services: SkillServices;
  log: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

/**
 * Services available to skills
 */
export interface SkillServices {
  ml: {
    embed: (text: string) => Promise<{ vector: number[]; model: string; dimensions: number }>;
    transcribe: (url: string) => Promise<{ text: string; language: string; duration_ms: number }>;
  };
  qdrant: {
    storeMemory: (memory: { id: string; vector: number[]; payload: Record<string, unknown> }) => Promise<void>;
    searchMemories: (vector: number[], options?: { limit?: number }) => Promise<any[]>;
  };
  db: any; // Drizzle client
  boss: PgBoss;
}

/**
 * Result wrapper for skill execution
 */
export interface SkillResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  duration_ms: number;
}
```

---

## Step 2: Create Registry

Create `platform/src/skills/registry.ts`:

```typescript
import type { Skill } from './types.js';

class SkillRegistry {
  private skills: Map<string, Skill> = new Map();

  register<TInput, TOutput>(skill: Skill<TInput, TOutput>): void {
    if (this.skills.has(skill.name)) {
      throw new Error(`Skill '${skill.name}' already registered`);
    }
    this.skills.set(skill.name, skill as unknown as Skill);
    console.log(`📦 Registered skill: ${skill.name} v${skill.version}`);
  }

  get<TInput, TOutput>(name: string): Skill<TInput, TOutput> {
    const skill = this.skills.get(name);
    if (!skill) {
      throw new Error(`Skill '${name}' not found`);
    }
    return skill as Skill<TInput, TOutput>;
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  list(): Array<{ name: string; description: string; version: string }> {
    return Array.from(this.skills.values()).map(s => ({
      name: s.name,
      description: s.description,
      version: s.version,
    }));
  }

  async execute<TInput, TOutput>(
    skillName: string,
    input: TInput,
    context: import('./types.js').SkillContext
  ): Promise<import('./types.js').SkillResult<TOutput>> {
    const start = Date.now();
    const skill = this.get<TInput, TOutput>(skillName);
    
    try {
      context.log(`Executing skill: ${skillName}`);
      const data = await skill.execute(input, context);
      return {
        success: true,
        data,
        duration_ms: Date.now() - start,
      };
    } catch (error) {
      context.log(`Skill failed: ${skillName} - ${error}`, 'error');
      return {
        success: false,
        error: String(error),
        duration_ms: Date.now() - start,
      };
    }
  }
}

export const registry = new SkillRegistry();
```

---

## Step 3: Create Context Factory

Create `platform/src/skills/context.ts`:

```typescript
import type { Envelope } from '../types/envelope.js';
import type { SkillContext, SkillServices } from './types.js';
import { config } from '../config.js';
import { embed, transcribe } from '../services/ml.js';
import { storeMemory, searchMemories } from '../services/qdrant.js';
import { db } from '../db/index.js';
import { getQueue } from '../queue/index.js';

/**
 * Create a skill context for processing
 */
export function createSkillContext(envelope: Envelope): SkillContext {
  const services: SkillServices = {
    ml: { embed, transcribe },
    qdrant: { storeMemory, searchMemories },
    db,
    boss: getQueue(),
  };

  return {
    envelope,
    config,
    services,
    log: (message: string, level: 'info' | 'warn' | 'error' = 'info') => {
      const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '📋';
      console.log(`${prefix} [${envelope.trace_id.slice(0, 8)}] ${message}`);
    },
  };
}
```

---

## Step 4: Create Embed Skill

Create `platform/src/skills/core/embed.skill.ts`:

```typescript
import type { Skill, SkillContext } from '../types.js';

export interface EmbedInput {
  text: string;
  model?: string;
}

export interface EmbedOutput {
  vector: number[];
  model: string;
  dimensions: number;
}

export const embedSkill: Skill<EmbedInput, EmbedOutput> = {
  name: 'embed',
  description: 'Generate embedding vector for text using Ollama',
  version: '1.0.0',

  async execute(input: EmbedInput, context: SkillContext): Promise<EmbedOutput> {
    context.log(`Generating embedding for ${input.text.length} chars`);
    
    const result = await context.services.ml.embed(input.text);
    
    context.log(`Generated ${result.dimensions}-dim vector`);
    
    return result;
  },
};
```

---

## Step 5: Create Store Memory Skill

Create `platform/src/skills/core/store-memory.skill.ts`:

```typescript
import type { Skill, SkillContext } from '../types.js';

export interface StoreMemoryInput {
  id: string;
  vector: number[];
  type: string;
  content: string;
  summary?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface StoreMemoryOutput {
  memory_id: string;
  stored_at: string;
}

export const storeMemorySkill: Skill<StoreMemoryInput, StoreMemoryOutput> = {
  name: 'store-memory',
  description: 'Store a memory in Qdrant vector database',
  version: '1.0.0',

  async execute(input: StoreMemoryInput, context: SkillContext): Promise<StoreMemoryOutput> {
    context.log(`Storing memory: ${input.type}`);
    
    const stored_at = new Date().toISOString();
    
    await context.services.qdrant.storeMemory({
      id: input.id,
      vector: input.vector,
      payload: {
        trace_id: input.id,
        type: input.type,
        content: input.content,
        summary: input.summary || input.content.slice(0, 200),
        tags: input.tags || [],
        created_at: stored_at,
        status: 'active',
        origin: context.envelope.origin,
        ...input.metadata,
      },
    });
    
    context.log(`Memory stored: ${input.id}`);
    
    return {
      memory_id: input.id,
      stored_at,
    };
  },
};
```

---

## Step 6: Create Transcribe Skill

Create `platform/src/skills/core/transcribe.skill.ts`:

```typescript
import type { Skill, SkillContext } from '../types.js';

export interface TranscribeInput {
  audio_url: string;
  language?: string;
}

export interface TranscribeOutput {
  text: string;
  language: string;
  duration_ms: number;
}

export const transcribeSkill: Skill<TranscribeInput, TranscribeOutput> = {
  name: 'transcribe',
  description: 'Transcribe audio to text using Whisper',
  version: '1.0.0',

  async execute(input: TranscribeInput, context: SkillContext): Promise<TranscribeOutput> {
    context.log(`Transcribing audio: ${input.audio_url.slice(-20)}`);
    
    const result = await context.services.ml.transcribe(input.audio_url);
    
    context.log(`Transcribed ${result.duration_ms}ms audio → ${result.text.length} chars`);
    
    return result;
  },
};
```

---

## Step 7: Create Index with Auto-Registration

Create `platform/src/skills/index.ts`:

```typescript
// Types
export * from './types.js';

// Registry
export { registry } from './registry.js';

// Context
export { createSkillContext } from './context.js';

// Core skills
import { embedSkill } from './core/embed.skill.js';
import { storeMemorySkill } from './core/store-memory.skill.js';
import { transcribeSkill } from './core/transcribe.skill.js';
import { registry } from './registry.js';

// Auto-register core skills
export function registerCoreSkills(): void {
  registry.register(embedSkill);
  registry.register(storeMemorySkill);
  registry.register(transcribeSkill);
  
  console.log('✅ Core skills registered');
  console.log(`   Available: ${registry.list().map(s => s.name).join(', ')}`);
}

// Export individual skills for direct use
export { embedSkill, storeMemorySkill, transcribeSkill };
```

---

## Step 8: Update Application Startup

Modify `platform/src/index.ts` to register skills on startup:

```typescript
// Add import at top
import { registerCoreSkills } from './skills/index.js';

// In start() function, after queue initialization
async function start() {
  // ... existing code ...
  
  // Register core skills
  registerCoreSkills();
  
  // ... rest of startup ...
}
```

---

## Usage Example

After implementation, skills can be used like this:

```typescript
import { registry, createSkillContext } from './skills/index.js';

// In message processor
const context = createSkillContext(envelope);

// Execute embed skill
const embedResult = await registry.execute<EmbedInput, EmbedOutput>(
  'embed',
  { text: 'Hello world' },
  context
);

if (embedResult.success) {
  console.log(`Vector: ${embedResult.data.dimensions} dims`);
}
```

---

## Acceptance Criteria

- [ ] `src/skills/types.ts` exists with all interfaces
- [ ] `src/skills/registry.ts` compiles and exports registry
- [ ] `src/skills/context.ts` creates valid context
- [ ] `src/skills/core/embed.skill.ts` wraps ML embed
- [ ] `src/skills/core/store-memory.skill.ts` wraps Qdrant store
- [ ] `src/skills/core/transcribe.skill.ts` wraps ML transcribe
- [ ] `src/skills/index.ts` auto-registers skills
- [ ] `pnpm typecheck` passes
- [ ] Skills log execution with trace ID
- [ ] Skills can be retrieved by name from registry

---

## Verification

### Automated Tests
Run simple unit tests to verify the skill registry and context creation.

```bash
# Create platform/src/skills/__tests__/registry.test.ts
import { registry, createSkillContext } from '../index.js';
import { embedSkill } from '../core/embed.skill.js';
import { describe, it, expect } from 'vitest';

describe('Skill Registry', () => {
  it('should register and retrieve a skill', () => {
    registry.register(embedSkill);
    expect(registry.has('embed')).toBe(true);
    expect(registry.get('embed').name).toBe('embed');
  });

  it('should throw on missing skill', () => {
    expect(() => registry.get('missing-skill')).toThrow();
  });
});

# Run tests
pnpm test:unit src/skills
```

### Manual Verification
```bash
# Start and check logs for skill registration
pnpm dev
# Should see: "✅ Core skills registered"
# Should see: "   Available: embed, store-memory, transcribe"
```
---

## Next Packet

After completing W08, proceed to:
- [W09: LLM Router](./W09-llm-router.md) - Uses skill framework
- [W10: Voice Transcription](./W10-voice-transcription.md) - Can be done in parallel
