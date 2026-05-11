# Seed Data Generator

Populates the Knowledge Memory System with realistic, diverse data simulating a person with varied interests.

## What It Generates

The seed script creates a comprehensive personal knowledge base including:

### 📦 Entities (70+)
- **People**: 15 colleagues, friends, family members
- **Companies**: 6 tech companies (current/past employers)
- **Projects**: 8 work and personal projects
- **Concepts**: 20 technical topics, hobbies, interests
- **Places**: 5 locations (offices, gyms, cafes, etc.)

### 💭 Memories (300+)
- **150 Thoughts**: Observations, reflections, casual notes
- **40 Links**: Articles, resources, documentation
- **60 Tasks**: Action items, todos, reminders
- **30 Questions**: Research topics, things to learn
- **20 Voice Notes**: Transcribed conversations

### 🔗 Facts (200+)
Knowledge graph relationships linking entities:
- `works_at`, `knows`, `manages`, `collaborates_with`
- `uses`, `learns`, `interested_in`, `lives_in`
- `visits`, `reads`, `practices`, `works_on`

### ✓ Tasks & Epics
- **6 Epics**: Platform Migration, Learning Goals, Home Projects, Health & Fitness, Financial Planning, Side Project
- **50 Tasks**: Distributed across epics with varied priorities and statuses

### 💬 Contexts
- **4 Conversation Summaries**: Work chat, climbing buddies, family group, study group

## Persona

The seeded data simulates **Alex Chen**, a Senior Software Engineer in San Francisco with diverse interests:

- **Professional**: Distributed systems, TypeScript/Go, Kubernetes, ML
- **Hobbies**: Rock climbing, photography, coffee brewing, cooking
- **Learning**: Japanese language, machine learning advances
- **Personal**: Productivity systems, sustainable living, sci-fi reading

## Usage

### Quick Start

```bash
# From the platform directory
pnpm run seed
```

### With Custom Configuration

Edit `SEED_CONFIG` in `seed-data.ts`:

```typescript
const SEED_CONFIG = {
  entityCount: {
    people: 20,        // More colleagues!
    companies: 10,
    projects: 12,
    concepts: 30,
  },
  memoryCount: {
    thoughts: 300,     // More memories
    links: 80,
    tasks: 100,
    questions: 50,
  },
  // ... adjust volumes
}
```

### Prerequisites

1. **ML Service Running** (for LLM content generation)
   ```bash
   # Start ML service
   cd ../ml-services
   python -m app.main
   ```

   If ML service is unavailable, the script falls back to pre-written templates.

2. **Database Running**
   ```bash
   # Start PostgreSQL
   docker-compose up -d postgres

   # Start Qdrant
   docker-compose up -d qdrant
   ```

3. **Environment Configured**
   ```bash
   # Ensure .env has:
   DATABASE_URL=postgresql://...
   QDRANT_URL=http://localhost:6333
   ML_SERVICE_URL=http://localhost:8000
   ```

## How It Works

### LLM-Powered Generation

Instead of static templates, the seed script uses an LLM to generate diverse, contextual content:

```typescript
const content = await generateWithLLM(
  `Generate a realistic task about "Kubernetes" for a platform migration epic.`
)
// Returns: "Review and update the Kubernetes deployment manifests for the new microservice..."
```

This ensures:
- ✅ Natural language variation
- ✅ Contextual relevance
- ✅ Realistic phrasing
- ✅ Entity relationships make sense

### Fallback Mode

If the ML service is unavailable, the script uses a curated set of realistic fallback content:

```typescript
function fallbackGeneration(prompt: string): string {
  // Returns diverse pre-written content based on prompt type
  const fallbacks = {
    thought: ["Really interesting discussion about...", "Need to look deeper into..."],
    task: ["Review PR for...", "Set up monitoring..."],
    // ... 100+ options
  }
}
```

### Data Flow

```
1. Generate Entities → PostgreSQL (entities table)
                      → Qdrant (for similarity search)

2. Generate Memories  → Qdrant (vector + payload)
                      → ML Service (embeddings)

3. Generate Facts     → PostgreSQL (facts table)
                      → Linked to source memory

4. Generate Tasks     → PostgreSQL (tasks, epics tables)
                      → Associated memories in Qdrant

5. Generate Contexts  → PostgreSQL (context_summaries table)
                      → Qdrant (conversation embeddings)
```

## Examples

