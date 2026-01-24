# Work Packet W32: Morning Briefing

**Status:** Ready to Implement  
**Dependencies:** W31 (Insight Generation), W15 (Enhanced Telegram)  
**Estimated Time:** 3-4 hours

---

## Objective

Implement the Morning Briefing feature that compiles insights, tasks, and relevant knowledge into a personalized daily summary delivered via Telegram.

---

## Research Reference

From [GARDENER_RESEARCH.md](../GARDENER_RESEARCH.md) lines 450-480:
- Proactive morning briefing
- Personalized content selection
- Multi-channel delivery

---

## Implementation

### Briefing Service

Create `platform/src/services/briefing.ts`:

```typescript
import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';
import { getPendingInsights } from './insights.js';
import { config } from '../config.js';

export interface BriefingSection {
  title: string;
  items: string[];
  priority: 'high' | 'medium' | 'low';
}

export interface Briefing {
  id: string;
  date: string;
  greeting: string;
  sections: BriefingSection[];
  generatedAt: Date;
}

/**
 * Generate morning briefing
 */
export async function generateBriefing(): Promise<Briefing> {
  const today = new Date().toISOString().split('T')[0];
  const greeting = getGreeting();
  
  const sections: BriefingSection[] = [];
  
  // 1. Today's Tasks
  const tasks = await getTodaysTasks();
  if (tasks.length > 0) {
    sections.push({
      title: "📋 Today's Tasks",
      items: tasks.map(t => `• ${t.action} (${t.priority})`),
      priority: 'high',
    });
  }
  
  // 2. Upcoming Events
  const events = await getUpcomingEvents();
  if (events.length > 0) {
    sections.push({
      title: '📅 Coming Up',
      items: events.map(e => `• ${e.title} - ${e.time}`),
      priority: 'high',
    });
  }
  
  // 3. New Insights
  const insights = await getPendingInsights(3);
  if (insights.length > 0) {
    sections.push({
      title: '💡 Insights',
      items: insights.map(i => `• ${i.title}: ${i.description}`),
      priority: 'medium',
    });
  }
  
  // 4. Recent Activity Summary
  const activity = await getRecentActivity();
  if (activity) {
    sections.push({
      title: '📊 Yesterday',
      items: [
        `• ${activity.memoriesAdded} new memories`,
        `• ${activity.tasksCompleted} tasks completed`,
        `• ${activity.entitiesDiscovered} entities discovered`,
      ],
      priority: 'low',
    });
  }
  
  // 5. Pending Questions
  const questions = await getPendingQuestions();
  if (questions.length > 0) {
    sections.push({
      title: '❓ Open Questions',
      items: questions.map(q => `• ${q.question}`),
      priority: 'medium',
    });
  }
  
  const briefing: Briefing = {
    id: `briefing-${today}`,
    date: today,
    greeting,
    sections,
    generatedAt: new Date(),
  };
  
  // Store briefing
  await storeBriefing(briefing);
  
  return briefing;
}

/**
 * Get time-appropriate greeting
 */
function getGreeting(): string {
  const hour = new Date().getHours();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const day = dayNames[new Date().getDay()];
  
  if (hour < 12) {
    return `🌅 Good morning! Here's your ${day} briefing.`;
  } else if (hour < 17) {
    return `☀️ Good afternoon! Catching up on ${day}.`;
  } else {
    return `🌙 Good evening! ${day} summary incoming.`;
  }
}

/**
 * Get tasks due today
 */
async function getTodaysTasks(): Promise<Array<{ action: string; priority: string }>> {
  const result = await db.execute(sql`
    SELECT action, priority FROM tasks
    WHERE status != 'completed'
      AND (due_date IS NULL OR due_date::date <= CURRENT_DATE)
    ORDER BY 
      CASE priority 
        WHEN 'high' THEN 1 
        WHEN 'medium' THEN 2 
        ELSE 3 
      END
    LIMIT 5
  `);
  
  return result.rows.map((r: any) => ({
    action: r.action,
    priority: r.priority || 'medium',
  }));
}

/**
 * Get events in next 24 hours
 */
async function getUpcomingEvents(): Promise<Array<{ title: string; time: string }>> {
  // Query memories with event content type and future dates
  const result = await db.execute(sql`
    SELECT content, created_at FROM memories_meta
    WHERE content_type = 'event'
      AND event_date > NOW()
      AND event_date < NOW() + INTERVAL '24 hours'
    ORDER BY event_date
    LIMIT 5
  `);
  
  return result.rows.map((r: any) => ({
    title: r.content.substring(0, 50),
    time: new Date(r.event_date).toLocaleTimeString(),
  }));
}

/**
 * Get recent activity stats
 */
