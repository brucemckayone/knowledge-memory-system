# Work Packet W10: Voice Transcription

**Status:** Ready to Implement  
**Dependencies:** None (can be done in parallel with W08)  
**Estimated Time:** 2-3 hours

---

## Objective

Enable voice note transcription so voice messages sent to Telegram are converted to text, processed, and stored as memories. This completes a key user feature that was blocked in Phase 1.

---

## Background

### Current State
- Bot detects voice messages and replies "Transcribing..."
- `ml-services/app/transcribe.py` exists but `faster-whisper` fails to build
- `getFileUrl()` in `bot/files.ts` can download Telegram files
- Message processor skips voice with TODO comment

### Problem
The `faster-whisper` package requires complex native dependencies (PyAV, FFmpeg) that fail to build in our Docker environment.

### Solution
Use **Groq API** for transcription:
- Free tier: 100 requests/day (enough for personal use)
- Uses Whisper-large-v3 model
- Fast: <5 seconds for 60s audio
- Falls back to local Whisper when available

---

## Architecture

### Transcription Flow

```
Voice Message (Telegram)
         ↓
    getFileUrl() → Telegram API download URL
         ↓
    Download audio to temp file
         ↓
    Groq API /audio/transcriptions
         ↓
    Return text + metadata
         ↓
    Process as text message
```

---

## Step 1: Get Groq API Key

1. Go to https://console.groq.com
2. Sign up / Log in
3. Navigate to API Keys
4. Create new key: "cognitive-platform"
5. Copy the key (starts with `gsk_`)

---

## Step 2: Add Environment Variable

Update `ml-services/.env`:

```bash
# Groq API for transcription
GROQ_API_KEY=gsk_your_api_key_here
```

Update Docker Compose to pass the env var:

```yaml
# docker-compose.yml
ml-services:
  environment:
    - GROQ_API_KEY=${GROQ_API_KEY}
```

---

## Step 3: Update Python Requirements

Update `ml-services/requirements.txt`:

```
fastapi==0.109.0
uvicorn==0.27.0
httpx==0.25.2
python-multipart==0.0.6
pydantic==2.5.3
ollama>=0.1.6
groq>=0.4.0  # Add Groq client
aiofiles>=23.0.0  # Async file handling
```

---

## Step 4: Rewrite Transcribe Endpoint

Replace `ml-services/app/transcribe.py`:

