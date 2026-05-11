# Work Packet W06: Telegram Bot Setup

**Status:** ⚠️ PARTIAL (Polling works, Webhook blocked by DNS)  
**Completed:** 2026-01-24  
**Dependencies:** W04 (Core App)  
**Estimated Time:** 1-2 hours

---

## Implementation Progress

| Item | Status | Notes |
|------|--------|-------|
| Bot created via BotFather | ✅ Done | @syneMnemoBot |
| Bot token in .env | ✅ Done | |
| src/bot/index.ts | ✅ Done | Full grammy implementation |
| src/bot/files.ts | ✅ Done | File download utility |
| /start command | ✅ Done | Welcome message |
| /help command | ✅ Done | Help text |
| /search command | ⚠️ Partial | Says "coming soon" - needs fix |
| Text message handling | ✅ Done | Logs + queues |
| Voice message detection | ✅ Done | |
| Photo/document detection | ✅ Done | |
| Forwarded message detection | ✅ Done | |
| Error handler | ✅ Done | |
| Polling mode | ✅ Done | Works fully |
| Webhook mode | ❌ Blocked | DNS propagation issue |
| Tailscale Funnel | ✅ Done | Running on port 3001 |

### Bot Details
- **Username:** @syneMnemoBot
- **Name:** Mnemo
- **Mode:** Polling (webhook DNS not yet propagated)

### Known Issues
- **Webhook DNS:** Telegram can't resolve `macbookpro.tail42bdd5.ts.net` yet
- **Search command:** Says "coming soon" instead of actually searching (needs fix in W07)
- **Voice transcription:** Disabled (depends on W05 Whisper)

### Deviations from Spec
- Using polling mode instead of webhooks for reliability
- Added `startPolling()` function for local development
- Removed `webhookCallback` usage to enable clean polling mode
- Bot now queues messages directly in polling mode

---

## Objective

Create Telegram bot using grammy, set up webhook with Tailscale Funnel, and handle incoming messages.

---

## Prerequisites

- [ ] W04 completed (Core app running)
- [ ] Telegram account
- [ ] Tailscale installed

---

## Step 1: Create Telegram Bot

### 1.1 Create Bot with BotFather

1. Open Telegram and search for `@BotFather`
2. Send `/newbot`
3. Follow prompts:
   - Name: `Cognitive Brain` (or your preference)
   - Username: `your_cognitive_bot` (must end in `bot`)
4. Save the **bot token** (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### 1.2 Configure Bot Settings

With BotFather, send these commands:

```
/setdescription
Your personal cognitive assistant. Send me thoughts, links, and voice notes - I'll remember everything.

/setabouttext
AI-powered personal knowledge system

/setcommands
start - Start the bot
help - Show help message
search - Search your memories
```

---

## Step 2: Set Up Tailscale Funnel

### 2.1 Enable Funnel

```bash
# Check Tailscale is running
tailscale status

# Enable Funnel for port 3000
tailscale funnel 3000

# Get your Funnel URL
tailscale funnel status
```

Your URL will look like: `https://your-machine.tail12345.ts.net`

### 2.2 Update Environment

```bash
# In .env
TELEGRAM_BOT_TOKEN=your_bot_token_here
WEBHOOK_URL=https://your-machine.tail12345.ts.net
```

---

## Step 3: Create Bot Module

### platform/src/bot/index.ts

```typescript
import { Bot, Context, webhookCallback } from 'grammy';
import { config } from '../config.js';

// Create bot instance
export const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

// Middleware: Log all updates
bot.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(`📨 Update ${ctx.update.update_id} processed in ${ms}ms`);
});

// Command: /start
bot.command('start', async (ctx) => {
  await ctx.reply(
    `👋 Hello ${ctx.from?.first_name}!\n\n` +
    `I'm your personal cognitive assistant. Here's what I can do:\n\n` +
    `📝 **Capture thoughts** - Just send me any message\n` +
    `🔗 **Save links** - Forward or send URLs\n` +
    `🎤 **Voice notes** - Record and send voice messages\n` +
    `🔍 **Search** - Say "search: your query"\n\n` +
    `Everything you send is stored in your personal knowledge base.`,
    { parse_mode: 'Markdown' }
  );
});

// Command: /help
bot.command('help', async (ctx) => {
  await ctx.reply(
    `**How to use Cognitive:**\n\n` +
    `1️⃣ **Capture a thought**\n` +
    `Just type anything and send it.\n\n` +
    `2️⃣ **Save a link**\n` +
    `Send any URL - I'll fetch and summarize it.\n\n` +
    `3️⃣ **Voice notes**\n` +
    `Record a voice message - I'll transcribe and save it.\n\n` +
    `4️⃣ **Search**\n` +
    `Type "search: kubernetes" to find related memories.\n\n` +
    `5️⃣ **Context**\n` +
    `Add me to a group chat - I'll remember conversations.`,
    { parse_mode: 'Markdown' }
  );
});