async function getRecentActivity(): Promise<{
  memoriesAdded: number;
  tasksCompleted: number;
  entitiesDiscovered: number;
} | null> {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  
  const memories = await db.execute(sql`
    SELECT COUNT(*) as count FROM processing_state
    WHERE created_at > ${yesterday}
  `);
  
  const tasks = await db.execute(sql`
    SELECT COUNT(*) as count FROM tasks
    WHERE status = 'completed'
      AND updated_at > ${yesterday}
  `);
  
  const entities = await db.execute(sql`
    SELECT COUNT(*) as count FROM entities
    WHERE created_at > ${yesterday}
  `);
  
  return {
    memoriesAdded: parseInt(memories.rows[0]?.count || '0'),
    tasksCompleted: parseInt(tasks.rows[0]?.count || '0'),
    entitiesDiscovered: parseInt(entities.rows[0]?.count || '0'),
  };
}

/**
 * Get pending questions
 */
async function getPendingQuestions(): Promise<Array<{ question: string }>> {
  // Find memories classified as questions without answers
  const result = await db.execute(sql`
    SELECT content FROM memories_meta
    WHERE content_type = 'question'
      AND answered = false
    ORDER BY created_at DESC
    LIMIT 3
  `);
  
  return result.rows.map((r: any) => ({
    question: r.content.substring(0, 100),
  }));
}

/**
 * Store briefing
 */
async function storeBriefing(briefing: Briefing): Promise<void> {
  await db.execute(sql`
    INSERT INTO briefings (id, date, greeting, sections, generated_at)
    VALUES (
      ${briefing.id},
      ${briefing.date},
      ${briefing.greeting},
      ${JSON.stringify(briefing.sections)},
      ${briefing.generatedAt}
    )
    ON CONFLICT (id) DO UPDATE
    SET sections = EXCLUDED.sections,
        generated_at = EXCLUDED.generated_at
  `);
}

/**
 * Format briefing for Telegram
 */
export function formatBriefingForTelegram(briefing: Briefing): string {
  let message = `${briefing.greeting}\n\n`;
  
  for (const section of briefing.sections) {
    message += `*${section.title}*\n`;
    message += section.items.join('\n');
    message += '\n\n';
  }
  
  message += `_Generated at ${briefing.generatedAt.toLocaleTimeString()}_`;
  
  return message;
}
```

### Schema Addition

Create `platform/src/db/migrations/011_briefings.sql`:

```sql
CREATE TABLE IF NOT EXISTS briefings (
  id TEXT PRIMARY KEY,
  date DATE NOT NULL,
  greeting TEXT NOT NULL,
  sections JSONB NOT NULL DEFAULT '[]',
  generated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  delivered_at TIMESTAMP WITH TIME ZONE,
  UNIQUE(date)
);

CREATE TABLE IF NOT EXISTS memories_meta (
  memory_id TEXT PRIMARY KEY,
  content_type TEXT,
  event_date TIMESTAMP WITH TIME ZONE,
  answered BOOLEAN DEFAULT FALSE,
  content TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_briefings_date ON briefings(date);
CREATE INDEX idx_memories_meta_type ON memories_meta(content_type);
```

### Telegram Delivery

Update `telegram-bot/src/bot.ts`:

```typescript
import { generateBriefing, formatBriefingForTelegram } from '@platform/services/briefing.js';

// Scheduled briefing command
bot.command('briefing', async (ctx) => {
  const briefing = await generateBriefing();
  const message = formatBriefingForTelegram(briefing);
  
  await ctx.reply(message, { parse_mode: 'Markdown' });
});

// Auto-delivery (call from scheduler)
export async function sendMorningBriefing(chatId: number): Promise<void> {
  const briefing = await generateBriefing();
  const message = formatBriefingForTelegram(briefing);
  
  await bot.telegram.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  
  // Mark as delivered
  await db.execute(sql`
    UPDATE briefings 
    SET delivered_at = NOW() 
    WHERE id = ${briefing.id}
  `);
}
```

### Scheduler Integration

Add to `platform/src/gardener/controller.ts`:

```typescript
// Schedule morning briefing at 6:00 AM
this.scheduleDaily('morning-briefing', '0 6 * * *', async () => {
  const { sendMorningBriefing } = await import('../telegram/delivery.js');
  const userId = config.TELEGRAM_USER_ID;
  if (userId) {
    await sendMorningBriefing(parseInt(userId));
  }
});
```

---

## Testing

```bash
# Manually request briefing
# In Telegram: /briefing

# View briefing history
psql -d cognitive -c "SELECT date, generated_at, delivered_at FROM briefings ORDER BY date DESC;"
```

---

## Acceptance Criteria

- [ ] Briefing compiled from multiple sources
- [ ] Time-appropriate greeting
- [ ] Tasks, events, insights included
- [ ] Formatted for Telegram
- [ ] `/briefing` command works
- [ ] Scheduled delivery at 6 AM
- [ ] Delivery tracked in database

---

## Next Packet

- [W33: Scheduled Contradiction Detection](./W33-contradiction-scheduler.md) - Nightly validation
