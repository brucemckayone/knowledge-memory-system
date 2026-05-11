# Cognitive Platform V2: Proactive Personal Life OS Agent

## Executive Summary

**Current State:** The system implements a sophisticated reactive router - LLM classifies incoming messages, routes them to appropriate workflows (task/thought/link/question), and processes them through a KARMA pipeline. While powerful, it has an "error state" problem: vague messages are rejected or create low-quality outputs.

**Proposed Vision:** Transform from reactive router to proactive Personal Life OS Agent - a system that:
1. **Maintains rich long-term user context** (goals, preferences, life patterns, interests)
2. **Runs periodically** to review past activity (day, week, month)
3. **Learns continuously** from user behavior and builds a comprehensive understanding
4. **Acts proactively** - creates tasks, goals, content (articles, podcasts, meditations)
5. **Uses agentic tool-calling** to gather context before making decisions
6. **Operates multi-turn** - asks clarifying questions instead of rejecting

This document outlines an architecture that integrates agentic tool-calling infrastructure with a proactive, context-aware agent system.

---

## Table of Contents

1. [Current Architecture Analysis](#current-architecture-analysis)
2. [Architectural Problems & Limitations](#architectural-problems--limitations)
3. [Vision: Proactive Personal Life OS](#vision-proactive-personal-life-os)
4. [System Architecture Redesign](#system-architecture-redesign)
5. [Long-Term User Context Storage](#long-term-user-context-storage)
6. [Agentic Tool-Calling Infrastructure](#agentic-tool-calling-infrastructure)
7. [Proactive Agent System](#proactive-agent-system)
8. [Implementation Roadmap](#implementation-roadmap)
9. [Success Criteria](#success-criteria)

---

## Current Architecture Analysis

### Message Flow (Current)

```
User Message → Envelope Creation → LLM Classification → Routing Decision
                                                    ↓
                                    ┌───────────────┼───────────────┐
                                    ↓               ↓               ↓
                              Task Workflow   Link Workflow   Thought Workflow
                                    ↓               ↓               ↓
                              Task Extraction  URL Fetch    Embed → Store
                              Quality Gates    Summarize         ↓
                                    ↓               ↓        KARMA Pipeline
                              Create Task      Store
```

### Strengths of Current System

1. **Modular Architecture:** Clean separation between skills, agents, and workflows
2. **Hybrid Storage:** PostgreSQL (structured) + Qdrant (vector embeddings)
3. **Sophisticated KARMA Pipeline:** Multi-phase background processing
4. **Rich Task Model:** Hierarchical tasks, dependencies, conflicts, temporal tracking
5. **User Preference Learning:** Confidence-based preference tracking
6. **Tier-Based Job Queue:** Four-tier prioritization (realtime, frequent, periodic, deep)

### Current Agent System (Gardener)

**Agent Tiers:**
- **realtime** (30s): ingestion, transcription
- **frequent** (2m): summarizer, evaluator
- **periodic** (10m): schema alignment, conflict resolution
- **deep** (1h): community detection, insight generation

**KARMA Pipeline:**
```
Ingestion → Reading → Summarization → Entity Extraction →
Relationship Building → Schema Alignment → Conflict Resolution →
Pattern Detection (Periodic)
```

**Key Finding:** The system already has:
- Background job processing infrastructure (pg-boss)
- Agent registration and execution framework
- Checkpoint/restore for long-running jobs
- MAB-based priority adjustment
- Chained job execution (`nextJobs` pattern)

**What's Missing:** The agents are reactive (processing what's given) rather than proactive (seeking opportunities to help).

---

## Architectural Problems & Limitations

### 1. Reactive Router Problem

**Problem:** System classifies and routes - doesn't engage in multi-turn reasoning.

**Example:**
```
User: "I need to remember to take out the bins when i get ..."
Current: Classify as task → Extract → Low quality → REJECT ❌
Desired: Search memories → Find pattern → Ask "When do you usually take them out?"
```

### 2. Ephemeral User Context

**Problem:** User state is scattered and conversation-scoped.

**Current State:**
- `userPreferences`: Individual learned behaviors (urgency, working hours)
- `contextSummaries`: Per-conversation summaries
- `contextUuid`: Platform+conversationId → deterministic UUID
- **No cross-platform user identity**
- **No long-term goals tracking**
- **No life narrative or personality model**

### 3. No Proactive Behavior

**Problem:** System waits for input - never initiates action or generates insights.

**Missing Capabilities:**
- Periodic review of user activity
- Goal progress tracking
- Proactive task creation based on patterns
- Content generation (articles, meditations)
- Life coaching insights

### 4. Context Isolation

**Problem:** Each conversation is isolated - no unified view of user across platforms.

**Impact:**
- Can't learn from cross-platform patterns
- Duplicate memories across conversations
- Inconsistent user modeling
- No "life narrative" building

---

## Vision: Proactive Personal Life OS

### Core Concept

**A Personal Life OS Agent is:**
- **Always Learning:** Builds rich model of user from every interaction
- **Periodically Reflecting:** Reviews day/week/month to extract insights
- **Proactively Helping:** Creates tasks, goals, content without explicit request
- **Context-Aware:** Uses long-term understanding to make better decisions
- **Multi-Turn:** Engages in conversation instead of rejecting unclear input

### User Experience Examples

#### Example 1: Vague Task with Context
```
Day 1:
User: "I need to remember to take out the bins when i get ..."
System: "I see you usually take out bins on Tuesday evenings at 7pm.
         Should I create a reminder for this Tuesday?"
User: "Yes"
System: "✅ Created task: Take out bins on Tuesday at 7pm"

[Three weeks later - System notices pattern]
System: "I've noticed you've been taking out bins every Tuesday at 7pm.
         Would you like me to make this a recurring task?"
User: "Please"
System: "✅ Created recurring task: Take out bins every Tuesday at 7pm"
```

#### Example 2: Proactive Goal Tracking
```
[System runs weekly review - notices goal-related activity]

System: "I noticed you mentioned 'learn Spanish' 3 times this week
         and spent 2 hours on Spanish resources. You said you wanted
         to reach conversational level by December. At this pace,
         you're on track! Would you like me to:
         a) Schedule daily practice sessions
         b) Find more Spanish resources
         c) Track progress with weekly check-ins"

User: "Let's do daily practice + weekly check-ins"
System: "✅ Created daily Spanish practice task (30 min)
         ✅ Created weekly review task (Sundays at 9am)"
```

#### Example 3: Proactive Content Generation
```
[System runs monthly analysis - notices meditation interest]

System: "I've noticed you've been stressed about work deadlines lately
         and have been researching mindfulness. Based on your interests
         in stoicism and your schedule (20min free in mornings), I've
         created a personalized guided meditation:

         🧘 **Morning Stoic Reflection**
         A 20-minute daily meditation combining your interest in
         Marcus Aurelius with practical stress management.

         Want me to send this every morning at 7am?"

User: "That's perfect!"
System: "✅ Scheduled daily stoic meditation delivery"
```

### System Capabilities

**1. Context-Rich Understanding**
- User goals and objectives (short-term, long-term)
- Life patterns and routines
- Interests and preferences
- Social network (relationships from entities)
- Emotional patterns (from sentiment analysis)

**2. Agentic Tool-Calling**
- Search similar memories before deciding
- Search existing tasks to avoid duplicates
- Ask clarifying questions when uncertain
- Create tasks with confidence scores
- Update user model based on interactions

**3. Proactive Operations**
- Daily review: Summarize day's activities, highlight important items
- Weekly review: Goal progress, pattern detection, task suggestions
- Monthly review: Life narrative updates, goal achievement analysis
- Content generation: Articles, meditations, learning plans

**4. Multi-Turn Conversations**
- Conversation state management
- Context accumulation across turns
- Clarifying question flows
- Progressive refinement of understanding

---

## System Architecture Redesign

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Personal Life OS Agent                      │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │            Reactive Layer (Current + Enhanced)           │  │
│  │                                                           │  │
│  │  Message → Classify → Agentic Router → Tool Execution    │  │
│  │                                                           │  │
│  │  - Multi-turn conversations                              │  │
│  │  - Clarifying questions                                  │  │
│  │  - Context-aware routing                                 │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              ↑↓                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Proactive Layer (NEW)                       │  │
│  │                                                           │  │
│  │  Periodic Agents:                                        │  │
│  │  - Daily Review Agent                                    │  │
│  │  - Weekly Review Agent                                   │  │
│  │  - Monthly Review Agent                                  │  │
│  │  - Content Generation Agent                              │  │
│  │  - Goal Tracking Agent                                   │  │
│  │                                                           │  │
│  │  Uses tools to:                                          │  │
│  │  - Read long-term user context                           │  │
│  │  - Analyze recent activity                               │  │
│  │  - Generate insights                                     │  │
│  │  - Create tasks/goals/content                            │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              ↑↓                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │           Long-Term User Context Store (NEW)             │  │
│  │                                                           │  │
│  │  - User Profile (identity, cross-platform)               │  │
│  │  - Goals & Objectives                                     │  │
│  │  - Life Patterns & Routines                              │  │
│  │  - Interests & Preferences (enhanced)                    │  │
│  │  - Learning History                                      │  │
│  │  - Emotional Patterns                                    │  │
│  │  - Social Graph (from entities)                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              ↑↓                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Tool Registry (Enhanced)                    │  │
│  │                                                           │  │
│  │  Reactive Tools:                                         │  │
│  │  - searchSimilarMemories                                 │  │
│  │  - searchExistingTasks                                   │  │
│  │  - askClarifyingQuestion                                 │  │
│  │  - createTaskWithConfidence                              │  │
│  │                                                           │  │
│  │  Proactive Tools:                                        │  │
│  │  - getUserProfile                                        │  │
│  │  - getGoals                                              │  │
│  │  - analyzePatterns                                       │  │
│  │  - generateContent                                       │  │
│  │  - createGoal                                            │  │
│  │  - updateLifeNarrative                                   │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ↑↓
┌─────────────────────────────────────────────────────────────────┐
│                    Storage Layer (Enhanced)                     │
│                                                                  │
│  PostgreSQL (Structured):     Qdrant (Vector):                  │
│  - Tasks                      - Memories (content)              │
│  - Entities                   - Contexts                        │
│  - Facts                      - User Context Embeddings         │
│  - User Preferences           - Life Narrative Embeddings       │
│  - [NEW] User Profiles                                          │
│  - [NEW] Goals                                                  │
│  - [NEW] Life Patterns                                          │
│  - [NEW] Conversation State                                     │
└─────────────────────────────────────────────────────────────────┘
```

### Key Architectural Changes

#### 1. Three-Tier Agent System

**Reactive Agents (Realtime):**
- Process incoming messages immediately
- Multi-turn conversations
- Tool-calling for context gathering

**Proactive Agents (Scheduled):**
- Daily/weekly/monthly reviews
- Pattern analysis and insight generation
- Content creation
- Goal tracking

**Learning Agents (Deep):**
- Continuous model updates
- Long-term pattern detection
- Life narrative construction

#### 2. Cross-Platform User Identity

**New Concept:** `UserProfile` - Unified identity across platforms

```typescript
interface UserProfile {
  id: string;  // Unified user ID

  // Identity resolution
  platformIdentities: Array<{
    platform: string;
    platformUserId: string;
    conversationId: string;
    confidence: number;
  }>;

  // Core profile
  displayName?: string;
  timezone: string;
  preferredLanguage: string;

  // Life patterns (learned)
  workingHours: { start: string; end: string; days: number[] };
  activeHours: { hour: number; day: number; count: number }[];

  // Personality and communication
  communicationStyle: 'concise' | 'detailed' | 'conversational';
  formalityLevel: number;  // 0-1

  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}
```

#### 3. Goal and Objective Tracking

**New Concept:** `Goal` - Long-term objectives with progress tracking

```typescript
interface Goal {
  id: string;
  userId: string;  // Unified user ID

  // Goal definition
  title: string;
  description: string;
  category: 'personal' | 'professional' | 'health' | 'learning' | 'relationship';

  // Temporal
  targetDate?: Date;
  createdAt: Date;
  completedAt?: Date;

  // Progress
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  progress: number;  // 0-1
  progressMetric?: string;  // "hours spent", "tasks completed", etc.

  // Related data
  relatedTasks: string[];  // Task IDs
  relatedGoals: string[];  // Sub-goals or parent goals
  relatedMemories: string[];  // Context

  // Proactive generation
  autoGenerated: boolean;
  generationConfidence: number;

  // Source
  source: 'user_explicit' | 'system_inferred' | 'pattern_detected';
}
```

#### 4. Conversation State Management

**New Concept:** `ConversationState` - Multi-turn conversation tracking

```typescript
interface ConversationState {
  id: string;
  userId: string;  // Unified user ID
  platformConversationId: string;

  // Conversation phase
  phase: 'extracting' | 'clarifying' | 'executing' | 'done';

  // Context accumulation
  originalMessage?: string;
  messageHistory: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
  }>;

  // Pending clarifications
  pendingQuestion?: {
    question: string;
    context: Record<string, any>;
    askedAt: Date;
  };

  // Tool execution history
  toolCallHistory: Array<{
    tool: string;
    args: Record<string, any>;
    result: Record<string, any>;
    timestamp: Date;
  }>;

  // Accumulated context
  context: {
    similarMemories: Memory[];
    relatedTasks: Task[];
    userGoals: Goal[];
    extractionAttempts: number;
  };

  // TTL
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
```

---

## Long-Term User Context Storage

### Storage Philosophy

**Key Decision:** What goes in PostgreSQL vs Qdrant vs Files?

| Data Type | Storage | Rationale |
|-----------|---------|-----------|
| User Profile | PostgreSQL | Structured, frequently queried, relational |
| Goals | PostgreSQL | Structured, relational to tasks, temporal tracking |
| Life Patterns | PostgreSQL | Semi-structured, aggregated data, statistical |
| Conversation State | PostgreSQL + TTL | Ephemeral, structured, needs fast access/expiration |
| Life Narrative | PostgreSQL + Qdrant | Summary in Postgres, full narrative embedded in Qdrant |
| User Context Embeddings | Qdrant | Semantic search, similarity matching |
| Raw Memories | Qdrant | Vector search, unstructured content |
| Tasks | PostgreSQL | Structured, relational, complex queries |
| Entities | PostgreSQL | Graph structure, relationships |
| Facts | PostgreSQL | Bi-temporal, structured triples |

### Database Schema Extensions

#### New Table: `user_profiles`

```sql
CREATE TABLE user_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name VARCHAR(255),

  -- Timezone and locale
  timezone VARCHAR(100) DEFAULT 'UTC',
  preferred_language VARCHAR(10) DEFAULT 'en',

  -- Life patterns (aggregated)
  working_hours_start VARCHAR(5),  -- "09:00"
  working_hours_end VARCHAR(5),    -- "17:00"
  working_days INTEGER[],          -- [1,2,3,4,5]
  active_hours JSONB,              -- [{hour, day, count}, ...]

  -- Communication style
  communication_style VARCHAR(20) DEFAULT 'conversational',
  formality_level REAL DEFAULT 0.5,

  -- Metadata
  metadata JSONB DEFAULT '{}',

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for platform identity lookups
CREATE INDEX idx_user_profiles_metadata ON user_profiles USING GIN(metadata);
```

#### New Table: `user_platform_identities`

```sql
-- Maps platform-specific identities to unified user profiles
CREATE TABLE user_platform_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_profile_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,  -- 'telegram', 'slack', etc.
  platform_user_id VARCHAR(255) NOT NULL,
  conversation_id VARCHAR(255),
  confidence REAL DEFAULT 1.0,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(platform, platform_user_id)
);

CREATE INDEX idx_platform_identities_lookup ON user_platform_identities(platform, platform_user_id);
CREATE INDEX idx_platform_identities_user ON user_platform_identities(user_profile_id);
```

#### New Table: `goals`

```sql
CREATE TABLE goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_profile_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,

  -- Goal definition
  title VARCHAR(500) NOT NULL,
  description TEXT,
  category VARCHAR(50) NOT NULL,  -- 'personal', 'professional', etc.

  -- Temporal
  target_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  -- Progress
  status VARCHAR(20) DEFAULT 'active',  -- 'active', 'paused', 'completed', 'cancelled'
  progress REAL DEFAULT 0,  -- 0-1
  progress_metric VARCHAR(100),

  -- Proactive generation
  auto_generated BOOLEAN DEFAULT FALSE,
  generation_confidence REAL,
  generation_reasoning TEXT,

  -- Source tracking
  source VARCHAR(50),  -- 'user_explicit', 'system_inferred', 'pattern_detected'
  source_memory_id UUID,  -- If inferred from memory

  -- Timestamps
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_goals_user_status ON goals(user_profile_id, status);
CREATE INDEX idx_goals_category ON goals(category);
CREATE INDEX idx_goals_target_date ON goals(target_date);
```

#### New Table: `goal_relations`

```sql
-- Relationships between goals (parent/child, related)
CREATE TABLE goal_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id UUID NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  related_goal_id UUID NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  relation_type VARCHAR(20) NOT NULL,  -- 'parent', 'child', 'related', 'depends_on'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(goal_id, related_goal_id, relation_type)
);

CREATE INDEX idx_goal_relations_goal ON goal_relations(goal_id);
CREATE INDEX idx_goal_relations_related ON goal_relations(related_goal_id);
```

#### New Table: `goal_progress_snapshots`

```sql
-- Track goal progress over time
CREATE TABLE goal_progress_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id UUID NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  progress REAL NOT NULL,
  metric_value JSONB,
  notes TEXT,
  snapshot_type VARCHAR(20) DEFAULT 'manual',  -- 'manual', 'automatic', 'milestone'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_goal_progress_goal ON goal_progress_snapshots(goal_id, created_at DESC);
```

#### New Table: `conversation_states`

```sql
-- Multi-turn conversation state
CREATE TABLE conversation_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_profile_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  platform_conversation_id VARCHAR(255) NOT NULL,

  -- Conversation phase
  phase VARCHAR(20) DEFAULT 'extracting',

  -- Context (JSONB for flexibility)
  original_message TEXT,
  message_history JSONB DEFAULT '[]',
  pending_question JSONB,
  tool_call_history JSONB DEFAULT '[]',
  accumulated_context JSONB DEFAULT '{}',

  -- TTL
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_conversation_states_lookup ON conversation_states(user_profile_id, platform_conversation_id);
CREATE INDEX idx_conversation_states_expires ON conversation_states(expires_at);

-- Cleanup function
CREATE OR REPLACE FUNCTION cleanup_expired_conversation_states()
RETURNS void AS $$
BEGIN
  DELETE FROM conversation_states WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;
```

#### New Table: `life_patterns`

```sql
-- Learned life patterns and routines
CREATE TABLE life_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_profile_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,

  -- Pattern definition
  pattern_type VARCHAR(50) NOT NULL,  -- 'temporal', 'behavioral', 'social', etc.
  pattern_name VARCHAR(255) NOT NULL,
  description TEXT,

  -- Pattern data
  pattern_data JSONB NOT NULL,  -- Flexible schema based on pattern_type

  -- Detection info
  detection_method VARCHAR(50),  -- 'statistical', 'llm', 'rule_based'
  confidence REAL DEFAULT 0.5,
  sample_count INTEGER DEFAULT 1,

  -- Temporal
  first_observed_at TIMESTAMPTZ DEFAULT NOW(),
  last_observed_at TIMESTAMPTZ DEFAULT NOW(),
  valid_from TIMESTAMPTZ DEFAULT NOW(),
  valid_until TIMESTAMPTZ,

  -- Metadata
  source_memories UUID[],  -- Memories that contributed to this pattern
  related_tasks UUID[],    -- Tasks that demonstrate this pattern
  related_goals UUID[],    -- Goals related to this pattern

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_life_patterns_user ON life_patterns(user_profile_id);
CREATE INDEX idx_life_patterns_type ON life_patterns(pattern_type);
CREATE INDEX idx_life_patterns_valid ON life_patterns(valid_from, valid_until);
```

#### Enhanced Table: `user_preferences`

**Current limitation:** Only tracks simple behavioral preferences

**Enhancement:** Add preference categories and hierarchical organization

```sql
-- Add columns (migration)
ALTER TABLE user_preferences ADD COLUMN category VARCHAR(50);
ALTER TABLE user_preferences ADD COLUMN preference_hierarchy JSONB;

-- Examples:
-- category: 'urgency' → key: 'urgent_same_day'
-- category: 'schedule' → key: 'working_hours_start'
-- category: 'personality' → key: 'communication_style'
-- category: 'interests' → key: 'interest_stoicism'
```

#### New Table: `life_narratives`

```sql
-- Long-form narrative summaries of user's life over time
CREATE TABLE life_narratives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_profile_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,

  -- Temporal scope
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  narrative_type VARCHAR(20) DEFAULT 'monthly',  -- 'daily', 'weekly', 'monthly', 'yearly'

  -- Narrative content
  title VARCHAR(500),
  summary TEXT NOT NULL,
  key_events JSONB,  -- Array of important events
  themes TEXT[],  -- Key themes during this period
  emotional_trajectory JSONB,  -- Emotional state over time

  -- Relationships
  important_entities UUID[],  -- Entities featured in this narrative
  related_goals UUID[],  -- Goals active during this period
  related_memories UUID[],  -- Key memories

  -- Embedding for semantic search (pgvector)
  embedding vector(768),

  -- Quality
  narrative_quality REAL DEFAULT 0.5,
  generation_method VARCHAR(50),  -- 'llm', 'template', 'hybrid'

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_life_narratives_user ON life_narratives(user_profile_id, period_start DESC);
CREATE INDEX idx_life_narratives_embedding ON life_narratives USING ivfflat(embedding vector_cosine_ops);
```

### Qdrant Collection Extensions

#### New Collection: `user_context_embeddings`

**Purpose:** Semantic search over user context for agentic decision-making

**Payload Structure:**
```typescript
{
  user_profile_id: string;
  context_type: 'goal' | 'pattern' | 'narrative' | 'preference';
  source_id: string;  // Goal ID, Pattern ID, etc.
  content: string;  // Text content for embedding
  period?: { start: Date; end: Date };  // For narratives
  confidence: number;
  created_at: Date;
}
```

**Use Cases:**
- Agent searches "user's goals related to learning" before creating learning task
- Agent finds "relevant patterns from similar time last year"
- Semantic matching of current context to historical patterns

---

## Agentic Tool-Calling Infrastructure

### Tool Registry Design

Building on the current skills system, we'll create a more sophisticated tool registry:

**Current Skills System:**
```typescript
interface Skill<TInput, TOutput> {
  name: string;
  description: string;
  version: string;
  execute: (input: TInput, context: SkillContext) => Promise<TOutput>;
}
```

**Enhanced Tool System:**
```typescript
interface ToolDefinition<TInput = any, TResult = any> {
  // Identity
  name: string;
  description: string;
  version: string;
  category: 'reactive' | 'proactive' | 'learning';

  // Schema
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TResult>;

  // Execution
  execute: (input: TInput, context: ToolContext) => Promise<TResult>;

  // Metadata
  examples?: ToolExample[];
  confidence?: (input: TInput) => number;  // Predict success confidence
  cost?: () => number;  // Execution cost (time/tokens)

  // Guards
  maxRetries?: number;
  timeout?: number;
}

interface ToolContext {
  // Services
  qdrant: QdrantService;
  db: Database;
  ml: MLService;

  // User context
  userId: string;  // Unified user profile ID
  platformUserId: string;
  conversationId: string;

  // Execution context
  traceId: string;
  toolCallHistory: ToolCall[];
  accumulatedContext: Record<string, any>;

  // Logging
  log: (message: string, level?: 'info' | 'warn' | 'error') => void;
}
```

### Reactive Tools (Multi-Turn Conversations)

#### Tool: `searchSimilarMemories`

**Purpose:** Find contextually similar memories before making decisions

```typescript
interface SearchSimilarMemoriesInput {
  query: string;
  limit?: number;
  timeRange?: { start: Date; end: Date };
  filters?: {
    types?: string[];
    tags?: string[];
    minConfidence?: number;
  };
}

interface SearchSimilarMemoriesOutput {
  memories: Array<{
    id: string;
    content: string;
    type: string;
    relevanceScore: number;
    createdAt: Date;
    entities: string[];
  }>;
  totalFound: number;
  searchMetadata: {
    queryEmbedding: number[];
    searchTimeMs: number;
  };
}

export const searchSimilarMemories: ToolDefinition<
  SearchSimilarMemoriesInput,
  SearchSimilarMemoriesOutput
> = {
  name: 'searchSimilarMemories',
  description: 'Search for semantically similar memories to understand context',
  category: 'reactive',
  version: '1.0.0',

  inputSchema: z.object({
    query: z.string(),
    limit: z.number().default(5),
    timeRange: z.object({
      start: z.date(),
      end: z.date(),
    }).optional(),
    filters: z.object({
      types: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      minConfidence: z.number().optional(),
    }).optional(),
  }),

  outputSchema: z.object({
    memories: z.array(z.object({
      id: z.string(),
      content: z.string(),
      type: z.string(),
      relevanceScore: z.number(),
      createdAt: z.date(),
      entities: z.array(z.string()),
    })),
    totalFound: z.number(),
    searchMetadata: z.object({
      queryEmbedding: z.array(z.number()),
      searchTimeMs: z.number(),
    }),
  }),

  async execute({ query, limit = 5, timeRange, filters }, context) {
    const { qdrant, userId, log } = context;

    log(`Searching memories for: "${query}"`);

    // Generate embedding
    const embeddingResult = await embed(query);

    // Build Qdrant filter
    const qdrantFilter = {
      must: [
        { key: 'sender_id', match: { value: userId } },
      ],
      ...(filters?.types && {
        must: [{ key: 'type', match: { any: filters.types } }],
      }),
      ...(timeRange && {
        must: [
          {
            key: 'created_at',
            range: {
              gte: timeRange.start.toISOString(),
              lte: timeRange.end.toISOString(),
            },
          },
        ],
      }),
    };

    // Search
    const results = await qdrant.search({
      collection: 'memories',
      vector: embeddingResult.vector,
      limit,
      filter: qdrantFilter,
    });

    return {
      memories: results.map(r => ({
        id: r.id,
        content: r.payload.content,
        type: r.payload.type,
        relevanceScore: r.score,
        createdAt: new Date(r.payload.created_at),
        entities: r.payload.entities || [],
      })),
      totalFound: results.length,
      searchMetadata: {
        queryEmbedding: embeddingResult.vector,
        searchTimeMs: 0,  // Track actual time
      },
    };
  },

  examples: [
    {
      input: { query: 'take out bins', limit: 3 },
      description: 'Find previous mentions of bin reminders',
    },
    {
      input: { query: 'spanish learning', timeRange: { start: new Date('2024-01-01'), end: new Date() } },
      description: 'Find recent Spanish learning activities',
    },
  ],

  confidence: (input) => {
    // Higher confidence for specific queries
    return input.query.length > 10 ? 0.8 : 0.5;
  },

  cost: () => 100,  // 100ms estimated
};
```

#### Tool: `searchExistingTasks`

**Purpose:** Check for duplicate or related tasks before creating

```typescript
interface SearchExistingTasksInput {
  query: string;
  status?: ('pending' | 'in_progress' | 'completed')[];
  limit?: number;
}

interface SearchExistingTasksOutput {
  tasks: Array<{
    id: string;
    content: string;
    status: string;
    priority: string;
    dueDate: Date | null;
    similarityScore: number;
  }>;
  duplicates: Array<typeof tasks>;  // Likely duplicates
}

export const searchExistingTasks: ToolDefinition<...> = {
  name: 'searchExistingTasks',
  description: 'Search existing tasks to avoid duplicates or find related work',
  category: 'reactive',

  async execute({ query, status, limit = 10 }, context) {
    const { db, userId } = context;

    // Hybrid search: vector + keyword
    const vectorResults = await vectorSearchTasks(query, limit);
    const keywordResults = await keywordSearchTasks(query, limit);

    // Merge and rank
    const merged = mergeAndRankResults(vectorResults, keywordResults);

    // Detect duplicates (high similarity)
    const duplicates = merged.filter(t => t.similarityScore > 0.85);

    return {
      tasks: merged,
      duplicates,
    };
  },
};
```

#### Tool: `askClarifyingQuestion`

**Purpose:** Request user input when intent is unclear

```typescript
interface AskClarifyingQuestionInput {
  question: string;
  context?: Record<string, any>;
  options?: string[];  // Multiple choice options
  priority?: 'low' | 'medium' | 'high';
}

interface AskClarifyingQuestionOutput {
  type: 'clarifying_question';
  questionId: string;
  question: string;
  context: Record<string, any>;
  options?: string[];
  expiresAt: Date;
  suggestedAnswers?: string[];
}

export const askClarifyingQuestion: ToolDefinition<...> = {
  name: 'askClarifyingQuestion',
  description: 'Ask the user a clarifying question when intent is unclear',
  category: 'reactive',

  async execute({ question, context, options, priority }, { userId, traceId }) {
    const questionId = uuidv4();

    // Save to conversation state
    await saveConversationState({
      userId,
      traceId,
      phase: 'clarifying',
      pendingQuestion: {
        questionId,
        question,
        context,
        options,
        priority,
        askedAt: new Date(),
      },
      expiresAt: new Date(Date.now() + 3600000),  // 1 hour
    });

    return {
      type: 'clarifying_question',
      questionId,
      question,
      context: context || {},
      options,
      expiresAt: new Date(Date.now() + 3600000),
      suggestedAnswers: options,
    };
  },
};
```

#### Tool: `createTaskWithConfidence`

**Purpose:** Create task with confidence score and context

```typescript
interface CreateTaskWithConfidenceInput {
  content: string;
  priority?: string;
  dueDate?: Date;
  estimatedDuration?: number;
  confidence: number;  // 0-1
  context: {
    source: 'user_explicit' | 'inferred_from_clarification' | 'pattern_detected';
    relatedMemories: string[];
    relatedGoals: string[];
    reasoning: string;
  };
}

interface CreateTaskWithConfidenceOutput {
  task: Task;
  confidence: number;
  autoAccepted: boolean;  // If confidence > 0.8, auto-accept
}

export const createTaskWithConfidence: ToolDefinition<...> = {
  name: 'createTaskWithConfidence',
  description: 'Create a task with confidence score and rich context',
  category: 'reactive',

  async execute({ content, confidence, context, ...taskData }, { db, userId }) {
    // Create task
    const task = await createTask({
      userId,
      content,
      ...taskData,
      metadata: {
        confidence,
        source: context.source,
        relatedMemories: context.relatedMemories,
        relatedGoals: context.relatedGoals,
        reasoning: context.reasoning,
      },
    });

    // Auto-accept if high confidence
    const autoAccepted = confidence > 0.8;

    return {
      task,
      confidence,
      autoAccepted,
    };
  },
};
```

### Proactive Tools (Long-Term Context)

#### Tool: `getUserProfile`

**Purpose:** Retrieve comprehensive user profile for proactive decisions

```typescript
interface GetUserProfileInput {
  userId: string;
  includeSections?: (
    'identity' |
    'patterns' |
    'preferences' |
    'goals' |
    'recent_activity'
  )[];
}

interface GetUserProfileOutput {
  profile: UserProfile;
  patterns: LifePattern[];
  preferences: UserPreference[];
  activeGoals: Goal[];
  recentActivity: {
    tasks: Task[];
    memories: Memory[];
    period: { start: Date; end: Date };
  };
}

export const getUserProfile: ToolDefinition<...> = {
  name: 'getUserProfile',
  description: 'Get comprehensive user profile for proactive decision-making',
  category: 'proactive',

  async execute({ userId, includeSections }, { db }) {
    const sections = includeSections || [
      'identity', 'patterns', 'preferences', 'goals', 'recent_activity'
    ];

    const result: any = {};

    if (sections.includes('identity')) {
      result.profile = await db.query.userProfiles.findFirst({
        where: eq(userProfiles.id, userId),
      });
    }

    if (sections.includes('patterns')) {
      result.patterns = await db.query.lifePatterns.findMany({
        where: and(
          eq(lifePatterns.userProfileId, userId),
          or(
            isNull(lifePatterns.validUntil),
            gt(lifePatterns.validUntil, new Date())
          )
        ),
        orderBy: desc(lifePatterns.confidence),
      });
    }

    if (sections.includes('preferences')) {
      result.preferences = await db.query.userPreferences.findMany({
        where: and(
          eq(userPreferences.userId, userId),
          gt(userPreferences.confidence, 0.6)
        ),
      });
    }

    if (sections.includes('goals')) {
      result.activeGoals = await db.query.goals.findMany({
        where: and(
          eq(goals.userProfileId, userId),
          eq(goals.status, 'active')
        ),
      });
    }

    if (sections.includes('recent_activity')) {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      result.recentActivity = {
        tasks: await db.query.tasks.findMany({
          where: and(
            eq(tasks.userId, userId),
            gt(tasks.createdAt, weekAgo)
          ),
          limit: 20,
        }),
        memories: await getRecentMemories(userId, weekAgo, 20),
        period: { start: weekAgo, end: new Date() },
      };
    }

    return result;
  },
};
```

#### Tool: `analyzePatterns`

**Purpose:** Detect patterns in user activity for proactive insights

```typescript
interface AnalyzePatternsInput {
  timeRange: { start: Date; end: Date };
  patternTypes?: ('temporal' | 'behavioral' | 'social' | 'emotional')[];
  confidence?: number;
}

interface AnalyzePatternsOutput {
  patterns: Array<{
    type: string;
    name: string;
    description: string;
    confidence: number;
    data: Record<string, any>;
    examples: Array<{ date: Date; description: string }>;
    suggestedActions: string[];
  }>;
}

export const analyzePatterns: ToolDefinition<...> = {
  name: 'analyzePatterns',
  description: 'Analyze user activity to detect patterns',
  category: 'proactive',

  async execute({ timeRange, patternTypes, confidence = 0.6 }, { db, userId, ml }) {
    const patterns = [];

    // Temporal patterns: activity by hour/day
    if (!patternTypes || patternTypes.includes('temporal')) {
      const temporalPatterns = await detectTemporalPatterns(userId, timeRange);
      patterns.push(...temporalPatterns);
    }

    // Behavioral patterns: task completion rates, working hours
    if (!patternTypes || patternTypes.includes('behavioral')) {
      const behavioralPatterns = await detectBehavioralPatterns(userId, timeRange);
      patterns.push(...behavioralPatterns);
    }

    // Social patterns: entity co-occurrence
    if (!patternTypes || patternTypes.includes('social')) {
      const socialPatterns = await detectSocialPatterns(userId, timeRange);
      patterns.push(...socialalPatterns);
    }

    // Filter by confidence
    return {
      patterns: patterns.filter(p => p.confidence >= confidence),
    };
  },
};
```

#### Tool: `createGoal`

**Purpose:** Proactively create goals based on pattern analysis

```typescript
interface CreateGoalInput {
  title: string;
  description: string;
  category: string;
  targetDate?: Date;
  relatedTasks: string[];
  relatedMemories: string[];
  confidence: number;
  reasoning: string;
}

interface CreateGoalOutput {
  goal: Goal;
  confidence: number;
  requiresUserConfirmation: boolean;
}

export const createGoal: ToolDefinition<...> = {
  name: 'createGoal',
  description: 'Create a goal based on pattern analysis or user interests',
  category: 'proactive',

  async execute(input, { db, userId }) {
    const goal = await db.insert(goals).values({
      userProfileId: userId,
      title: input.title,
      description: input.description,
      category: input.category,
      targetDate: input.targetDate,
      status: 'active',
      progress: 0,
      autoGenerated: true,
      generationConfidence: input.confidence,
      generationReasoning: input.reasoning,
      source: 'pattern_detected',
    }).returning();

    return {
      goal: goal[0],
      confidence: input.confidence,
      requiresUserConfirmation: input.confidence < 0.7,
    };
  },
};
```

#### Tool: `generateContent`

**Purpose:** Generate personalized content (meditations, articles, learning plans)

```typescript
interface GenerateContentInput {
  contentType: 'meditation' | 'article' | 'learning_plan' | 'summary';
  topic: string;
  personalization: {
    userInterests: string[];
    userGoals: string[];
    userLevel?: string;
    timeAvailable?: number;
  };
  tone?: 'formal' | 'casual' | 'inspirational';
}

interface GenerateContentOutput {
  content: {
    title: string;
    body: string;
    sections?: Array<{ title: string; content: string }>;
  };
  metadata: {
    wordCount: number;
    estimatedReadTime: number;
    relevanceScore: number;
  };
}

export const generateContent: ToolDefinition<...> = {
  name: 'generateContent',
  description: 'Generate personalized content based on user interests and goals',
  category: 'proactive',

  async execute({ contentType, topic, personalization, tone }, { ml }) {
    const prompt = `
      Generate a ${contentType} about "${topic}" for a user with:
      - Interests: ${personalization.userInterests.join(', ')}
      - Goals: ${personalization.userGoals.join(', ')}
      - Time available: ${personalization.timeAvailable || 'flexible'} minutes
      - Tone: ${tone || 'casual'}

      Content should be highly personalized and actionable.
    `;

    const generated = await ml.generateText(prompt);

    return {
      content: generated.text,
      metadata: {
        wordCount: generated.text.split(/\s+/).length,
        estimatedReadTime: generated.text.split(/\s+/).length / 200,  // 200 wpm
        relevanceScore: 0.8,
      },
    };
  },
};
```

### Tool Executor with Guards

Building on the concept from the original plan, here's the enhanced executor:

```typescript
export class ToolExecutor {
  private maxCalls: number;
  private maxDurationMs: number;
  private maxCost: number;  // Token/time budget

  constructor(
    private qdrant: QdrantService,
    private db: Database,
    private ml: MLService,
    options: {
      maxCalls?: number;
      maxDurationMs?: number;
      maxCost?: number;
    } = {}
  ) {
    this.maxCalls = options.maxCalls || 5;
    this.maxDurationMs = options.maxDurationMs || 30000;  // 30s
    this.maxCost = options.maxCost || 1000000;  // 1M tokens
  }

  async executeWithGuard<T>(
    toolChain: ToolCall[],
    context: ToolContext
  ): Promise<ToolExecutionResult<T>> {
    const startTime = Date.now();
    const results: ToolResult[] = [];
    let totalCost = 0;

    for (const call of toolChain) {
      // Guard 1: Max calls
      if (results.length >= this.maxCalls) {
        return {
          status: 'max_calls_exceeded',
          results,
          error: `Exceeded maximum tool calls (${this.maxCalls})`,
        };
      }

      // Guard 2: Timeout
      if (Date.now() - startTime > this.maxDurationMs) {
        return {
          status: 'timeout',
          results,
          error: `Tool execution timeout (${this.maxDurationMs}ms)`,
        };
      }

      // Guard 3: Cost budget
      if (totalCost > this.maxCost) {
        return {
          status: 'cost_exceeded',
          results,
          error: `Cost budget exceeded (${this.maxCost} tokens)`,
        };
      }

      // Get tool
      const tool = toolRegistry.get(call.name);
      if (!tool) {
        return {
          status: 'tool_not_found',
          results,
          error: `Tool not found: ${call.name}`,
        };
      }

      // Execute with timeout
      const toolStart = Date.now();
      try {
        const result = await Promise.race([
          tool.execute(call.args, context),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Tool timeout')), 10000)
          ),
        ]) as T;

        const toolDuration = Date.now() - toolStart;
        totalCost += tool.cost?.() || 0;

        results.push({
          name: call.name,
          result,
          duration: toolDuration,
          success: true,
        });

        // Update context with result
        context.accumulatedContext[call.name] = result;

      } catch (error) {
        results.push({
          name: call.name,
          error: String(error),
          duration: Date.now() - toolStart,
          success: false,
        });

        // Continue on error? Or stop?
        // For now, stop on critical errors
        if (error instanceof CriticalToolError) {
          return {
            status: 'critical_error',
            results,
            error: error.message,
          };
        }
      }
    }

    return {
      status: 'complete',
      results,
    };
  }
}
```

---

## Proactive Agent System

### Agent Architecture Overview

The proactive agent system consists of periodic agents that run on schedules:

| Agent | Frequency | Duration | Purpose |
|-------|-----------|----------|---------|
| Daily Review Agent | Daily | 5 min | Summarize day, highlight urgent items |
| Weekly Review Agent | Weekly | 15 min | Goal progress, pattern detection |
| Monthly Review Agent | Monthly | 30 min | Life narrative, goal achievement |
| Content Generator | Weekly | 10 min | Generate personalized content |
| Goal Tracker | Daily | 5 min | Check goal progress, suggest tasks |

### Agent Interface

```typescript
interface ProactiveAgent {
  name: string;
  description: string;
  tier: 'realtime' | 'frequent' | 'periodic' | 'deep';
  schedule: string;  // Cron expression

  execute: (context: AgentContext) => Promise<AgentResult>;
}

interface AgentContext {
  userId: string;  // Unified user profile ID
  db: Database;
  qdrant: QdrantService;
  ml: MLService;
  toolExecutor: ToolExecutor;

  log: (message: string) => void;
  checkpoint: (state: any) => Promise<void>;
  restoreCheckpoint: () => Promise<any>;
}

interface AgentResult {
  success: boolean;
  actions: AgentAction[];
  insights: string[];
  metrics?: {
    processingTimeMs: number;
    itemsProcessed: number;
    confidence: number;
  };
  nextRun?: Date;  // Suggest next run time
}

interface AgentAction {
  type: 'create_task' | 'create_goal' | 'send_message' | 'update_profile' | 'generate_content';
  payload: any;
  priority: number;
  requiresUserConfirmation: boolean;
  reasoning: string;
}
```

### Example: Daily Review Agent

```typescript
export const dailyReviewAgent: ProactiveAgent = {
  name: 'daily-review',
  description: 'Review daily activity, highlight important items',
  tier: 'periodic',
  schedule: '0 20 * * *',  // 8pm every day

  async execute(context: AgentContext): Promise<AgentResult> {
    const { userId, db, ml, toolExecutor } = context;
    const actions: AgentAction[] = [];
    const insights: string[] = [];

    const today = new Date();
    const startOfDay = new Date(today.setHours(0, 0, 0, 0));
    const endOfDay = new Date(today.setHours(23, 59, 59, 999));

    // 1. Get today's activity
    const todaysTasks = await db.query.tasks.findMany({
      where: and(
        eq(tasks.userId, userId),
        gte(tasks.createdAt, startOfDay),
        lte(tasks.createdAt, endOfDay)
      ),
    });

    const todaysMemories = await getRecentMemories(userId, startOfDay, 50);

    // 2. Analyze with LLM
    const analysis = await ml.analyzeDailyActivity({
      tasks: todaysTasks,
      memories: todaysMemories,
      userGoals: await getUserActiveGoals(userId),
    });

    // 3. Generate insights
    insights.push(...analysis.insights);

    // 4. Suggest actions
    if (analysis.urgentItems.length > 0) {
      actions.push({
        type: 'send_message',
        payload: {
          message: `📋 **Daily Review**\n\n${analysis.urgentItems.map(i => `• ${i}`).join('\n')}`,
        },
        priority: 1,
        requiresUserConfirmation: false,
        reasoning: 'Urgent items need attention',
      });
    }

    if (analysis.suggestedTasks.length > 0) {
      for (const task of analysis.suggestedTasks) {
        actions.push({
          type: 'create_task',
          payload: task,
          priority: 2,
          requiresUserConfirmation: true,
          reasoning: 'Task inferred from daily activity',
        });
      }
    }

    // 5. Update life patterns
    const patternUpdate = await updateLifePatterns(userId, todaysTasks, todaysMemories);
    if (patternUpdate.newPatterns.length > 0) {
      insights.push(`Detected ${patternUpdate.newPatterns.length} new patterns`);
    }

    return {
      success: true,
      actions,
      insights,
      metrics: {
        processingTimeMs: 0,  // Track actual time
        itemsProcessed: todaysTasks.length + todaysMemories.length,
        confidence: analysis.confidence,
      },
    };
  },
};
```

### Example: Weekly Review Agent

```typescript
export const weeklyReviewAgent: ProactiveAgent = {
  name: 'weekly-review',
  description: 'Review week activity, check goal progress, detect patterns',
  tier: 'periodic',
  schedule: '0 9 * * 1',  // 9am every Monday

  async execute(context: AgentContext): Promise<AgentResult> {
    const { userId, db, ml, toolExecutor } = context;
    const actions: AgentAction[] = [];
    const insights: string[] = [];

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // 1. Get user profile for context
    const profile = await toolExecutor.executeSingle('getUserProfile', {
      userId,
      includeSections: ['identity', 'patterns', 'preferences', 'goals'],
    });

    // 2. Analyze weekly patterns
    const patterns = await toolExecutor.executeSingle('analyzePatterns', {
      timeRange: { start: weekAgo, end: new Date() },
      patternTypes: ['temporal', 'behavioral', 'social'],
      confidence: 0.6,
    });

    insights.push(`Found ${patterns.patterns.length} weekly patterns`);

    // 3. Check goal progress
    const goals = profile.activeGoals;
    const goalUpdates = [];

    for (const goal of goals) {
      const progress = await calculateGoalProgress(goal, weekAgo);
      goalUpdates.push({ goal, progress });

      if (progress.behindSchedule) {
        actions.push({
          type: 'send_message',
          payload: {
            message: `⚠️ **Goal Alert**: "${goal.title}" is behind schedule. ${progress.reasoning}`,
          },
          priority: 1,
          requiresUserConfirmation: false,
          reasoning: 'Goal needs attention',
        });
      }
    }

    // 4. Generate weekly summary
    const summary = await ml.generateWeeklySummary({
      profile,
      patterns: patterns.patterns,
      goalProgress: goalUpdates,
    });

    actions.push({
      type: 'send_message',
      payload: {
        message: `📊 **Weekly Review**\n\n${summary.text}`,
      },
      priority: 2,
      requiresUserConfirmation: false,
      reasoning: 'Weekly summary for user',
    });

    // 5. Suggest new goals based on patterns
    const suggestedGoals = await inferGoalsFromPatterns(patterns.patterns, profile);
    for (const goal of suggestedGoals) {
      if (goal.confidence > 0.7) {
        actions.push({
          type: 'create_goal',
          payload: goal,
          priority: 3,
          requiresUserConfirmation: true,
          reasoning: 'Goal inferred from weekly patterns',
        });
      }
    }

    return {
      success: true,
      actions,
      insights,
      metrics: {
        processingTimeMs: 0,
        itemsProcessed: patterns.patterns.length + goals.length,
        confidence: 0.8,
      },
    };
  },
};
```

### Example: Content Generation Agent

```typescript
export const contentGenerationAgent: ProactiveAgent = {
  name: 'content-generator',
  description: 'Generate personalized content based on user interests',
  tier: 'periodic',
  schedule: '0 10 * * 0',  // 10am every Sunday

  async execute(context: AgentContext): Promise<AgentResult> {
    const { userId, db, ml, toolExecutor } = context;
    const actions: AgentAction[] = [];

    // 1. Get user interests and goals
    const profile = await toolExecutor.executeSingle('getUserProfile', {
      userId,
      includeSections: ['identity', 'preferences', 'goals'],
    });

    // 2. Identify content opportunities
    const opportunities = await identifyContentOpportunities(profile);

    // 3. Generate content
    for (const opp of opportunities) {
      const content = await toolExecutor.executeSingle('generateContent', {
        contentType: opp.type,
        topic: opp.topic,
        personalization: {
          userInterests: profile.interests,
          userGoals: profile.activeGoals.map(g => g.title),
          userLevel: opp.level,
          timeAvailable: opp.duration,
        },
        tone: profile.communicationStyle,
      });

      actions.push({
        type: 'send_message',
        payload: {
          message: `📚 **${content.content.title}**\n\n${content.content.body}`,
        },
        priority: 3,
        requiresUserConfirmation: false,
        reasoning: `Content generated based on interest in ${opp.topic}`,
      });
    }

    return {
      success: true,
      actions,
      insights: [`Generated ${actions.length} pieces of content`],
    };
  },
};
```

---

## Implementation Roadmap

### Phase 1: Foundation (Week 1-2)

**Goals:** Establish core infrastructure for agentic system

**Tasks:**
1. Create `platform/src/tools/tool-registry.ts`
   - Define `ToolDefinition` interface
   - Implement `ToolRegistry` class
   - Add tool registration and discovery

2. Create `platform/src/tools/tool-executor.ts`
   - Implement `ToolExecutor` class with guards
   - Add max calls, timeout, cost guards
   - Implement tool chain execution

3. Implement reactive tools:
   - `platform/src/tools/tools/search-similar-memories.tool.ts`
   - `platform/src/tools/tools/search-existing-tasks.tool.ts`
   - `platform/src/tools/tools/ask-clarifying-question.tool.ts`
   - `platform/src/tools/tools/create-task-with-confidence.tool.ts`

4. Create database migration:
   - `platform/src/db/migrations/009_user_profiles.sql`
   - `platform/src/db/migrations/010_conversation_states.sql`

**Success Criteria:**
- Tool registry can register and retrieve tools
- Tool executor enforces guard conditions
- Reactive tools can search memories and tasks
- Migration creates new tables successfully

### Phase 2: Long-Term Context Storage (Week 2-3)

**Goals:** Enable unified user identity and long-term context tracking

**Tasks:**
1. Implement user profile service:
   - `platform/src/services/user-profile.ts`
   - `getUserProfile()`, `createUserProfile()`, `mergeUserIdentities()`

2. Implement conversation state service:
   - `platform/src/services/conversation-state.ts`
   - `saveConversationState()`, `getConversationState()`, `clearConversationState()`

3. Create database migration:
   - `platform/src/db/migrations/011_goals.sql`
   - `platform/src/db/migrations/012_life_patterns.sql`
   - `platform/src/db/migrations/013_life_narratives.sql`

4. Implement goal service:
   - `platform/src/services/goals.ts`
   - CRUD operations for goals
   - Progress tracking

5. Implement life pattern service:
   - `platform/src/services/life-patterns.ts`
   - Pattern detection and storage

**Success Criteria:**
- Can create and retrieve user profiles
- Can merge platform identities into unified profile
- Conversation state persists across message turns
- Goals can be created and tracked
- Life patterns are detected and stored

### Phase 3: Agentic ML Integration (Week 3-4)

**Goals:** Enable LLM to use tools for multi-turn reasoning

**Tasks:**
1. Create ML service endpoint:
   - `ml-services/app/extract_task_agentic.py`
   - Tool-calling enabled endpoint
   - Guard conditions in ML service

2. Update ML client:
   - `platform/src/services/ml.ts`
   - Add `extractTaskAgentic()` function
   - Handle tool call responses

3. Implement agentic workflow:
   - `platform/src/workflows/agentic-task.ts`
   - Replace simple extraction with agentic extraction
   - Handle clarifying questions
   - Manage conversation state

4. Update message processor:
   - `platform/src/workers/message-processor.ts`
   - Integrate agentic workflow
   - Handle conversation state
   - Multi-turn message routing

**Success Criteria:**
- ML service can request tool calls
- Platform can execute tools and return results
- Vague messages trigger tool calls instead of rejection
- Clarifying questions are asked and answered
- Tasks are created with context from tools

### Phase 4: Proactive Agents (Week 4-5)

**Goals:** Implement periodic proactive agents

**Tasks:**
1. Create proactive agent framework:
   - `platform/src/gardener/proactive-agent.ts`
   - `ProactiveAgent` interface
   - Agent registration system

2. Implement proactive tools:
   - `platform/src/tools/tools/get-user-profile.tool.ts`
   - `platform/src/tools/tools/analyze-patterns.tool.ts`
   - `platform/src/tools/tools/create-goal.tool.ts`
   - `platform/src/tools/tools/generate-content.tool.ts`
   - `platform/src/tools/tools/update-life-narrative.tool.ts`

3. Implement periodic agents:
   - `platform/src/gardener/agents/daily-review.agent.ts`
   - `platform/src/gardener/agents/weekly-review.agent.ts`
   - `platform/src/gardener/agents/monthly-review.agent.ts`
   - `platform/src/gardener/agents/content-generator.agent.ts`

4. Register agents with gardener:
   - Update `platform/src/gardener/controller.ts`
   - Add agent scheduling
   - Configure cron schedules

**Success Criteria:**
- Daily review agent runs and summarizes activity
- Weekly review agent checks goal progress
- Content generator creates personalized content
- Agents use tools to gather context
- Actions are queued for user confirmation

### Phase 5: Integration & Testing (Week 5-6)

**Goals:** End-to-end testing and polish

**Tasks:**
1. Integration tests:
   - `platform/src/test/integration/agentic-task-workflow.test.ts`
   - `platform/src/test/integration/proactive-agents.test.ts`
   - `platform/src/test/integration/conversation-state.test.ts`

2. E2E scenarios:
   - Vague message → search → clarify → create
   - Duplicate detection via search
   - Goal inference from patterns
   - Content generation based on interests

3. Performance optimization:
   - Tool execution caching
   - Parallel independent tool calls
   - Embedding caching

4. Documentation:
   - Architecture documentation
   - API documentation
   - User guide

**Success Criteria:**
- All integration tests pass
- E2E scenarios work correctly
- Performance targets met (<5s single-turn, <15s multi-turn)
- Documentation is complete

### Phase 6: Deployment & Monitoring (Week 6-7)

**Goals:** Deploy and monitor production system

**Tasks:**
1. Deployment:
   - Database migrations run
   - ML service deployed
   - Platform service deployed

2. Monitoring:
   - Tool execution metrics
   - Agent performance metrics
   - User satisfaction tracking

3. Iteration:
   - Collect user feedback
   - Analyze tool usage patterns
   - Optimize LLM prompts
   - Refine guard conditions

**Success Criteria:**
- System deployed to production
- Monitoring dashboards operational
- User feedback is positive
- System is stable and performant

---

## Success Criteria

### Functional Requirements

- [ ] Vague messages trigger database search instead of rejection
- [ ] Clarifying questions are asked when intent is unclear
- [ ] Conversation state persists across multi-turn flows
- [ ] Guard conditions prevent infinite loops (max 5 tool calls, 30s timeout)
- [ ] Cross-platform user identity is unified
- [ ] Long-term goals can be tracked and updated
- [ ] Proactive agents run periodically and generate insights
- [ ] Personalized content is generated based on user interests

### Non-Functional Requirements

- [ ] Performance: <5s for single-turn, <15s for multi-turn
- [ ] Reliability: >99% uptime for core services
- [ ] Scalability: Support 10,000+ concurrent users
- [ ] Privacy: User data is isolated and secure
- [ ] Test coverage: >80% for new code

### User Experience Requirements

- [ ] System feels helpful, not intrusive
- [ ] Proactive suggestions are relevant and actionable
- [ ] Multi-turn conversations feel natural
- [ ] User has control over proactive features
- [ ] System learns and improves over time

---

## Key Files Summary

### Files to Create

**Tools:**
1. `platform/src/tools/tool-registry.ts`
2. `platform/src/tools/tool-executor.ts`
3. `platform/src/tools/tools/search-similar-memories.tool.ts`
4. `platform/src/tools/tools/search-existing-tasks.tool.ts`
5. `platform/src/tools/tools/ask-clarifying-question.tool.ts`
6. `platform/src/tools/tools/create-task-with-confidence.tool.ts`
7. `platform/src/tools/tools/get-user-profile.tool.ts`
8. `platform/src/tools/tools/analyze-patterns.tool.ts`
9. `platform/src/tools/tools/create-goal.tool.ts`
10. `platform/src/tools/tools/generate-content.tool.ts`
11. `platform/src/tools/tools/update-life-narrative.tool.ts`

**Services:**
12. `platform/src/services/user-profile.ts`
13. `platform/src/services/conversation-state.ts`
14. `platform/src/services/goals.ts`
15. `platform/src/services/life-patterns.ts`
16. `platform/src/services/life-narratives.ts`

**Workflows:**
17. `platform/src/workflows/agentic-task.ts`

**Agents:**
18. `platform/src/gardener/agents/daily-review.agent.ts`
19. `platform/src/gardener/agents/weekly-review.agent.ts`
20. `platform/src/gardener/agents/monthly-review.agent.ts`
21. `platform/src/gardener/agents/content-generator.agent.ts`

**ML:**
22. `ml-services/app/extract_task_agentic.py`

**Tests:**
23. `platform/src/test/integration/agentic-task-workflow.test.ts`
24. `platform/src/test/integration/proactive-agents.test.ts`
25. `platform/src/test/integration/conversation-state.test.ts`

### Files to Modify

**Database:**
1. `platform/src/db/schema.ts` - Add new tables
2. `platform/src/db/migrations/009_user_profiles.sql` - New migration
3. `platform/src/db/migrations/010_conversation_states.sql` - New migration
4. `platform/src/db/migrations/011_goals.sql` - New migration
5. `platform/src/db/migrations/012_life_patterns.sql` - New migration
6. `platform/src/db/migrations/013_life_narratives.sql` - New migration

**Services:**
7. `platform/src/services/ml.ts` - Add `extractTaskAgentic()`
8. `platform/src/services/api-client/` - Regenerate after ML changes

**Workers:**
9. `platform/src/workers/message-processor.ts` - Integrate agentic flow (line 148+)

**Gardener:**
10. `platform/src/gardener/controller.ts` - Add proactive agent support

---

## Conclusion

This plan transforms the system from a reactive message router into a proactive Personal Life OS Agent. By combining agentic tool-calling infrastructure with long-term user context and periodic proactive agents, we create a system that:

1. **Never rejects** - Always seeks context or asks clarifying questions
2. **Learns continuously** - Builds rich model of user over time
3. **Acts proactively** - Generates insights, tasks, goals, and content
4. **Maintains context** - Unified cross-platform user identity
5. **Respects boundaries** - User controls proactive features

The architecture builds on the existing strengths of the KARMA pipeline and tier-based job queue, extending them with a sophisticated agent framework that can reason multi-turn, maintain long-term context, and take proactive action.

**Next Steps:**
1. Review and approve this plan
2. Begin Phase 1 implementation
3. Iterate based on feedback
4. Deploy incrementally, measuring success at each phase

---

**Document Version:** 1.0
**Last Updated:** 2025-01-29
**Author:** Claude (Sonnet 4.5)
**Status:** Draft for Review