// Command: /search
bot.command('search', async (ctx) => {
  const query = ctx.match;
  if (!query) {
    await ctx.reply('Usage: /search <query>\n\nExample: /search kubernetes');
    return;
  }
  
  // For now, just acknowledge - actual search in W07
  await ctx.reply(`🔍 Searching for: "${query}"...\n\n(Search functionality coming soon!)`);
});

// Handle text messages
bot.on('message:text', async (ctx) => {
  // Check for inline search
  const text = ctx.message.text;
  if (text.toLowerCase().startsWith('search:')) {
    const query = text.slice(7).trim();
    await ctx.reply(`🔍 Searching for: "${query}"...\n\n(Search functionality coming soon!)`);
    return;
  }
  
  // Regular text - will be queued for processing
  // No reply needed (silent capture)
  console.log(`💬 Text from ${ctx.from?.first_name}: ${text.slice(0, 50)}...`);
});

// Handle voice messages
bot.on('message:voice', async (ctx) => {
  console.log(`🎤 Voice from ${ctx.from?.first_name}: ${ctx.message.voice.duration}s`);
  // Acknowledge voice receipt
  await ctx.reply('🎤 Got your voice note! Transcribing...');
});

// Handle photos
bot.on('message:photo', async (ctx) => {
  console.log(`📷 Photo from ${ctx.from?.first_name}`);
  await ctx.reply('📷 Got your photo! Processing...');
});

// Handle documents
bot.on('message:document', async (ctx) => {
  console.log(`📄 Document from ${ctx.from?.first_name}: ${ctx.message.document.file_name}`);
  await ctx.reply('📄 Got your document! Processing...');
});

// Handle forwarded messages
bot.on('message:forward_origin', async (ctx) => {
  console.log(`↪️ Forwarded message from ${ctx.from?.first_name}`);
  // Will be processed with forward context
});

// Error handler
bot.catch((err) => {
  console.error('❌ Bot error:', err);
});

/**
 * Create webhook handler for Hono
 */
export const telegramWebhook = webhookCallback(bot, 'hono');

/**
 * Set webhook URL with Telegram
 */
export async function setupWebhook(): Promise<void> {
  if (!config.WEBHOOK_URL) {
    console.log('⚠️ No WEBHOOK_URL set, skipping webhook setup');
    return;
  }
  
  const webhookUrl = `${config.WEBHOOK_URL}/webhook/telegram`;
  
  try {
    await bot.api.setWebhook(webhookUrl, {
      drop_pending_updates: true,
      allowed_updates: ['message', 'edited_message'],
    });
    console.log(`✅ Webhook set to: ${webhookUrl}`);
  } catch (error) {
    console.error('❌ Failed to set webhook:', error);
    throw error;
  }
}

/**
 * Get webhook info
 */
export async function getWebhookInfo() {
  return bot.api.getWebhookInfo();
}

/**
 * Delete webhook (for switching to polling)
 */
export async function deleteWebhook(): Promise<void> {
  await bot.api.deleteWebhook();
  console.log('✅ Webhook deleted');
}
```

---

## Step 4: Update Main Entry Point

### platform/src/index.ts (update webhook section)

```typescript
import { telegramWebhook, setupWebhook, bot } from './bot/index.js';

