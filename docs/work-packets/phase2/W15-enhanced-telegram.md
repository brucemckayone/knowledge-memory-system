# Work Packet W15: Enhanced Telegram

**Status:** ✅ Complete
**Dependencies:** W10 (Voice), W11 (Links), W12 (Tasks)  
**Estimated Time:** 2 hours

---

## Objective

Integrate all Phase 2 capabilities into the Telegram bot with rich responses, better feedback, and improved user experience.

---

## Background

After completing W08-W14, we have:
- ✅ Skill framework for modularity
- ✅ LLM router for classification
- ✅ Voice transcription via Groq
- ✅ Link processing with summaries
- ✅ Task extraction with dates

Now we need to:
- Integrate all capabilities in bot handlers
- Provide rich feedback for each content type
- Add typing indicators and progress messages
- Handle errors gracefully
- Add new commands for task management

---

## New Bot Capabilities

### Content Type Responses

| Content | Current | Enhanced |
|---------|---------|----------|
| Text | Silent save | "💭 Saved as thought" |
| Voice | "Transcribing..." | Full transcript + type |
| Link | Basic save | Title + summary |
| Task | Basic save | Action + due date + priority |

### New Commands

| Command | Action |
|---------|--------|
| `/tasks` | List pending tasks |
| `/recent` | Show 5 most recent memories |
| `/stats` | Show memory statistics |

---

## Step 1: Update Bot Configuration

Update `platform/src/bot/index.ts` imports:

```typescript
import { Bot } from 'grammy';
import { config } from '../config.js';
import { getQueue, QUEUES } from '../queue/index.js';
import { embed } from '../services/ml.js';
import { searchMemories } from '../services/qdrant.js';
import { db } from '../db/index.js';
import { tasks } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';
```

---

## Step 2: Add /tasks Command

Add to `platform/src/bot/index.ts`:

