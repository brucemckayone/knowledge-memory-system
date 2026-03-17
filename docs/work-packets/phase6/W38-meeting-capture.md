# Work Packet W38: Meeting Capture (Transcripts + Audio)

**Status:** ❌ Not Started
**Dependencies:** W36 (File Watcher), W37 (Document & Transcript ML Endpoints)
**Estimated Time:** 4–5 hours

---

## Objective

Wire meeting content into Mnemo via three ingestion paths: **live audio capture** (record mic + system audio during a meeting), **VTT/SRT transcript files** (pre-transcribed, e.g. Teams export), and **pre-recorded audio files** (dropped after the fact). All paths produce structured meeting data — speaker attribution, timestamps, action items — that feeds into the entity and task extraction pipelines.

This approach is platform-agnostic: it intercepts Teams, Zoom, Meet, phone calls — anything playing through your speakers.

---

## Ingestion Paths

```
Path 1: Live audio capture (primary)
  User presses hotkey → records mic + system audio (WASAPI loopback)
  User presses hotkey again → stops recording
    → Saves .wav to watch/incoming/
    → File Watcher detects audio extension
    → /transcribe/upload (W10 Whisper pipeline)
    → IngestRouter → pg-boss queue

Path 2: Pre-transcribed (VTT/SRT)
  User exports .vtt from Teams (or Power Automate drops it)
    → File Watcher detects .vtt
    → /parse-transcript (W37) — speaker diarization, action items
    → IngestRouter → pg-boss queue

Path 3: Pre-recorded audio file drop
  User drops .mp3/.wav/.m4a (recorded externally)
    → File Watcher detects audio extension
    → /transcribe/upload (W10 Whisper pipeline)
    → IngestRouter → pg-boss queue

All paths → Message Processor → Entity Extraction → Task Extraction
```

---

## Implementation

### Recording Client (Native Host Tool)

A lightweight Python system tray app that runs **natively on the host machine** (not in Docker). It captures mic input + system audio (what Teams/Zoom is playing through your speakers) and saves the mixed recording to `watch/incoming/` when stopped.

**Why native?** Docker containers can't access host audio devices. The recording client must run outside Docker, directly on Windows, where it has access to WASAPI loopback for system audio capture.

#### Architecture

```
┌─────────────────────────────────────────────┐
│  Host Machine (Windows)                     │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │  mnemo-recorder (system tray)       │    │
│  │  - Hotkey: Ctrl+Shift+R toggle      │    │
│  │  - Mic capture (sounddevice)        │    │
│  │  - System audio (WASAPI loopback)   │    │
│  │  - Mix to single .wav file          │    │
│  └──────────────┬──────────────────────┘    │
│                 │ .wav                       │
│                 ▼                            │
│  watch/incoming/meeting-2026-03-12-1430.wav  │
│                                             │
│  ┌──────────────────────────────────────┐   │
│  │  Docker: Mnemo stack                 │   │
│  │  File Watcher → Whisper → Pipeline   │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

#### Implementation: `tools/mnemo-recorder/recorder.py`

```python
"""
Mnemo Meeting Recorder — system tray app for live audio capture.

Captures mic + system audio (WASAPI loopback) simultaneously,
mixes to a single WAV file, and drops it into the watch directory
for automatic ingestion via the file watcher pipeline.

Runs natively on Windows (not in Docker).
Requires: pip install sounddevice soundfile numpy pystray Pillow keyboard
"""

import os
import sys
import time
import threading
from datetime import datetime
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundfile as sf
import keyboard
import pystray
from PIL import Image, ImageDraw

# --- Config ---
WATCH_DIR = os.environ.get("MNEMO_WATCH_DIR", "./watch/incoming")
SAMPLE_RATE = 16000      # 16kHz is optimal for Whisper
CHANNELS = 1             # Mono (Whisper works best with mono)
HOTKEY = "ctrl+shift+r"
RECORDING_ICON_COLOR = "red"
IDLE_ICON_COLOR = "green"


