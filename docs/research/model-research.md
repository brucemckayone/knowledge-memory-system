# Model Research & Recommendations

**Status:** ✅ Phase 0 Complete  
**Purpose:** Select optimal models for Cognitive Platform on M1 Mac  
**Last Updated:** 2026-01-24

---

## Implementation Status

| Model | Status | Notes |
|-------|--------|-------|
| nomic-embed-text (Embeddings) | ✅ Working | 768-dim via Ollama |
| llama3 (Summarization) | ⏸️ Deferred | Phase 2 |
| faster-whisper (Transcription) | ❌ Blocked | Build issues |
| llava (Vision) | ⏸️ Deferred | Phase 2 |

---

## Current Installed Models

```
NAME                       SIZE      STATUS
llava:latest               4.7 GB    (Vision LLM) - Not used yet
nomic-embed-text:latest    274 MB    (Embeddings) ✅ ACTIVE
llama3:latest              4.7 GB    (Text LLM) - Not used yet
```

---

## 1. Embedding Models

### Requirements
- **Quality:** Good semantic similarity for memory retrieval
- **Speed:** Fast enough for real-time processing
- **Size:** Reasonable for M1 Mac (8-16GB RAM typical)
- **Dimensions:** Affects storage and search speed in Qdrant

### Options Analysis

| Model | Dimensions | Size | Quality (MTEB) | Speed | Notes |
|-------|------------|------|----------------|-------|-------|
| **nomic-embed-text** ✅ | 768 | 274MB | 62.4% | Fast | **Already installed**, excellent quality/size ratio |
| mxbai-embed-large | 1024 | 670MB | 64.7% | Medium | Slightly better quality, larger vectors |
| all-MiniLM-L6-v2 | 384 | 80MB | 56.3% | Very Fast | Fastest, lower quality |
| bge-small-en-v1.5 | 384 | 130MB | 62.2% | Fast | Good budget option |
| snowflake-arctic-embed-m | 768 | 436MB | 63.8% | Medium | Strong retrieval focus |

### Recommendation: **nomic-embed-text** (Already Installed)

**Why:**
- ✅ Already installed and tested
- ✅ 768 dimensions is a good balance (not too small, not too large)
- ✅ 274MB is lightweight for M1
- ✅ Ranked highly on MTEB benchmark for retrieval
- ✅ Native Ollama support

**Qdrant Consideration:** 768-dim vectors × 100K memories ≈ 300MB vector storage. Very manageable.

---

## 2. LLM for Classification (Router)

### Requirements
- **Speed:** Must be fast (<2s response time)
- **Accuracy:** Classify intents correctly 90%+
- **Size:** Smaller is better for router duties
- **Structured output:** Reliable JSON generation

### Options Analysis

| Model | Size | Speed (M1) | Quality | Structured Output | Notes |
|-------|------|------------|---------|-------------------|-------|
| **llama3.2:3b** | 2.0GB | ~1s | Good | Good | Best speed/quality for routing |
| llama3:8b ✅ | 4.7GB | ~3s | Better | Good | Already installed, a bit slow for routing |
| mistral:7b | 4.1GB | ~2.5s | Good | Good | Solid alternative |
| phi3:mini | 2.3GB | ~1.5s | Good | Medium | Fast, but less reliable JSON |
| gemma2:2b | 1.6GB | ~1s | Medium | Medium | Very fast, okay quality |

### Recommendation: **llama3.2:3b** (Need to Install)

**Why:**
- Optimized for speed while maintaining quality
- Small enough for M1 to run quickly
- Good at following instructions for JSON output
- 3B parameters is ideal for classification tasks

**Install command:**
```bash
ollama pull llama3.2:3b
```

**Alternative:** Use your existing `llama3:latest` (8b) if you prefer quality over speed. For MVP, the 3s latency is acceptable.

---

## 3. LLM for Summarization & Task Extraction

### Requirements
- **Context length:** Handle long web articles (8K+ tokens)
- **Quality:** Generate coherent, useful summaries
- **Instruction following:** Extract structured data (dates, actions)

### Options Analysis

| Model | Context | Size | Summary Quality | Date Parsing | Notes |
|-------|---------|------|-----------------|--------------|-------|
| **llama3:8b** ✅ | 8K | 4.7GB | Excellent | Good | Already installed |
| llama3.1:8b | 128K | 4.7GB | Excellent | Good | Longer context window |
| llama3.2:3b | 128K | 2.0GB | Good | Good | Faster, slightly lower quality |
| mistral:7b | 32K | 4.1GB | Good | Good | Alternative option |
| qwen2:7b | 32K | 4.4GB | Good | Excellent | Strong for structured extraction |

### Recommendation: **llama3:latest** (Already Installed)

**Why:**
- ✅ Already installed
- ✅ Excellent summarization quality
- ✅ Good date/time understanding
- ✅ 8K context handles most articles

