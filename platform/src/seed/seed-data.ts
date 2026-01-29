#!/usr/bin/env -S node --loader ts-node/esm
/**
 * Comprehensive Seed Script for Knowledge Memory System
 *
 * Generates realistic personal knowledge data simulating a person with varied interests:
 * - Professional life (work, colleagues, projects, technical concepts)
 * - Personal interests (hobbies, books, music, fitness)
 * - Learning journey (courses, skills, research)
 * - Journal reflections (personal growth, goals)
 * - Tasks and reminders (todos, deadlines)
 *
 * Uses LLM to generate diverse, contextual content rather than static templates.
 */

import { db } from '../db/index.js'
import { entities, entityAliases, facts, tasks, epics, contextSummaries } from '../db/schema.js'
import { randomUUID } from 'crypto'
import { embed } from '../services/ml.js'
import { storeMemory, searchMemories } from '../services/qdrant.js'
import { createEntity, resolveEntity } from '../services/entities.js'
import { createFact } from '../services/facts.js'
import { sql } from 'drizzle-orm'

// ============================================================================
// CONFIGURATION
// ============================================================================

const SEED_CONFIG = {
  // Volume settings
  entityCount: {
    people: 15,        // Colleagues, friends, family
    companies: 6,      // Current/past employers, tech companies
    projects: 8,       // Work projects, side projects
    concepts: 20,      // Technical concepts, frameworks, tools
    places: 5,         // Offices, cities, venues
  },

  memoryCount: {
    thoughts: 150,     // Casual observations, reflections
    links: 40,         // Articles, resources, documentation
    tasks: 60,         // Action items, todos
    questions: 30,     // Research topics, things to learn
    voiceNotes: 20,    // Transcribed conversations
  },

  taskCount: 50,       // Structured tasks in PostgreSQL
  epicCount: 6,        // Project containers
  factCount: 200,      // Knowledge graph relationships

  // Date range for realistic temporal distribution
  dateRange: {
    start: new Date('2024-01-01'),
    end: new Date(),
  },
}

// ============================================================================
// PERSONA DEFINITION
// ============================================================================

const PERSONA = {
  name: 'Alex Chen',
  role: 'Senior Software Engineer',
  location: 'San Francisco, CA',

  interests: [
    'distributed systems',
    'machine learning',
    'coffee brewing',
    'rock climbing',
    'photography',
    'science fiction',
    'cooking',
    'productivity systems',
    'sustainable living',
    'language learning (Japanese)',
  ],

  workDomain: {
    currentCompany: 'TechFlow Inc',
    previousCompany: 'DataSystems',
    role: 'Senior Software Engineer',
    team: 'Platform Infrastructure',
    techStack: ['TypeScript', 'Go', 'Kubernetes', 'PostgreSQL', 'React'],
  },

  personalLife: {
    hobbies: ['rock climbing', 'photography', 'coffee', 'cooking'],
    reading: ['science fiction', 'technical blogs', 'productivity books'],
    fitness: ['climbing gym', 'running', 'yoga'],
    learning: ['Japanese', 'machine learning', 'photography techniques'],
  },
}

// ============================================================================
// LLM CONTENT GENERATION
// ============================================================================

/**
 * Generate diverse content using OpenAI-compatible API
 * This creates realistic, varied content instead of static templates
 */