```typescript
// Command: /tasks - List pending tasks
bot.command('tasks', async (ctx) => {
  try {
    await ctx.api.sendChatAction(ctx.chat.id, 'typing');
    
    const userId = String(ctx.from?.id);
    
    // Fetch pending tasks
    const pendingTasks = await db
      .select()
      .from(tasks)
      .where(eq(tasks.status, 'pending'))
      .orderBy(desc(tasks.createdAt))
      .limit(10);
    
    if (pendingTasks.length === 0) {
      await ctx.reply('✅ No pending tasks! You\'re all caught up.');
      return;
    }
    
    const taskList = pendingTasks.map((task, i) => {
      const priorityEmoji = {
        high: '🔴',
        medium: '🟡',
        low: '🟢',
      }[task.priority || 'medium'];
      
      const dueStr = task.dueDate 
        ? `📅 ${formatDueDate(task.dueDate)}`
        : '';
      
      return `${i + 1}. ${priorityEmoji} ${task.content}\n   ${dueStr}`;
    }).join('\n\n');
    
    await ctx.reply(
      `📋 **Your Tasks (${pendingTasks.length})**\n\n${taskList}`,
      { parse_mode: 'Markdown' }
    );
    
  } catch (error) {
    console.error('Tasks command error:', error);
    await ctx.reply('❌ Failed to fetch tasks. Please try again.');
  }
});

/**
 * Format due date for display
 */
function formatDueDate(date: Date): string {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  
  if (date.toDateString() === now.toDateString()) {
    return `Today ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  
  if (date.toDateString() === tomorrow.toDateString()) {
    return `Tomorrow ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  
  return date.toLocaleDateString([], { 
    weekday: 'short', 
    month: 'short', 
    day: 'numeric' 
  });
}
```

---

## Step 3: Add /recent Command

Add to `platform/src/bot/index.ts`:

```typescript
// Command: /recent - Show recent memories
bot.command('recent', async (ctx) => {
  try {
    await ctx.api.sendChatAction(ctx.chat.id, 'typing');
    
    // Get recent memories from Qdrant
    // We'll do a "scroll" to get recent without query
    const recent = await fetch(
      `${config.QDRANT_URL}/collections/memories/points/scroll`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          limit: 5,
          with_payload: true,
          order_by: [{ key: 'created_at', direction: 'desc' }],
        }),
      }
    ).then(r => r.json());
    
    if (!recent.result?.points?.length) {
      await ctx.reply('📭 No memories found. Send me something to remember!');
      return;
    }
    
    const memories = recent.result.points.map((p: any, i: number) => {
      const typeEmoji = {
        thought: '💭',
        link: '🔗',
        task: '📋',
        question: '❓',
      }[p.payload?.type] || '📝';
      
      const content = (p.payload?.summary || p.payload?.content || '').slice(0, 100);
      const date = p.payload?.created_at 
        ? new Date(p.payload.created_at).toLocaleDateString()
        : '';
      
      return `${i + 1}. ${typeEmoji} ${content}${content.length === 100 ? '...' : ''}\n   _${date}_`;
    }).join('\n\n');
    
    await ctx.reply(
      `📚 **Recent Memories**\n\n${memories}`,
      { parse_mode: 'Markdown' }
    );
    
  } catch (error) {
    console.error('Recent command error:', error);
    await ctx.reply('❌ Failed to fetch recent memories.');
  }
});
```

---

## Step 4: Add /stats Command

Add to `platform/src/bot/index.ts`:

```typescript
// Command: /stats - Show statistics
bot.command('stats', async (ctx) => {
  try {
    await ctx.api.sendChatAction(ctx.chat.id, 'typing');
    
    // Get collection info from Qdrant
    const collectionInfo = await fetch(
      `${config.QDRANT_URL}/collections/memories`
    ).then(r => r.json());
    
    const pointCount = collectionInfo.result?.points_count || 0;
    
    // Get task counts
    const [taskStats] = await db
      .select({
        pending: db.fn.count(tasks.id).filterWhere(eq(tasks.status, 'pending')),
        completed: db.fn.count(tasks.id).filterWhere(eq(tasks.status, 'completed')),
      })
      .from(tasks);
    
    await ctx.reply(
      `📊 **Your Knowledge Stats**\n\n` +
      `📚 Memories: ${pointCount}\n` +
      `📋 Tasks pending: ${taskStats?.pending || 0}\n` +
      `✅ Tasks completed: ${taskStats?.completed || 0}`,
      { parse_mode: 'Markdown' }
    );
    
  } catch (error) {
    console.error('Stats command error:', error);
    await ctx.reply('❌ Failed to fetch stats.');
  }
});
```

---

## Step 5: Update /help Command

Update the help command to show new features:

```typescript
bot.command('help', async (ctx) => {
  await ctx.reply(
    `**Cognitive Platform - Commands**\n\n` +
    
    `**📝 Capture**\n` +
    `Just send any message to save it as a memory.\n\n` +
    
    `**🔍 Search**\n` +
    `/search <query> - Find memories\n` +
    `search: <query> - Inline search\n\n` +
    
    `**📋 Tasks**\n` +
    `/tasks - View pending tasks\n` +
    `"Remind me to..." - Create task\n\n` +
    
    `**📚 Browse**\n` +
    `/recent - Show recent memories\n` +
    `/stats - Your stats\n\n` +
    
    `**🎤 Voice**\n` +
    `Send voice messages - I'll transcribe them!\n\n` +
    
    `**🔗 Links**\n` +
    `Send URLs - I'll summarize them!`,
    { parse_mode: 'Markdown' }
  );
});
```

---

## Step 6: Update Voice Handler

Update voice message handler:

```typescript
bot.on('message:voice', async (ctx) => {
  const duration = ctx.message.voice.duration;
  console.log(`🎤 Voice from ${ctx.from?.first_name}: ${duration}s`);
  
  // Check duration
  if (duration > 120) {
    await ctx.reply('⚠️ Voice note too long! Please keep it under 2 minutes.');
    return;
  }
  
  // Show processing indicator
  await ctx.api.sendChatAction(ctx.chat.id, 'record_voice');
  
  // Queue for processing
  await queueMessage(ctx);
  
  // Acknowledge
  await ctx.reply(
    `🎤 Got ${duration}s voice note! Transcribing...`
  );
});
```

---

## Step 7: Create Notification Handler

Create `platform/src/bot/notifications.ts`:

```typescript
import { bot } from './index.js';

export interface MemoryNotification {
  chatId: number;
  type: 'thought' | 'link' | 'task' | 'voice';
  content: string;
  extra?: {
    // For links
    title?: string;
    summary?: string;
    url?: string;
    
    // For tasks
    action?: string;
    dueDate?: string;
    priority?: string;
    
    // For voice
    duration?: number;
  };
}

/**
 * Send appropriate notification based on memory type
 */
export async function notifyMemorySaved(notification: MemoryNotification): Promise<void> {
  const { chatId, type, content, extra } = notification;
  
  try {
    switch (type) {
      case 'thought':
        await bot.api.sendMessage(chatId, 
          `💭 Thought saved!\n\n"${content.slice(0, 100)}${content.length > 100 ? '...' : ''}"`,
          { parse_mode: 'Markdown' }
        );
        break;
        
      case 'link':
        await bot.api.sendMessage(chatId, 
          `🔗 **Link saved!**\n\n` +
          `📰 ${extra?.title || 'Untitled'}\n\n` +
          `📝 ${extra?.summary || 'No summary available'}`,
          { parse_mode: 'Markdown' }
        );
        break;
        
      case 'task':
        const priorityEmoji = {
          high: '🔴',
          medium: '🟡',
          low: '🟢',
        }[extra?.priority || 'medium'];
        
        await bot.api.sendMessage(chatId, 
          `✅ **Task created!**\n\n` +
          `📋 ${extra?.action || content}\n` +
          `📅 ${formatDueDisplay(extra?.dueDate)}\n` +
          `${priorityEmoji} Priority: ${extra?.priority || 'medium'}`,
          { parse_mode: 'Markdown' }
        );
        break;
        
      case 'voice':
        await bot.api.sendMessage(chatId, 
          `🎤 **Voice note saved!**\n\n` +
          `📝 "${content.slice(0, 150)}${content.length > 150 ? '...' : ''}"`,
          { parse_mode: 'Markdown' }
        );
        break;
    }
  } catch (error) {
    console.error('Failed to send notification:', error);
  }
}