class MnemoRecorder:
    def __init__(self):
        self.recording = False
        self.mic_data: list[np.ndarray] = []
        self.loopback_data: list[np.ndarray] = []
        self.mic_stream = None
        self.loopback_stream = None
        self.tray_icon = None

    def find_loopback_device(self) -> int | None:
        """
        Find WASAPI loopback device for system audio capture.
        On Windows, this captures what's playing through speakers —
        i.e., the other participants in a Teams/Zoom call.
        """
        devices = sd.query_devices()
        for i, dev in enumerate(devices):
            name = dev['name'].lower()
            # WASAPI loopback devices typically contain these markers
            if ('loopback' in name or 'stereo mix' in name) and dev['max_input_channels'] > 0:
                return i
            # Windows WASAPI: look for output devices that can be opened as input
            if 'wasapi' in sd.query_hostapis(dev['hostapi'])['name'].lower():
                if dev['max_input_channels'] > 0 and 'speakers' in name:
                    return i
        return None

    def start_recording(self):
        """Start capturing mic + system audio."""
        if self.recording:
            return

        self.recording = True
        self.mic_data = []
        self.loopback_data = []

        # Mic input stream
        self.mic_stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype='float32',
            callback=self._mic_callback,
        )
        self.mic_stream.start()

        # System audio (loopback) stream
        loopback_device = self.find_loopback_device()
        if loopback_device is not None:
            try:
                self.loopback_stream = sd.InputStream(
                    device=loopback_device,
                    samplerate=SAMPLE_RATE,
                    channels=CHANNELS,
                    dtype='float32',
                    callback=self._loopback_callback,
                )
                self.loopback_stream.start()
                print(f"🔊 System audio capture active (device {loopback_device})")
            except Exception as e:
                print(f"⚠️  Could not open loopback device: {e}")
                print("   Recording mic only — system audio not captured")
                self.loopback_stream = None
        else:
            print("⚠️  No loopback device found — recording mic only")
            print("   Enable 'Stereo Mix' in Sound settings for system audio")

        self._update_icon()
        print(f"🔴 Recording started ({HOTKEY} to stop)")

    def stop_recording(self):
        """Stop recording and save mixed audio to watch directory."""
        if not self.recording:
            return

        self.recording = False

        # Stop streams
        if self.mic_stream:
            self.mic_stream.stop()
            self.mic_stream.close()
        if self.loopback_stream:
            self.loopback_stream.stop()
            self.loopback_stream.close()

        self._update_icon()

        # Mix and save
        if not self.mic_data and not self.loopback_data:
            print("⚠️  No audio recorded")
            return

        self._save_recording()

    def _mic_callback(self, indata, frames, time_info, status):
        if self.recording:
            self.mic_data.append(indata.copy())

    def _loopback_callback(self, indata, frames, time_info, status):
        if self.recording:
            self.loopback_data.append(indata.copy())

    def _save_recording(self):
        """Mix mic + loopback audio and save to watch directory."""
        Path(WATCH_DIR).mkdir(parents=True, exist_ok=True)

        # Concatenate buffers
        mic_audio = np.concatenate(self.mic_data) if self.mic_data else np.array([])
        loopback_audio = np.concatenate(self.loopback_data) if self.loopback_data else np.array([])

        # Mix: align lengths and sum
        if len(mic_audio) > 0 and len(loopback_audio) > 0:
            min_len = min(len(mic_audio), len(loopback_audio))
            mixed = mic_audio[:min_len] * 0.5 + loopback_audio[:min_len] * 0.5
        elif len(mic_audio) > 0:
            mixed = mic_audio
        else:
            mixed = loopback_audio

        # Normalize to prevent clipping
        peak = np.max(np.abs(mixed))
        if peak > 0:
            mixed = mixed / peak * 0.95

        # Generate filename: meeting-YYYY-MM-DD-HHMM.wav
        timestamp = datetime.now().strftime('%Y-%m-%d-%H%M')
        filename = f"meeting-{timestamp}.wav"
        filepath = os.path.join(WATCH_DIR, filename)

        sf.write(filepath, mixed, SAMPLE_RATE)

        duration = len(mixed) / SAMPLE_RATE
        print(f"✅ Saved {filepath} ({duration:.0f}s)")
        print(f"   File watcher will pick it up for transcription")

    def toggle_recording(self):
        """Hotkey handler: toggle recording on/off."""
        if self.recording:
            self.stop_recording()
        else:
            self.start_recording()

    # --- System Tray ---

    def _create_icon(self, color: str) -> Image.Image:
        """Create a simple circle icon for the system tray."""
        img = Image.new('RGBA', (64, 64), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        draw.ellipse([8, 8, 56, 56], fill=color)
        return img

    def _update_icon(self):
        if self.tray_icon:
            color = RECORDING_ICON_COLOR if self.recording else IDLE_ICON_COLOR
            self.tray_icon.icon = self._create_icon(color)
            self.tray_icon.title = "Mnemo: Recording..." if self.recording else "Mnemo: Ready"

    def run(self):
        """Start the system tray app."""
        # Register global hotkey
        keyboard.add_hotkey(HOTKEY, self.toggle_recording)

        # System tray icon
        menu = pystray.Menu(
            pystray.MenuItem("Start/Stop Recording", lambda: self.toggle_recording()),
            pystray.MenuItem("Quit", lambda: self._quit()),
        )

        self.tray_icon = pystray.Icon(
            "mnemo-recorder",
            self._create_icon(IDLE_ICON_COLOR),
            "Mnemo: Ready",
            menu,
        )

        print(f"🎙️  Mnemo Recorder ready — press {HOTKEY} to start/stop")
        print(f"   Recordings save to: {WATCH_DIR}")
        self.tray_icon.run()

    def _quit(self):
        if self.recording:
            self.stop_recording()
        keyboard.unhook_all()
        self.tray_icon.stop()


if __name__ == "__main__":
    recorder = MnemoRecorder()
    recorder.run()
```

#### Dependencies

Create `tools/mnemo-recorder/requirements.txt`:

```
sounddevice>=0.4.6
soundfile>=0.12.0
numpy>=1.24.0
pystray>=0.19.0
Pillow>=10.0.0
keyboard>=0.13.5
```

#### Installation & Usage

```bash
# One-time setup (run on host, not in Docker)
cd tools/mnemo-recorder
pip install -r requirements.txt

# Set watch directory (must match platform's WATCH_DIR)
export MNEMO_WATCH_DIR="./watch/incoming"

# Run
python recorder.py
# → System tray icon appears (green = ready)
# → Ctrl+Shift+R to start recording (icon turns red)
# → Ctrl+Shift+R again to stop (saves .wav to watch/incoming/)
# → File watcher picks up the .wav → Whisper transcribes → meeting pipeline
```

#### Windows System Audio Setup

To capture system audio (the other participants on a Teams call), one of these must be available:

1. **Stereo Mix** (simplest): Enable in Sound Settings → Recording → right-click → Show Disabled Devices → Enable Stereo Mix. Not all audio drivers support this.

2. **WASAPI Loopback** (reliable): `sounddevice` with WASAPI hostapi can open output devices as loopback inputs. The recorder auto-detects this.

3. **Virtual Audio Cable** (most reliable): Install [VB-CABLE](https://vb-audio.com/Cable/) or similar. Route system audio through the virtual device. The recorder captures from that device. Works with any audio driver.

The recorder attempts auto-detection in order: WASAPI loopback → Stereo Mix → mic-only fallback with a warning.

#### Whisper Considerations for Meeting Audio

- **Sample rate:** Recording at 16kHz (Whisper's native rate) avoids resampling overhead.
- **Mono mix:** Whisper processes mono; mixing stereo mic + loopback to mono before saving.
- **Duration:** faster-whisper handles long audio well, but recordings >60 minutes may benefit from chunking (the ingestion agent handles this via W22).
- **Speaker diarization:** The current Whisper pipeline doesn't distinguish speakers. For multi-speaker meetings, consider upgrading to `whisperx` (adds speaker diarization) or pairing with a VTT export for speaker attribution.

---

### Meeting Content Processor

Extend the message processor to handle meeting-specific enrichment when `rawType` is `transcript` or `audio`.

Add to `platform/src/workers/meeting-processor.ts`:

```typescript
import { IngestJobData } from '../services/ingest/types.js';

export interface MeetingMetadata {
  title: string;
  date: string;
  speakers: string[];
  actionItems: string[];
  durationEstimate?: string;
}

/**
 * Extract meeting metadata from filename and transcript content.
 */
export function extractMeetingMetadata(job: IngestJobData): Partial<MeetingMetadata> {
  const fileName = (job.metadata.fileName as string) || '';

  // Try to extract date from filename (e.g. "standup-2026-03-12.vtt")
  const dateMatch = fileName.match(/(\d{4}-\d{2}-\d{2})/);
  const date = dateMatch ? dateMatch[1] : job.createdAt.split('T')[0];

  // Title from filename (strip extension and date)
  const title = fileName
    .replace(/\.\w+$/, '')                    // Remove extension
    .replace(/\d{4}-\d{2}-\d{2}/, '')         // Remove date
    .replace(/[-_]+/g, ' ')                   // Normalize separators
    .trim() || 'Untitled Meeting';

  return { title, date };
}

/**
 * After transcript parsing, route speakers to entity extraction
 * and action items to task extraction.
 */
export async function enrichMeetingContent(
  job: IngestJobData,
  parsedTranscript: { speakers: string[]; action_items: string[] },
  queueJob: (name: string, data: unknown) => Promise<string>,
): Promise<void> {
  const meta = extractMeetingMetadata(job);

  // Queue entity extraction for each speaker
  if (parsedTranscript.speakers.length > 0) {
    await queueJob('entity-extraction', {
      memoryId: job.traceId,
      content: `Meeting participants: ${parsedTranscript.speakers.join(', ')}`,
      hint: 'person',
    });
  }

  // Queue task extraction for action items
  if (parsedTranscript.action_items.length > 0) {
    await queueJob('task-extraction', {
      memoryId: job.traceId,
      content: parsedTranscript.action_items.join('\n'),
      source: `Meeting: ${meta.title} (${meta.date})`,
    });
  }
}
```

### Message Processor Integration

In `platform/src/workers/message-processor.ts`, add meeting-specific handling:

```typescript
// After initial content is resolved (text from VTT parse or Whisper transcription)
if (platform === 'file' && (rawType === 'transcript' || rawType === 'audio')) {
  // For transcript files: call /parse-transcript to get structured data
  if (rawType === 'transcript') {
    const parsed = await mlClient.parseTranscript(content);
    await enrichMeetingContent(job, parsed, queueJob);
    // Use full_text for embedding
    textToEmbed = parsed.full_text;
  }

  // For audio files: Whisper transcription was already done by file watcher
  // The transcribed text is now in job.content
  if (rawType === 'audio') {
    // Run the transcribed text through action-item extraction
    const parsed = await mlClient.parseTranscript(content, { format: 'plain' });
    await enrichMeetingContent(job, parsed, queueJob);
    textToEmbed = content;
  }
}
```

### ML Client Extension

Add to `platform/src/services/ml.ts`:

```typescript
export async function parseTranscript(
  content: string,
  options?: { format?: string },
): Promise<{ full_text: string; speakers: string[]; action_items: string[] }> {
  const response = await fetch(`${config.ML_SERVICES_URL}/parse-transcript`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content,
      format: options?.format ?? 'vtt',
      extract_actions: true,
    }),
  });

  if (!response.ok) throw new Error(`Transcript parse failed: ${response.status}`);
  return response.json();
}
```

### Audio File Handling in File Watcher

The file watcher (W36) routes audio files to the existing `/transcribe/upload` endpoint from W10. The transcribed text becomes the `content` field of the `IngestJobData`. Update the audio handling in `FileWatcherAdapter`:

```typescript
if (AUDIO_EXTENSIONS.has(ext)) {
  // Upload to existing Whisper endpoint (W10)
  const formData = new FormData();
  const fileBuffer = await readFile(processingPath);
  formData.append('file', new Blob([fileBuffer]), fileName);

  const response = await fetch(`${config.ML_SERVICES_URL}/transcribe/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) throw new Error(`Transcription failed: ${response.status}`);
  const result = await response.json();

  content = result.text;
  rawType = 'audio';
  metadata.transcription_duration_ms = result.duration_ms;
  metadata.transcription_language = result.language;
}
```

---

## File Naming Conventions

Recommend (but don't enforce) naming conventions for meeting files:

```
# VTT from Teams export
standup-2026-03-12.vtt
project-review-2026-03-12.vtt

# Audio recordings
standup-2026-03-12.mp3
client-call-2026-03-12.m4a

# Generic pattern
<meeting-name>-<YYYY-MM-DD>.<ext>
```

The `extractMeetingMetadata()` function parses date and title from the filename.

---

## Future Enhancement: Graph API Webhooks

The current approach is file-drop only. A future enhancement could use Microsoft Graph API Change Notifications to automatically receive transcripts when Teams meetings end:

1. Register subscription: `POST /subscriptions` with resource `communications/onlineMeetings/{id}/transcripts`
2. Receive webhook when transcript is ready
3. Fetch VTT: `GET /communications/onlineMeetings/{id}/transcripts/{tid}/content?$format=text/vtt`
4. Feed into the same transcript parsing pipeline

This requires Azure AD app registration and is deferred until there's a clear need for it.

---

## Verification

### Automated Tests

```typescript
// platform/src/test/services/meeting-processor.test.ts
import { describe, it, expect } from 'vitest';
import { extractMeetingMetadata } from '../../workers/meeting-processor.js';

describe('extractMeetingMetadata', () => {
  it('should extract date from filename', () => {
    const meta = extractMeetingMetadata({
      traceId: 'test',
      platform: 'file',
      rawType: 'transcript',
      content: '',
      contentHash: '',
      metadata: { fileName: 'standup-2026-03-12.vtt' },
      createdAt: '2026-03-12T00:00:00Z',
    });
    expect(meta.date).toBe('2026-03-12');
    expect(meta.title).toBe('standup');
  });

  it('should handle missing date in filename', () => {
    const meta = extractMeetingMetadata({
      traceId: 'test',
      platform: 'file',
      rawType: 'transcript',
      content: '',
      contentHash: '',
      metadata: { fileName: 'team-sync.vtt' },
      createdAt: '2026-03-12T10:00:00Z',
    });
    expect(meta.date).toBe('2026-03-12');
    expect(meta.title).toBe('team sync');
  });
});
```

### Manual Verification

```bash
# Path 1: Live capture
cd tools/mnemo-recorder && python recorder.py
# Start a Teams call, press Ctrl+Shift+R, talk for 30s, press Ctrl+Shift+R again
# Verify: .wav appears in watch/incoming/, moves to done/ after processing

# Path 2: VTT transcript ingestion
cp teams-export.vtt ./watch/incoming/project-review-2026-03-12.vtt
# Verify: file moves to done/, entities created for speakers, tasks created from action items

# Path 3: Pre-recorded audio file
cp meeting-recording.mp3 ./watch/incoming/standup-2026-03-12.mp3
# Verify: file transcribed via Whisper, then processed as meeting content

# Check results
psql -d cognitive -c "SELECT * FROM content_hashes WHERE platform = 'file' ORDER BY created_at DESC LIMIT 5;"
```

---

## Acceptance Criteria

### Recording Client
- [ ] System tray icon shows recording state (green/red)
- [ ] Ctrl+Shift+R toggles recording on/off
- [ ] Mic audio captured via `sounddevice`
- [ ] System audio captured via WASAPI loopback (or graceful fallback to mic-only)
- [ ] Mixed audio saved as `.wav` to `MNEMO_WATCH_DIR`
- [ ] Filename includes timestamp (`meeting-YYYY-MM-DD-HHMM.wav`)
- [ ] 16kHz mono output (optimal for Whisper)

### Pipeline Integration
- [ ] VTT files detected by watcher and parsed via `/parse-transcript`
- [ ] SRT files detected and parsed
- [ ] Audio files (`.mp3`, `.wav`, `.m4a`, `.ogg`) transcribed via existing Whisper pipeline
- [ ] Speaker names from VTT `<v>` tags routed to entity extraction
- [ ] Action items extracted and routed to task extraction
- [ ] Meeting title and date extracted from filename
- [ ] Meeting metadata stored with the memory
- [ ] All three paths (live capture, VTT, audio drop) produce searchable memories in Qdrant

---

## Next Packet

- [W39: Obsidian Read Adapter](./W39-obsidian-read.md) — Another source adapter