async function generateWithLLM(prompt: string, systemPrompt?: string): Promise<string> {
  try {
    const response = await fetch(`${process.env.ML_SERVICE_URL || 'http://localhost:8000'}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        system: systemPrompt || 'You are a helpful assistant generating realistic personal knowledge data.',
        max_tokens: 500,
        temperature: 0.8,
      }),
    })

    if (!response.ok) {
      throw new Error(`ML service error: ${response.statusText}`)
    }

    const data = await response.json()
    return data.text || data.content || data.response || ''
  } catch (error) {
    console.warn('LLM generation failed, using fallback:', error)
    return fallbackGeneration(prompt)
  }
}

/**
 * Fallback content generation when LLM is unavailable
 */
function fallbackGeneration(prompt: string): string {
  const fallbacks: Record<string, string[]> = {
    thought: [
      "Really interesting discussion today about distributed systems consistency models.",
      "Need to look deeper into event sourcing patterns for the new project.",
      "Great coffee at the new roastery downtown - their Ethiopian pour over is fantastic.",
      "Productivity tip: time blocking actually works when you stick to it.",
      "Climbing session went well today - sent my first V5 route!",
      "Reading a fascinating paper on transformer architectures.",
      "Need to refactor the authentication service - it's getting messy.",
      "Team standup revealed some blockers in the API migration.",
      "Photography walk this weekend captured some great golden hour shots.",
      "Japanese lesson today: learned kanji for 'sky' and 'river'.",
    ],
    task: [
      "Review PR for authentication service refactor",
      "Set up monitoring dashboard for production metrics",
      "Schedule 1:1 with Sarah",
      "Research Kubernetes auto-scaling strategies",
      "Buy coffee beans for the week",
      "Plan climbing trip for next month",
      "Update documentation for API endpoints",
      "Book dentist appointment",
      "Organize photo library from last trip",
      "Practice Japanese vocabulary",
    ],
    question: [
      "What's the difference between Raft and Paxos consensus algorithms?",
      "How do I properly calibrate my espresso machine?",
      "Best practices for PostgreSQL partitioning?",
      "How to improve footwork for climbing overhangs?",
      "What are the latest advances in computer vision?",
    ],
    link: [
      "Great article on microservices patterns: https://martinfowler.com/articles/microservices.html",
      "Kubernetes best practices guide: https://kubernetes.io/docs/concepts/configuration/overview/",
      "Interesting paper on attention mechanisms: https://arxiv.org/abs/1706.03762",
      "Coffee brewing techniques: https://bluebottlecoffee.com/recipes/brew-guides",
      "Climbing training exercises: https://trainingbeta.com/climbing-training-101/",
    ],
    reflection: [
      "Looking back at this month, I've made good progress on the platform migration but need to focus more on documentation.",
      "Really proud of leading the team through the incident response drill.",
      "Balancing work and personal life has been challenging lately - need to set better boundaries.",
      "Learning Japanese has been rewarding but slower than expected. Consistency is key.",
      "The photography hobby has taught me to be more present and observant.",
    ],
  }

  // Detect type from prompt
  let type = 'thought'
  if (prompt.includes('task')) type = 'task'
  else if (prompt.includes('question')) type = 'question'
  else if (prompt.includes('link') || prompt.includes('article')) type = 'link'
  else if (prompt.includes('reflection') || prompt.includes('journal')) type = 'reflection'

  const options = fallbacks[type] || fallbacks.thought
  return options[Math.floor(Math.random() * options.length)]
}

// ============================================================================
// ENTITY GENERATION
// ============================================================================

interface EntityData {
  canonicalName: string
  entityType: string
  description?: string
  properties?: Record<string, any>
  aliases?: string[]
}

/**
 * Generate entities using LLM for variety
 */
async function generateEntities(): Promise<Map<string, any>> {
  console.log('📦 Generating entities...')

  const entityMap = new Map<string, any>()

  // 1. Generate People (colleagues, friends, family)
  const peoplePrompts = [
    'Generate a realistic colleague profile: name, role, personality, work context.',
    'Generate a close friend profile: name, how you met, shared interests.',
    'Generate a family member profile: name, relationship, interactions.',
  ]

  for (let i = 0; i < SEED_CONFIG.entityCount.people; i++) {
    const prompt = peoplePrompts[i % peoplePrompts.length]
    const description = await generateWithLLM(prompt)
    const name = extractName(description) || `Person ${i}`

    const entity = await createEntity({
      name,
      type: 'person',
      description,
      properties: { source: 'seed' },
    })

    entityMap.set(name, entity)
    console.log(`  ✓ Person: ${name}`)
  }

  // 2. Generate Companies
  const companyNames = [
    PERSONA.workDomain.currentCompany,
    PERSONA.workDomain.previousCompany,
    'Google', 'Amazon', 'Microsoft', 'Stripe', 'Vercel', 'Supabase',
  ]

  for (let i = 0; i < SEED_CONFIG.entityCount.companies; i++) {
    const name = companyNames[i] || `TechCorp ${i}`

    const entity = await createEntity({
      name,
      type: 'company',
      description: await generateWithLLM(`Brief description of ${name} as a technology company.`),
      properties: { source: 'seed' },
    })

    entityMap.set(name, entity)
    console.log(`  ✓ Company: ${name}`)
  }

  // 3. Generate Projects
  for (let i = 0; i < SEED_CONFIG.entityCount.projects; i++) {
    const prompt = `Generate a realistic software project name and brief description. ${i < 3 ? 'Work-related.' : 'Personal side project.'}`
    const description = await generateWithLLM(prompt)
    const name = extractProjectName(description) || `Project ${i}`

    const entity = await createEntity({
      name,
      type: 'project',
      description,
      properties: { source: 'seed', isPersonal: i >= 3 },
    })

    entityMap.set(name, entity)
    console.log(`  ✓ Project: ${name}`)
  }

  // 4. Generate Concepts (technical topics, hobbies, interests)
  const concepts = [
    ...PERSONA.workDomain.techStack,
    ...PERSONA.interests,
    'Distributed Systems', 'Machine Learning', 'Container Orchestration',
    'Event Sourcing', 'CQRS', 'GraphQL', 'WebAssembly', 'Rust',
    'Coffee Brewing', 'Portrait Photography', 'Bouldering',
  ]

  for (let i = 0; i < SEED_CONFIG.entityCount.concepts; i++) {
    const concept = concepts[i] || `Concept ${i}`

    const entity = await createEntity({
      name: concept,
      type: 'concept',
      description: await generateWithLLM(`One-sentence description of ${concept} for a software engineer.`),
      properties: { source: 'seed' },
    })

    entityMap.set(concept, entity)
    console.log(`  ✓ Concept: ${concept}`)
  }

  // 5. Generate Places
  const places = [
    'TechFlow Inc Office',
    'Mission Climb Gym',
    'Blue Bottle Coffee',
    'Golden Gate Park',
    'Japan Town',
  ]

  for (const place of places.slice(0, SEED_CONFIG.entityCount.places)) {
    const entity = await createEntity({
      name: place,
      type: 'place',
      description: await generateWithLLM(`Brief description of ${place} in San Francisco.`),
      properties: { source: 'seed' },
    })

    entityMap.set(place, entity)
    console.log(`  ✓ Place: ${place}`)
  }

  console.log(`✅ Generated ${entityMap.size} entities\n`)
  return entityMap
}

// ============================================================================
// MEMORY GENERATION
// ============================================================================

/**
 * Generate memories of various types with realistic content
 */
async function generateMemories(entityMap: Map<string, any>) {
  console.log('💭 Generating memories...')

  const entityNames = Array.from(entityMap.keys())
  const memoryTypes: Array<'thought' | 'link' | 'task' | 'question'> = ['thought', 'link', 'task', 'question']
  const totalMemories = Object.values(SEED_CONFIG.memoryCount).reduce((a, b) => a + b, 0)

  let generated = 0

  for (const [type, count] of Object.entries(SEED_CONFIG.memoryCount)) {
    for (let i = 0; i < count; i++) {
      // Generate contextual content
      const contextEntity = entityNames[Math.floor(Math.random() * entityNames.length)]
      const prompt = generateMemoryPrompt(type as any, contextEntity, entityMap)
      const content = await generateWithLLM(prompt)

      // Generate embedding
      const { vector } = await embed(content)
      const memoryId = randomUUID()

      // Create realistic timestamp
      const timestamp = randomDate(SEED_CONFIG.dateRange.start, SEED_CONFIG.dateRange.end)

      // Store in Qdrant
      await storeMemory({
        id: memoryId,
        vector,
        payload: {
          trace_id: memoryId,
          type: type === 'voiceNotes' ? 'voice' : type,
          content,
          summary: content.slice(0, 100) + (content.length > 100 ? '...' : ''),
          origin: {
            platform: 'telegram',
            sender: { id: 'seed-user', name: PERSONA.name },
            context: { conversation_id: `seed-context-${Math.floor(Math.random() * 10)}` },
          },
          created_at: timestamp.toISOString(),
          status: 'active',
          tags: generateRelevantTags(content),
        },
      })

      generated++
      if (generated % 20 === 0) {
        console.log(`  ${generated}/${totalMemories} memories generated...`)
      }
    }
  }

  console.log(`✅ Generated ${generated} memories\n`)
}

/**
 * Generate contextual prompt for memory creation
 */
function generateMemoryPrompt(
  type: 'thought' | 'link' | 'task' | 'question' | 'voiceNotes',
  contextEntity: string,
  entityMap: Map<string, any>
): string {
  const entity = entityMap.get(contextEntity)

  const prompts: Record<typeof type, string> = {
    thought: `Generate a realistic thought, observation, or reflection related to "${contextEntity}". ${entity?.entityType === 'person' ? 'Make it about an interaction or experience with them.' : ''}`,

    link: `Generate a realistic link/share with a brief comment. The link should be about "${contextEntity}". Include a placeholder URL like https://example.com/article.`,

    task: `Generate a realistic task or todo item related to "${contextEntity}". Make it specific and actionable.`,

    question: `Generate a realistic question someone might ask about "${contextEntity}". Make it thoughtful and specific.`,

    voiceNotes: `Generate a transcribed voice note reflection. The person is recording a quick thought about "${contextEntity}" while walking or commuting.`,
  }

  return prompts[type] || prompts.thought
}

/**
 * Generate relevant tags based on content keywords
 */
function generateRelevantTags(content: string): string[] {
  const keywords = [
    'work', 'project', 'meeting', 'code', 'deployment',
    'climbing', 'coffee', 'photography', 'cooking', 'japanese',
    'learning', 'reading', 'health', 'finance', 'goals',
  ]

  const tags = keywords.filter(kw =>
    content.toLowerCase().includes(kw.toLowerCase())
  )

  return tags.length > 0 ? tags.slice(0, 3) : ['general']
}

// ============================================================================
// FACT GENERATION
// ============================================================================

/**
 * Generate facts linking entities together
 */
async function generateFacts(entityMap: Map<string, any>) {
  console.log('🔗 Generating facts...')

  const predicates = [
    'works_at', 'knows', 'manages', 'collaborates_with',
    'uses', 'learns', 'interested_in', 'lives_in',
    'visits', 'reads', 'practices', 'works_on',
  ]

  const entities = Array.from(entityMap.values())
  let generated = 0

  for (let i = 0; i < SEED_CONFIG.factCount; i++) {
    // Select random entities
    const subject = entities[Math.floor(Math.random() * entities.length)]
    const predicate = predicates[Math.floor(Math.random() * predicates.length)]
    const object = entities[Math.floor(Math.random() * entities.length)]

    // Skip self-relationships
    if (subject.id === object.id) continue

    // Generate contextual source text
    const sourceText = await generateWithLLM(
      `Generate a natural sentence expressing that "${subject.canonicalName}" ${predicate.replace('_', ' ')} "${object.canonicalName}".`
    )

    // Generate embedding for source
    const { vector } = await embed(sourceText)
    const memoryId = randomUUID()

    // Store source memory
    await storeMemory({
      id: memoryId,
      vector,
      payload: {
        trace_id: memoryId,
        type: 'thought',
        content: sourceText,
        summary: sourceText.slice(0, 100),
        origin: {
          platform: 'telegram',
          sender: { id: 'seed-user', name: PERSONA.name },
          context: { conversation_id: 'seed-context' },
        },
        created_at: randomDate(SEED_CONFIG.dateRange.start, SEED_CONFIG.dateRange.end).toISOString(),
        status: 'active',
      },
    })

    // Create fact
    await createFact({
      subjectEntityId: subject.id,
      predicate,
      objectEntityId: object.id,
      objectValue: null,
      validAt: randomDate(SEED_CONFIG.dateRange.start, SEED_CONFIG.dateRange.end),
      invalidAt: null,
      sourceMemoryId: memoryId,
      sourceText,
      extractionMethod: 'seed',
      confidence: 0.7 + Math.random() * 0.3,
    })

    generated++
    if (generated % 50 === 0) {
      console.log(`  ${generated}/${SEED_CONFIG.factCount} facts generated...`)
    }
  }

  console.log(`✅ Generated ${generated} facts\n`)
}

// ============================================================================
// TASK & EPIC GENERATION
// ============================================================================

/**
 * Generate tasks and organize them into epics
 */
async function generateTasksAndEpics(entityMap: Map<string, any>) {
  console.log('✓ Generating tasks and epics...')

  // Create epics
  const epicNames = [
    'Platform Migration',
    'Learning Goals',
    'Home Projects',
    'Health & Fitness',
    'Financial Planning',
    'Side Project',
  ]

  const epicIds: string[] = []

  for (const name of epicNames.slice(0, SEED_CONFIG.epicCount)) {
    const [epic] = await db.insert(epics)
      .values({
        id: randomUUID(),
        name,
        description: await generateWithLLM(`Brief description of a ${name} epic for a personal knowledge system.`),
        status: 'active',
        lastActivityAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning()

    epicIds.push(epic.id)
    console.log(`  ✓ Epic: ${name}`)
  }

  // Generate tasks for each epic
  const entityNames = Array.from(entityMap.keys())

  for (let i = 0; i < SEED_CONFIG.taskCount; i++) {
    const epicId = epicIds[i % epicIds.length]
    const contextEntity = entityNames[Math.floor(Math.random() * entityNames.length)]

    const content = await generateWithLLM(
      `Generate a specific, actionable task for epic "${epicNames[epicIds.indexOf(epicId)]}" related to "${contextEntity}".`
    )

    const priority = ['low', 'medium', 'high', 'urgent'][Math.floor(Math.random() * 4)]
    const memoryId = randomUUID()

    // Create associated memory
    const { vector } = await embed(content)
    await storeMemory({
      id: memoryId,
      vector,
      payload: {
        trace_id: memoryId,
        type: 'task',
        content,
        summary: content.slice(0, 100),
        origin: {
          platform: 'telegram',
          sender: { id: 'seed-user', name: PERSONA.name },
          context: { conversation_id: 'seed-context' },
        },
        created_at: randomDate(SEED_CONFIG.dateRange.start, SEED_CONFIG.dateRange.end).toISOString(),
        status: 'active',
      },
    })

    // Create task
    await db.insert(tasks).values({
      id: randomUUID(),
      traceId: memoryId,
      content,
      dueDate: Math.random() > 0.5 ? randomDate(new Date(), new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)) : null,
      priority,
      status: Math.random() > 0.7 ? 'completed' : 'pending',
      epicId,
      contextId: null,
      memoryId,
      createdAt: randomDate(SEED_CONFIG.dateRange.start, SEED_CONFIG.dateRange.end),
      completedAt: Math.random() > 0.7 ? new Date() : null,
    })
  }

  console.log(`✅ Generated ${SEED_CONFIG.taskCount} tasks across ${epicIds.length} epics\n`)
}

// ============================================================================
// CONTEXT SUMMARIES
// ============================================================================

/**
 * Generate conversation context summaries
 */
async function generateContextSummaries() {
  console.log('💬 Generating context summaries...')

  const contexts = [
    { id: 'telegram-work-chat', name: 'Work Team Chat', participants: ['Alex', 'Sarah', 'Mike'] },
    { id: 'telegram-climbing-buddies', name: 'Climbing Buddies', participants: ['Alex', 'Jamie', 'Chris'] },
    { id: 'telegram-family', name: 'Family Group', participants: ['Alex', 'Mom', 'Dad', 'Sister'] },
    { id: 'telegram-learning-group', name: 'Study Group', participants: ['Alex', 'Tom', 'Lisa'] },
  ]

  for (const ctx of contexts) {
    const summary = await generateWithLLM(
      `Generate a realistic 2-3 sentence summary of recent conversations in a "${ctx.name}" group chat about ${ctx.participants.join(', ')}.`
    )

    const { vector } = await embed(summary)

    await db.insert(contextSummaries).values({
      id: randomUUID(),
      conversationId: ctx.id,
      platform: 'telegram',
      name: ctx.name,
      summary,
      messageCount: Math.floor(20 + Math.random() * 100),
      participantsJson: ctx.participants,
      lastAnalyzedAt: new Date(),
      lastMessageAt: randomDate(SEED_CONFIG.dateRange.start, SEED_CONFIG.dateRange.end),
    })

    await storeMemory({
      id: randomUUID(),
      vector,
      payload: {
        trace_id: randomUUID(),
        type: 'conversation',
        name: ctx.name,
        conversation_id: ctx.id,
        participants: ctx.participants,
        summary,
        message_count: Math.floor(20 + Math.random() * 100),
        last_message_at: randomDate(SEED_CONFIG.dateRange.start, SEED_CONFIG.dateRange.end).toISOString(),
      },
    })

    console.log(`  ✓ Context: ${ctx.name}`)
  }

  console.log(`✅ Generated ${contexts.length} context summaries\n`)
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Extract name from generated text
 */
function extractName(text: string): string | null {
  const match = text.match(/(?:name is|called|:)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/)
  return match ? match[1] : null
}

/**
 * Extract project name from generated text
 */
function extractProjectName(text: string): string | null {
  const match = text.match(/(?:project|called|named)\s+["']?([A-Z][A-Za-z0-9\s]+)["']?/i)
  return match ? match[1].trim() : null
}

/**
 * Generate random date within range
 */
function randomDate(start: Date, end: Date): Date {
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()))
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  console.log('🌱 Starting Knowledge Memory System Seed Data Generation\n')
  console.log('Configuration:', SEED_CONFIG)
  console.log('Persona:', PERSONA.name, `- ${PERSONA.role}\n`)

  try {
    // Check if ML service is available
    const mlServiceUrl = process.env.ML_SERVICE_URL || 'http://localhost:8000'
    console.log(`🔍 Checking ML service at ${mlServiceUrl}...`)

    try {
      await fetch(`${mlServiceUrl}/health`)
      console.log('✅ ML service is available\n')
    } catch (error) {
      console.warn('⚠️  ML service unavailable, using fallback content generation\n')
    }

    // 1. Generate Entities
    const entityMap = await generateEntities()

    // 2. Generate Memories
    await generateMemories(entityMap)

    // 3. Generate Facts
    await generateFacts(entityMap)

    // 4. Generate Tasks and Epics
    await generateTasksAndEpics(entityMap)

    // 5. Generate Context Summaries
    await generateContextSummaries()

    console.log('🎉 Seed data generation complete!\n')

    // Print summary statistics
    console.log('📊 Summary Statistics:')
    console.log('─────────────────────────────────────────────────')

    const [entityCount, memoryCount, factCount, taskCount, epicCount, contextCount] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(entities),
      db.select({ count: sql<number>`count(*)::int` }).from(sql('(SELECT 1 FROM qdrant.client) AS q')),
      db.select({ count: sql<number>`count(*)::int` }).from(facts),
      db.select({ count: sql<number>`count(*)::int` }).from(tasks),
      db.select({ count: sql<number>`count(*)::int` }).from(epics),
      db.select({ count: sql<number>`count(*)::int` }).from(contextSummaries),
    ])

    console.log(`Entities:        ${entityCount[0].count}`)
    console.log(`Facts:           ${factCount[0].count}`)
    console.log(`Tasks:           ${taskCount[0].count}`)
    console.log(`Epics:           ${epicCount[0].count}`)
    console.log(`Contexts:        ${contextCount[0].count}`)
    console.log('─────────────────────────────────────────────────\n')

    console.log('💡 Tip: Use the Telegram bot to interact with your seeded data!')
    console.log('   - /search <query> to search memories')
    console.log('   - /tasks to view tasks')
    console.log('   - /stats to see system statistics\n')

  } catch (error) {
    console.error('❌ Error during seed generation:', error)
    process.exit(1)
  }
}

// Run seed
main()