### Generated Entity
```json
{
  "id": "uuid-123",
  "canonicalName": "Sarah Chen",
  "entityType": "person",
  "description": "Senior Product Manager at TechFlow, passionate about UX research and agile methodologies",
  "properties": {
    "role": "Product Manager",
    "team": "Platform",
    "source": "seed"
  },
  "aliases": ["Sarah", "S. Chen"]
}
```

### Generated Memory
```json
{
  "trace_id": "uuid-456",
  "type": "thought",
  "content": "Great coffee at the new roastery downtown - their Ethiopian pour over is fantastic. Notes of berry and chocolate.",
  "summary": "Coffee shop discovery - Ethiopian pour over",
  "origin": {
    "platform": "telegram",
    "sender": { "id": "seed-user", "name": "Alex Chen" },
    "context": { "conversation_id": "seed-context-3" }
  },
  "created_at": "2024-03-15T10:23:00Z",
  "tags": ["coffee", "personal"]
}
```

### Generated Fact
```json
{
  "subjectEntityId": "uuid-123",
  "predicate": "works_at",
  "objectEntityId": "uuid-789",
  "validAt": "2024-01-01T00:00:00Z",
  "invalidAt": null,
  "sourceMemoryId": "uuid-456",
  "sourceText": "Sarah Chen is the Senior PM at TechFlow Inc",
  "extractionMethod": "seed",
  "confidence": 0.95
}
```

## Customization

### Change Persona

Edit the `PERSONA` object in `seed-data.ts`:

```typescript
const PERSONA = {
  name: 'Your Name',
  role: 'Your Role',
  location: 'Your City',
  interests: ['your', 'interests'],
  workDomain: {
    currentCompany: 'Your Company',
    techStack: ['your', 'stack'],
  },
  // ...
}
```

### Add Custom Entity Types

```typescript
// In generateEntities()
const customEntity = await createEntity({
  name: 'My Book Club',
  type: 'organization',  // Custom type
  description: 'Weekly sci-fi book discussion group',
  properties: { meetingDay: 'Thursday' },
})
```

### Add Specific Memories

```typescript
// After running seed, add targeted content
await storeMemory({
  id: randomUUID(),
  vector: (await embed('My specific thought')).vector,
  payload: {
    trace_id: randomUUID(),
    type: 'thought',
    content: 'Specific content I want to add',
    // ...
  },
})
```

## Verification

After seeding, verify data with:

```bash
# Check entity counts
pnpm run db:studio
# Open Drizzle Studio and browse tables

# Search memories via Telegram bot
/search "Kubernetes"
/search "coffee"
/search "climbing"

# View tasks
/tasks

# Check statistics
/stats
```

## Troubleshooting

### ML Service Connection Failed

**Problem**: `ML service unavailable, using fallback content generation`

**Solution**: Start the ML service or accept fallback mode (still generates 100+ diverse content options).

```bash
cd ../ml-services
python -m app.main
```

### Database Connection Error

**Problem**: `Connection refused` or `database does not exist`

**Solution**: Ensure services are running:

```bash
docker-compose up -d postgres qdrant
```

### Vector Dimension Mismatch

**Problem**: `Vector dimension must be 768`

**Solution**: Ensure ML service uses `nomic-embed-text` model (768 dimensions).

## Performance

- **Generation Time**: ~2-5 minutes for full seed (depending on ML service speed)
- **Database Size**: ~50-100 MB (PostgreSQL) + ~20-50 MB (Qdrant)
- **Memory Usage**: Low (streaming inserts, batches every 20 records)

## Next Steps

After seeding:

1. **Explore via Bot**: Use Telegram bot commands to interact with data
2. **Test Search**: Try semantic search queries
3. **Monitor KARMA Agents**: Watch background agents process seeded data
4. **Build Queries**: Test hybrid search and knowledge graph queries
5. **Add More Data**: Continue using system normally, data will merge

## Cleanup

To remove seeded data:

```bash
# Drop and recreate database
pnpm run db:push  # Re-runs migrations

# Or clear specific tables
pnpm run db:studio
# Manual delete in Drizzle Studio

# Clear Qdrant collection
curl -X DELETE http://localhost:6333/collections/memories
```

## Ideas for Enhancement

- [ ] Import from real data sources (Notion, Obsidian, Telegram export)
- [ ] Generate temporal progression (career history, project phases)
- [ ] Create contradictions for testing conflict resolution agent
- [ ] Add multi-language content (test ML service translation)
- [ ] Generate voice audio files (not just transcriptions)
- [ ] Create realistic conversation threads (message sequences)
- [ ] Add file attachments (PDFs, images)
