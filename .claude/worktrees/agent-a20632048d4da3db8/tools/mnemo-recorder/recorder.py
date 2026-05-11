#!/usr/bin/env python3
"""
Mnemo Meeting Recorder (W38)

CLI tool that records system audio, saves to a file,
and sends to the Mnemo ingest API for processing.

Usage:
  python recorder.py --duration 3600 --api-url http://localhost:3001 --api-key <key>
"""

import argparse
import json
import sys
import time
from pathlib import Path
from datetime import datetime

try:
    import httpx
except ImportError:
    print("Install httpx: pip install httpx")
    sys.exit(1)


def record_meeting(duration: int, output_path: str) -> str:
    """
    Record audio for the specified duration.
    Returns path to the recorded file.

    NOTE: Actual audio recording requires platform-specific libraries
    (e.g., sounddevice, pyaudio). This is a placeholder that creates
    a marker file. Real implementation would use sounddevice.
    """
    print(f"🎙️ Recording for {duration}s → {output_path}")

    # Placeholder: In production, use sounddevice or similar
    # import sounddevice as sd
    # import soundfile as sf
    # audio = sd.rec(int(duration * 16000), samplerate=16000, channels=1)
    # sd.wait()
    # sf.write(output_path, audio, 16000)

    Path(output_path).write_text(f"[Recording placeholder - {duration}s at {datetime.now().isoformat()}]")
    print(f"✅ Recording saved to {output_path}")
    return output_path


def send_to_mnemo(
    transcript_path: str,
    api_url: str,
    api_key: str,
    title: str | None = None,
    participants: list[str] | None = None,
) -> dict:
    """Send a transcript to the Mnemo ingest API."""
    content = Path(transcript_path).read_text()

    payload = {
        "content": content,
        "contentType": "meeting",
        "source": "mnemo-recorder",
        "metadata": {
            "title": title or f"Meeting {datetime.now().strftime('%Y-%m-%d %H:%M')}",
            "participants": participants or [],
            "recorded_at": datetime.now().isoformat(),
        },
    }

    response = httpx.post(
        f"{api_url}/api/ingest",
        json=payload,
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=60.0,
    )
    response.raise_for_status()
    return response.json()


def main():
    parser = argparse.ArgumentParser(description="Mnemo Meeting Recorder")
    parser.add_argument("--duration", type=int, default=3600, help="Recording duration in seconds")
    parser.add_argument("--output", type=str, default=None, help="Output file path")
    parser.add_argument("--api-url", type=str, default="http://localhost:3001", help="Mnemo API URL")
    parser.add_argument("--api-key", type=str, required=True, help="Mnemo API key")
    parser.add_argument("--title", type=str, default=None, help="Meeting title")
    parser.add_argument("--participants", type=str, nargs="*", default=[], help="Participant names")
    parser.add_argument("--transcript", type=str, default=None, help="Path to existing transcript (skip recording)")

    args = parser.parse_args()

    if args.transcript:
        # Use existing transcript
        transcript_path = args.transcript
    else:
        # Record audio
        output = args.output or f"meeting_{datetime.now().strftime('%Y%m%d_%H%M%S')}.wav"
        record_meeting(args.duration, output)
        # In production, transcription would happen server-side
        transcript_path = output

    # Send to Mnemo
    print("📤 Sending to Mnemo...")
    result = send_to_mnemo(
        transcript_path,
        args.api_url,
        args.api_key,
        title=args.title,
        participants=args.participants,
    )
    print(f"✅ Result: {json.dumps(result, indent=2)}")


if __name__ == "__main__":
    main()
