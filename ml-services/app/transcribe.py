import os
import tempfile
from typing import Optional
from fastapi import APIRouter, HTTPException, UploadFile, File
from pydantic import BaseModel
import httpx

router = APIRouter()

# Whisper model is optional - will be loaded on first use if available
_whisper_model = None
_whisper_available = None


def check_whisper_available():
    """Check if whisper is available"""
    global _whisper_available
    if _whisper_available is None:
        try:
            from faster_whisper import WhisperModel
            _whisper_available = True
        except ImportError:
            _whisper_available = False
    return _whisper_available


def get_whisper_model():
    """Lazy load the Whisper model"""
    global _whisper_model
    if not check_whisper_available():
        raise HTTPException(
            status_code=503,
            detail="Whisper transcription not available. Install faster-whisper to enable."
        )
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        _whisper_model = WhisperModel(
            "small",
            device="cpu",
            compute_type="int8"
        )
        print("✅ Whisper model loaded")
    return _whisper_model


class TranscribeUrlRequest(BaseModel):
    """Request body for URL-based transcription"""
    audio_url: str
    language: Optional[str] = None


class TranscribeResponse(BaseModel):
    """Response body with transcription"""
    text: str
    language: str
    duration_ms: int
    segments: Optional[list] = None


@router.get("/transcribe/status")
def transcribe_status():
    """Check if transcription is available"""
    return {
        "available": check_whisper_available(),
        "message": "Whisper transcription available" if check_whisper_available() else "Install faster-whisper to enable transcription"
    }


@router.post("/transcribe", response_model=TranscribeResponse)
async def transcribe_url(request: TranscribeUrlRequest):
    """
    Transcribe audio from URL.
    
    Downloads the audio file and transcribes using faster-whisper.
    Supports: mp3, wav, ogg, m4a, webm
    """
    try:
        # Download audio file
        async with httpx.AsyncClient() as client:
            response = await client.get(request.audio_url, follow_redirects=True)
            response.raise_for_status()
            audio_data = response.content
        
        # Save to temp file
        with tempfile.NamedTemporaryFile(suffix=".ogg", delete=False) as f:
            f.write(audio_data)
            temp_path = f.name
        
        try:
            # Transcribe
            model = get_whisper_model()
            segments, info = model.transcribe(
                temp_path,
                language=request.language,
                beam_size=5,
                vad_filter=True
            )
            
            # Collect results
            text_parts = []
            segment_list = []
            
            for segment in segments:
                text_parts.append(segment.text)
                segment_list.append({
                    "start": segment.start,
                    "end": segment.end,
                    "text": segment.text.strip()
                })
            
            full_text = " ".join(text_parts).strip()
            duration_ms = int(info.duration * 1000)
            
            return TranscribeResponse(
                text=full_text,
                language=info.language,
                duration_ms=duration_ms,
                segments=segment_list
            )
            
        finally:
            os.unlink(temp_path)
            
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to download audio: {str(e)}"
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Transcription failed: {str(e)}"
        )


@router.post("/transcribe/upload", response_model=TranscribeResponse)
async def transcribe_upload(file: UploadFile = File(...)):
    """
    Transcribe uploaded audio file.
    
    Supports: mp3, wav, ogg, m4a, webm
    """
    try:
        ext = os.path.splitext(file.filename or "audio.ogg")[1]
        
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as f:
            content = await file.read()
            f.write(content)
            temp_path = f.name
        
        try:
            model = get_whisper_model()
            segments, info = model.transcribe(
                temp_path,
                beam_size=5,
                vad_filter=True
            )
            
            text_parts = []
            for segment in segments:
                text_parts.append(segment.text)
            
            full_text = " ".join(text_parts).strip()
            duration_ms = int(info.duration * 1000)
            
            return TranscribeResponse(
                text=full_text,
                language=info.language,
                duration_ms=duration_ms
            )
            
        finally:
            os.unlink(temp_path)
            
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Transcription failed: {str(e)}"
        )