function formatDueDisplay(dateStr?: string): string {
  if (!dateStr) return 'No deadline';
  
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    if (date.toDateString() === now.toDateString()) {
      return `Today at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    if (date.toDateString() === tomorrow.toDateString()) {
      return `Tomorrow at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    
    return date.toLocaleDateString([], { 
      weekday: 'short', 
      month: 'short', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}
```

---

## Step 8: Update Message Processor to Send Notifications

Update `platform/src/workers/message-processor.ts`:

```typescript
import { notifyMemorySaved } from '../bot/notifications.js';

// After successful processing, send notification:

// Notify user based on type
await notifyMemorySaved({
  chatId: data.chatId,
  type: memoryType as any,
  content: textToEmbed,
  extra: {
    // For links
    title: envelope.enrichments.fetch?.title,
    summary: envelope.enrichments.summarize?.summary,
    url: envelope.enrichments.extract_url?.url,
    
    // For tasks
    action: envelope.enrichments.extract_task?.action,
    dueDate: envelope.enrichments.extract_task?.due_date,
    priority: envelope.enrichments.extract_task?.priority,
    
    // For voice
    duration: envelope.enrichments.transcribe?.duration_ms,
  },
});
```

---

## Step 9: Add Error Feedback

Update error handling in message processor:

```typescript
// Error handler with user feedback
catch (error) {
  console.error('❌ Processing failed:', error);
  logFailure(envelope, 'processing', String(error), startTime);
  envelope.routing.status = 'failed';
  
  // User-friendly error message
  let errorMessage = '❌ Something went wrong. Please try again.';
  
  if (String(error).includes('transcription')) {
    errorMessage = '❌ Couldn\'t transcribe your voice note. Please try again or send text.';
  } else if (String(error).includes('fetch')) {
    errorMessage = '❌ Couldn\'t fetch that link. It may be blocked or unavailable.';
  } else if (String(error).includes('timeout')) {
    errorMessage = '❌ Request timed out. Please try again.';
  }
  
  try {
    await bot.api.sendMessage(data.chatId, errorMessage);
  } catch {
    // Ignore notification error
  }
  
  throw error; // pg-boss will retry
}
```

---

## Verification

### Automated Tests
Run simple notification formatting tests.

```bash
# Create platform/src/bot/__tests__/notifications.test.ts
import { formatDueDisplay } from '../notifications.js'; // Export this for testing
import { describe, it, expect } from 'vitest';

describe('Notifications', () => {
  it('should format no deadline', () => {
    expect(formatDueDisplay(undefined)).toBe('No deadline');
  });
});
```

### Test Commands

```bash
# In Telegram bot:

/help
# Should show all commands

/tasks
# Should show pending tasks or "no tasks"

/recent
# Should show recent memories

/stats
# Should show memory count and task counts

/search kubernetes
# Should search and return results
```

### Test Each Content Type

1. **Text**: Send "I'm thinking about the project"
   - Should reply: "💭 Thought saved!"

2. **Link**: Send "Check out https://example.com"
   - Should reply: "🔗 Link saved! + title + summary"

3. **Task**: Send "Remind me to call John tomorrow"
   - Should reply: "✅ Task created! + action + due date"

4. **Voice**: Send voice message
   - Should reply: "🎤 Voice note saved! + transcript"

---

## Acceptance Criteria

- [ ] `/help` shows all commands
- [ ] `/tasks` shows pending tasks
- [ ] `/recent` shows recent memories
- [ ] `/stats` shows statistics
- [ ] Text messages get "thought saved" reply
- [ ] Links get title + summary reply
- [ ] Tasks get action + due date reply
- [ ] Voice notes get transcript reply
- [ ] Errors show user-friendly messages
- [ ] Typing indicators during processing

---

## Summary

After completing W15, the Telegram bot will:

1. ✅ Capture thoughts, links, tasks, and voice
2. ✅ Provide rich feedback for each type
3. ✅ Support new commands (/tasks, /recent, /stats)
4. ✅ Show typing indicators during processing
5. ✅ Handle errors gracefully with clear messages
6. ✅ Integrate all Phase 2 capabilities

---

## Phase 2 Complete! 🎉

After completing W08-W15, you have:

- **Skill Framework** (W08) - Modular processing units
- **LLM Router** (W09) - Smart intent classification
- **Voice Transcription** (W10) - Groq-powered speech-to-text
- **Link Processing** (W11) - Fetch, summarize, store
- **Task Extraction** (W12) - Structured task parsing
- **Web Scraper** (W13) - Content extraction
- **Workflow Engine** (W14) - Unified execution
- **Enhanced Telegram** (W15) - Rich user experience

**Next Steps:**
- Update TECHNICAL_PLAN.md to mark Phase 2 complete
- Tag as v0.2.0
- Plan Phase 3 (Intelligence: Context Entities, Gardener, Briefings)