// Replace the placeholder webhook handler
app.post('/webhook/telegram', async (c) => {
  // First, let grammy handle the update
  try {
    // The telegramWebhook processes bot commands/handlers
    await telegramWebhook(c);
  } catch (error) {
    console.error('Webhook handler error:', error);
  }
  
  // Then queue for memory processing
  const body = await c.req.json().catch(() => null);
  if (body?.message?.text || body?.message?.voice) {
    const message = body.message;
    const boss = getQueue();
    
    await boss.send(QUEUES.MESSAGE_PROCESSING, {
      chatId: message.chat.id,
      messageId: message.message_id,
      senderId: message.from.id,
      senderName: message.from.first_name + (message.from.last_name ? ` ${message.from.last_name}` : ''),
      senderUsername: message.from.username,
      text: message.text,
      voice: message.voice ? {
        fileId: message.voice.file_id,
        duration: message.voice.duration,
      } : undefined,
      timestamp: new Date(message.date * 1000).toISOString(),
    });
  }
  
  return c.json({ ok: true });
});

// In startup function, add webhook setup
async function start() {
  // ... existing initialization ...
  
  // Set up Telegram webhook
  await setupWebhook();
  
  // ... rest of startup ...
}
```

---

## Step 5: Test Webhook Locally

### 5.1 Start Everything

```bash
# Terminal 1: Start Tailscale Funnel
tailscale funnel 3000

# Terminal 2: Start Docker services
docker compose up -d postgres qdrant ml-services

# Terminal 3: Start platform
cd platform
pnpm dev
```

### 5.2 Verify Webhook

```bash
# Check webhook status
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
```

Expected response:
```json
{
  "ok": true,
  "result": {
    "url": "https://your-machine.tail12345.ts.net/webhook/telegram",
    "has_custom_certificate": false,
    "pending_update_count": 0,
    "last_error_date": null,
    "last_error_message": null,
    "max_connections": 40,
    "allowed_updates": ["message", "edited_message"]
  }
}
```

### 5.3 Test Bot

1. Open Telegram
2. Find your bot by username
3. Send `/start`
4. Send a text message
5. Check server logs for processing

---

## Step 6: Handle Voice Messages (Preparation)

Voice messages need file download. Add this utility:

### platform/src/bot/files.ts

```typescript
import { config } from '../config.js';

/**
 * Get download URL for a Telegram file
 */
export async function getFileUrl(fileId: string): Promise<string> {
  const response = await fetch(
    `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
  );
  
  const data = await response.json();
  
  if (!data.ok) {
    throw new Error(`Failed to get file: ${data.description}`);
  }
  
  const filePath = data.result.file_path;
  return `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${filePath}`;
}
```

---

## Acceptance Criteria

- [x] Bot created via BotFather
- [x] Bot token saved in `.env`
- [x] Tailscale Funnel running on port 3001 *(changed from 3000)*
- [ ] Webhook URL configured *(BLOCKED: DNS propagation)*
- [x] `/start` command works
- [x] `/help` command works
- [x] Text messages logged in console
- [x] Voice messages acknowledged
- [ ] Webhook info shows correct URL *(BLOCKED: DNS)*
- [x] No webhook errors in Telegram API *(using polling instead)*

---

## Troubleshooting

### Webhook not receiving updates

```bash
# Check webhook info
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"

# Look for last_error_message
# Common issues:
# - SSL certificate error: Tailscale handles SSL, should work
# - Connection timeout: Check Funnel is running
# - 500 error: Check server logs
```

### Reset webhook

```bash
# Delete webhook
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook"

# Re-set from code
pnpm dev  # Will call setupWebhook() on start
```

### Test with polling (alternative)

```typescript
// Instead of webhook, use polling for local dev
bot.start();  // Starts long polling
```

---

## Next Packet

After completing W06, proceed to [W07-memory-capture.md](./W07-memory-capture.md).