```python
import os
import tempfile
from typing import Optional
from fastapi import APIRouter, HTTPException, UploadFile, File
from pydantic import BaseModel
import httpx
from groq import Groq

router = APIRouter()

# Initialize Groq client
groq_client = None


def get_groq_client() -> Groq:
    """Get or create Groq client"""
    global groq_client
    if groq_client is None:
        api_key = os.getenv("GROQ_API_KEY")
        if not api_key:
            raise HTTPException(
                status_code=503,
                detail="GROQ_API_KEY not configured"
            )
        groq_client = Groq(api_key=api_key)
    return groq_client


class TranscribeUrlRequest(BaseModel):
    """Request body for URL-based transcription"""
    audio_url: str
    language: Optional[str] = None


class TranscribeResponse(BaseModel):
    """Response body with transcription"""
    text: str
    language: str
    duration_ms: int
    provider: str = "groq"


@router.get("/transcribe/status")
def transcribe_status():
    """Check if transcription is available"""
    has_groq = bool(os.getenv("GROQ_API_KEY"))
    return {
        "available": has_groq,
        "provider": "groq" if has_groq else None,
        "message": "Groq transcription ready" if has_groq else "Configure GROQ_API_KEY"
    }


async def download_audio(url: str) -> bytes:
    """Download audio from URL"""
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(url, follow_redirects=True)
        response.raise_for_status()
        return response.content


def get_audio_duration_estimate(file_size: int) -> int:
    """Estimate audio duration from file size (rough)"""
    # Telegram voice messages are Opus at ~32kbps
    # 32kbps = 4KB/s, so 1 minute = ~240KB
    bytes_per_second = 4000
    return int((file_size / bytes_per_second) * 1000)


@router.post("/transcribe", response_model=TranscribeResponse)
async def transcribe_url(request: TranscribeUrlRequest):
    """
    Transcribe audio from URL using Groq API.
    
    Supports: mp3, wav, ogg, m4a, webm, flac
    Max file size: 25MB
    Max duration: 120 minutes
    """
    try:
        # Download audio
        print(f"📥 Downloading audio from {request.audio_url[-50:]}")
        audio_data = await download_audio(request.audio_url)
        file_size = len(audio_data)
        print(f"📦 Downloaded {file_size / 1024:.1f}KB")
        
        # Check file size (Groq limit is 25MB)
        if file_size > 25 * 1024 * 1024:
            raise HTTPException(
                status_code=400,
                detail="Audio file too large (max 25MB)"
            )
        
        # Save to temp file
        with tempfile.NamedTemporaryFile(suffix=".ogg", delete=False) as f:
            f.write(audio_data)
            temp_path = f.name
        
        try:
            # Transcribe with Groq
            print("🎤 Transcribing with Groq...")
            client = get_groq_client()
            
            with open(temp_path, "rb") as audio_file:
                transcription = client.audio.transcriptions.create(
                    file=audio_file,
                    model="whisper-large-v3",
                    language=request.language,  # Optional: auto-detect if None
                    response_format="verbose_json"
                )
            
            # Extract result
            text = transcription.text.strip()
            language = transcription.language or "en"
            
            # Try to get duration, estimate if not available
            if hasattr(transcription, 'duration'):
                duration_ms = int(transcription.duration * 1000)
            else:
                duration_ms = get_audio_duration_estimate(file_size)
            
            print(f"✅ Transcribed: {len(text)} chars, {duration_ms}ms, lang={language}")
            
            return TranscribeResponse(
                text=text,
                language=language,
                duration_ms=duration_ms,
                provider="groq"
            )
            
        finally:
            # Clean up temp file
            os.unlink(temp_path)
            
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to download audio: {str(e)}"
        )
    except Exception as e:
        print(f"❌ Transcription error: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Transcription failed: {str(e)}"
        )


@router.post("/transcribe/upload", response_model=TranscribeResponse)
async def transcribe_upload(file: UploadFile = File(...)):
    """
    Transcribe uploaded audio file using Groq.
    
    Supports: mp3, wav, ogg, m4a, webm, flac
    """
    try:
        content = await file.read()
        
        # Check file size
        if len(content) > 25 * 1024 * 1024:
            raise HTTPException(
                status_code=400,
                detail="Audio file too large (max 25MB)"
            )
        
        ext = os.path.splitext(file.filename or "audio.ogg")[1]
        
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as f:
            f.write(content)
            temp_path = f.name
        
        try:
            client = get_groq_client()
            
            with open(temp_path, "rb") as audio_file:
                transcription = client.audio.transcriptions.create(
                    file=audio_file,
                    model="whisper-large-v3",
                    response_format="verbose_json"
                )
            
            return TranscribeResponse(
                text=transcription.text.strip(),
                language=transcription.language or "en",
                duration_ms=int(getattr(transcription, 'duration', 0) * 1000),
                provider="groq"
            )
            
        finally:
            os.unlink(temp_path)
            
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Transcription failed: {str(e)}"
        )
```

---

## Step 5: Update TypeScript Transcribe Function

Update `platform/src/services/ml.ts`:

```typescript
interface TranscribeResponse {
  text: string;
  language: string;
  duration_ms: number;
  provider?: string;
}

/**
 * Transcribe audio file
 */
export async function transcribe(audioUrl: string): Promise<TranscribeResponse> {
  const response = await fetch(`${config.ML_SERVICES_URL}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_url: audioUrl }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Transcription failed: ${response.status} - ${error}`);
  }

  return response.json() as Promise<TranscribeResponse>;
}

/**
 * Check if transcription is available
 */
export async function checkTranscribeStatus(): Promise<{
  available: boolean;
  provider: string | null;
  message: string;
}> {
  try {
    const response = await fetch(`${config.ML_SERVICES_URL}/transcribe/status`);
    return response.json();
  } catch {
    return { available: false, provider: null, message: 'Service unavailable' };
  }
}
```

---

## Step 6: Update Message Processor for Voice

Update `platform/src/workers/message-processor.ts`:

```typescript
import { getFileUrl } from '../bot/files.js';
import { transcribe } from '../services/ml.js';

// In processMessage function, replace the voice handling:

// Process voice messages
if (data.voice) {
  console.log('🎤 Processing voice note...');
  
  try {
    // Get Telegram file URL
    const fileUrl = await getFileUrl(data.voice.fileId);
    console.log(`📥 Got file URL: ${fileUrl.slice(-30)}`);
    
    // Transcribe
    const transcribeStart = Date.now();
    const transcription = await transcribe(fileUrl);
    
    addEnrichment(envelope, 'transcribe', {
      text: transcription.text,
      language: transcription.language,
      duration_ms: transcription.duration_ms,
    }, transcribeStart);
    
    console.log(`✅ Transcribed ${transcription.duration_ms}ms audio`);
    console.log(`   Text: "${transcription.text.slice(0, 100)}..."`);
    
    // Use transcribed text for processing
    textToEmbed = transcription.text;
    
    // Update envelope raw
    envelope.raw.content = transcription.text;
    
  } catch (error) {
    console.error('❌ Transcription failed:', error);
    logFailure(envelope, 'transcribe', String(error), Date.now());
    
    // Notify user of failure
    await bot.api.sendMessage(data.chatId, 
      '❌ Sorry, I couldn\'t transcribe your voice note. Please try again or send text instead.'
    );
    return;
  }
}
```

---

## Step 7: Update Bot Voice Handler

Update `platform/src/bot/index.ts` voice handler:

```typescript
// Handle voice messages
bot.on('message:voice', async (ctx) => {
  console.log(`🎤 Voice from ${ctx.from?.first_name}: ${ctx.message.voice.duration}s`);
  
  // Show "recording" action while processing
  await ctx.api.sendChatAction(ctx.chat.id, 'record_voice');
  
  // Queue for processing (transcription happens in worker)
  await queueMessage(ctx);
  
  // Acknowledge receipt
  await ctx.reply('🎤 Got your voice note! Transcribing...');
});
```

---

## Step 8: Add Voice Completion Notification

In message processor, after successful voice storage:

```typescript
// Notify user of successful voice processing
if (data.voice && envelope.enrichments.transcribe) {
  const preview = envelope.enrichments.transcribe.text.slice(0, 100);
  await bot.api.sendMessage(data.chatId, 
    `✅ Voice note saved!\n\n📝 "${preview}..."\n\n🏷️ Type: ${memoryType}`
  );
}
```

---

## Step 9: Rebuild Docker

```bash
# Rebuild ml-services with new dependencies
docker compose build ml-services

# Restart
docker compose up -d ml-services

# Check logs
docker compose logs -f ml-services
```

---

## Testing

## Verification

### Automated Tests
Run simple unit tests for transcription service.

```bash
# Create platform/src/services/__tests__/ml.test.ts
import { transcribe } from '../ml.js';
import { describe, it, expect, vi } from 'vitest';

describe('Transcription Service', () => {
  it('should call ML service', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'hello', language: 'en', duration_ms: 1000 })
    });

    const result = await transcribe('http://test.url');
    expect(result.text).toBe('hello');
  });
});
```

### Manual Verification

#### Test Transcription Status
```bash
curl http://localhost:8000/transcribe/status
# Expected: {"available": true, "provider": "groq", "message": "Groq transcription ready"}
```

#### Test Transcription (with sample audio)
```bash
# Test with a sample audio URL
curl -X POST http://localhost:8000/transcribe \
  -H "Content-Type: application/json" \
  -d '{"audio_url": "https://www2.cs.uic.edu/~i101/SoundFiles/StarWars3.wav"}'
```

#### Test End-to-End
1. Send a voice note to your Telegram bot
2. Should receive "Transcribing..." message
3. Should receive confirmation with transcribed text preview
4. Check Qdrant for stored memory

---

## Acceptance Criteria

- [ ] `GROQ_API_KEY` configured in environment
- [ ] `/transcribe/status` shows available
- [ ] `/transcribe` endpoint returns transcription
- [ ] `platform/src/services/ml.ts` updated
- [ ] Message processor handles voice notes
- [ ] Bot sends transcription preview
- [ ] Voice memories stored in Qdrant
- [ ] Envelope contains transcribe enrichment
- [ ] Error messages shown to user on failure
- [ ] Works for voice notes up to 2 minutes

---

## Error Handling

| Error | User Message | Recovery |
|-------|--------------|----------|
| No API key | ❌ Transcription unavailable | Admin configures GROQ_API_KEY |
| Download failed | ❌ Couldn't download voice note | Retry or send text |
| Transcription failed | ❌ Couldn't transcribe | Send text instead |
| File too large | ❌ Voice note too long | Limit to 2 minutes |

---

## Rate Limits

Groq free tier:
- 100 requests/day
- 25MB max file size
- 120 minutes max audio

For personal use, this is sufficient. If needed, upgrade to paid tier.

---

## Next Packet

After completing W10, proceed to:
- [W15: Enhanced Telegram](./W15-enhanced-telegram.md) - Full integration
- [W09: LLM Router](./W09-llm-router.md) - Classify transcribed text