**Optional upgrade:** Install `llama3.1:8b` for 128K context if you process very long documents.

---

## 4. Vision Model (Image Processing)

### Requirements
- **OCR capability:** Read text from screenshots
- **Scene understanding:** Describe images for search
- **M1 compatible:** Reasonable performance

### Options Analysis

| Model | Size | OCR Quality | Description Quality | Speed | Notes |
|-------|------|-------------|---------------------|-------|-------|
| **llava:latest** ✅ | 4.7GB | Good | Good | ~5s | Already installed |
| llava:13b | 8GB | Better | Better | ~10s | Higher quality, slower |
| bakllava | 4.7GB | Good | Good | ~5s | Similar to llava |
| moondream2 | 1.7GB | Medium | Medium | ~2s | Fast, lightweight |

### Recommendation: **llava:latest** (Already Installed)

**Why:**
- ✅ Already installed
- ✅ Good balance of quality and speed
- ✅ Handles OCR and scene description
- ✅ Based on Llama architecture

---

## 5. Transcription (Whisper)

### Requirements
- **Accuracy:** Handle accents, background noise
- **Speed:** Transcribe 1-minute voice note in <30s
- **Languages:** English primary, multilingual nice-to-have

### Options Analysis

| Model | Size | Speed (M1) | Accuracy | Languages | Notes |
|-------|------|------------|----------|-----------|-------|
| whisper-tiny | 39MB | ~10x realtime | 72% | Multi | Fast but lower accuracy |
| **whisper-small** | 244MB | ~4x realtime | 75% | Multi | **Best balance** |
| whisper-medium | 769MB | ~1x realtime | 78% | Multi | Near real-time, high quality |
| whisper-large-v3 | 1.5GB | ~0.5x realtime | 80% | Multi | Highest accuracy, slow |

### Implementation Options

**Option A: faster-whisper (Recommended)**
```python
# Python - faster-whisper with CTranslate2
from faster_whisper import WhisperModel

model = WhisperModel("small", device="cpu", compute_type="int8")
segments, info = model.transcribe("audio.mp3")
```
- 4x faster than OpenAI whisper
- Optimized for CPU (M1 compatible)
- Lower memory footprint

**Option B: whisper.cpp**
```bash
# Native C++ - even faster on Mac
./main -m models/ggml-small.bin -f audio.wav
```
- Fastest on Mac (uses Metal acceleration)
- Slightly more complex setup

### Recommendation: **faster-whisper with "small" model**

**Why:**
- ~4x realtime speed (15s audio → ~4s transcription)
- Good accuracy for conversational speech
- 244MB is lightweight
- Easy Python integration

---

## 6. Final Model Stack

| Use Case | Model | Size | Status |
|----------|-------|------|--------|
| **Embeddings** | nomic-embed-text | 274MB | ✅ Installed |
| **Router/Classification** | llama3.2:3b | 2.0GB | ⬇️ Need to install |
| **Summarization** | llama3:8b | 4.7GB | ✅ Installed |
| **Vision/OCR** | llava | 4.7GB | ✅ Installed |
| **Transcription** | faster-whisper small | 244MB | ⬇️ Python install |

**Total additional downloads:** ~2.2GB

---

## 7. Installation Commands

```bash
# Install router model
ollama pull llama3.2:3b

# Install Python whisper (in ml-services)
pip install faster-whisper
```

---

## 8. Benchmarking Plan

Before finalizing, we should test:

### 8.1 Embedding Quality Test
```python
# Test semantic similarity
texts = [
    "Kubernetes deployment strategies",
    "Container orchestration in k8s",
    "Making a chocolate cake",
]
# Embed and check cosine similarity
# k8s texts should be >0.8, cake should be <0.3
```

### 8.2 Router Accuracy Test
```python
# Test classification
test_cases = [
    ("Check out this link https://example.com", "link"),
    ("Remind me to call Bob tomorrow", "task"),
    ("I've been thinking about event sourcing", "thought"),
    ("How does CRDT work?", "question"),
]
# Target: 90%+ accuracy
```

### 8.3 Transcription Speed Test
```python
# Time transcription of 60s audio
# Target: <15s on M1
```

---

## 9. Next Steps

1. **Install llama3.2:3b** for routing
2. **Set up faster-whisper** in Python services
3. **Run benchmarks** to validate choices
4. **Document any issues** and adjust

---

## 10. Memory Budget (M1 8GB RAM)

| Component | Memory |
|-----------|--------|
| nomic-embed-text | ~500MB loaded |
| llama3.2:3b | ~2GB loaded |
| llama3:8b | ~5GB loaded |
| faster-whisper small | ~1GB loaded |

**Strategy:** Only load models when needed. Ollama manages this automatically.

---

*These recommendations are based on the M1 Mac constraints. If you upgrade to M2/M3 Pro with more RAM, consider larger models for better quality.*
