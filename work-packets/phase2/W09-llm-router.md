# Work Packet W09: LLM Router

**Status:** Ready to Implement  
**Dependencies:** W08 (Skill Framework)  
**Estimated Time:** 2-3 hours

---

## Objective

Replace the simple keyword-based `classifySimple()` function with an LLM-powered intent router that accurately classifies messages and routes them to appropriate workflows.

---

## Background

### Current State
In `message-processor.ts`, we have a basic classifier:

```typescript
function classifySimple(text: string): string {
  const lowerText = text.toLowerCase();
  
  if (lowerText.includes('http://') || lowerText.includes('https://')) {
    return 'link';
  }
  if (lowerText.includes('remind') || lowerText.includes('todo')) {
    return 'task';
  }
  if (text.endsWith('?')) {
    return 'question';
  }
  return 'thought';
}
```

**Problems:**
- Misses nuanced intents ("check out this article" is a link without URL)
- Can't detect multiple intents ("remind me to read this article")
- No confidence scoring
- Hardcoded rules don't scale

### Target State
LLM-based classification that:
- Detects multiple intents with confidence scores
- Suggests appropriate workflow
- Handles nuanced language
- Returns structured JSON

---

## Architecture

### Classification Flow

```
Message Text
     ↓
[ML Service] /classify endpoint
     ↓
LLM (llama3.2:3b) with structured prompt
     ↓
Parse JSON response
     ↓
Return ClassificationResult
```

### Response Schema

```typescript
interface ClassificationResult {
  intents: Array<{
    type: IntentType;
    confidence: number;  // 0.0 - 1.0
  }>;
  primary_intent: IntentType;
  suggested_workflow: string;
  reasoning?: string;
}

type IntentType = 
  | 'thought'    // General reflection, idea, note
  | 'link'       // Contains or references a URL
  | 'task'       // Action with deadline
  | 'question'   // Seeking information
  | 'search'     // Searching memories
  | 'command';   // Bot command
```

---

## Step 1: Create Python Classify Endpoint

Create `ml-services/app/classify.py`:

```python
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import ollama
import json
import re

router = APIRouter()

# Intent categories with descriptions
INTENT_CATEGORIES = """
- thought: A general idea, reflection, observation, or note to remember
- link: Contains a URL or references an article/video/website to save
- task: Something to do, with or without a deadline (remind, todo, need to, don't forget)
- question: Asking for information or seeking answers
- search: Wants to find something in their memory/knowledge base
- command: A direct bot command (starts with /)
"""

CLASSIFICATION_PROMPT = """You are a message intent classifier. Analyze the following message and determine the user's intent(s).

Categories:
{categories}

Message: "{message}"

Rules:
1. A message can have multiple intents (e.g., "remind me to read this link" = task + link)
2. Assign confidence scores (0.0 to 1.0) based on how clear the intent is
3. The primary_intent is the most actionable intent
4. suggested_workflow should be: process-thought, process-link, process-task, process-question, or search

Return ONLY valid JSON in this exact format:
{{
  "intents": [
    {{"type": "thought", "confidence": 0.8}},
    {{"type": "link", "confidence": 0.3}}
  ],
  "primary_intent": "thought",
  "suggested_workflow": "process-thought",
  "reasoning": "Brief explanation"
}}"""


class ClassifyRequest(BaseModel):
    """Request body for classification"""
    text: str
    include_reasoning: bool = False


class Intent(BaseModel):
    """Single intent with confidence"""
    type: str
    confidence: float


class ClassifyResponse(BaseModel):
    """Classification result"""
    intents: List[Intent]
    primary_intent: str
    suggested_workflow: str
    reasoning: Optional[str] = None


def extract_json(text: str) -> dict:
    """Extract JSON from LLM response"""
    # Try to find JSON in the response
    json_match = re.search(r'\{[\s\S]*\}', text)
    if json_match:
        try:
            return json.loads(json_match.group())
        except json.JSONDecodeError:
            pass
    
    # Fallback: try the whole response
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise ValueError(f"Could not parse JSON from: {text[:200]}")


def validate_classification(data: dict) -> ClassifyResponse:
    """Validate and normalize classification result"""
    valid_intents = {'thought', 'link', 'task', 'question', 'search', 'command'}
    valid_workflows = {
        'process-thought', 'process-link', 'process-task', 
        'process-question', 'search'
    }
    
    # Validate intents
    intents = []
    for intent in data.get('intents', []):
        if intent.get('type') in valid_intents:
            intents.append(Intent(
                type=intent['type'],
                confidence=min(1.0, max(0.0, float(intent.get('confidence', 0.5))))
            ))
    
    # Fallback if no valid intents
    if not intents:
        intents = [Intent(type='thought', confidence=0.5)]
    
    # Sort by confidence
    intents.sort(key=lambda x: x.confidence, reverse=True)
    
    # Determine primary intent
    primary = data.get('primary_intent', intents[0].type)
    if primary not in valid_intents:
        primary = intents[0].type
    
    # Determine workflow
    workflow = data.get('suggested_workflow', f'process-{primary}')
    if workflow not in valid_workflows:
        workflow = f'process-{primary}' if primary != 'search' else 'search'
    
    return ClassifyResponse(
        intents=intents,
        primary_intent=primary,
        suggested_workflow=workflow,
        reasoning=data.get('reasoning')
    )


@router.post("/classify", response_model=ClassifyResponse)
async def classify_message(request: ClassifyRequest):
    """
    Classify message intent using LLM.
    
    Uses llama3.2:3b for fast classification (~1s latency).
    Returns structured intent data with confidence scores.
    """
    try:
        # Build prompt
        prompt = CLASSIFICATION_PROMPT.format(
            categories=INTENT_CATEGORIES,
            message=request.text
        )
        
        # Call Ollama
        response = ollama.generate(
            model="llama3.2:3b",  # Fast model for routing
            prompt=prompt,
            options={
                "temperature": 0.1,  # Low temperature for consistency
                "num_predict": 256,  # Limit output
            }
        )
        
        # Parse response
        result_text = response['response']
        result_json = extract_json(result_text)
        
        # Validate and normalize
        classification = validate_classification(result_json)
        
        # Strip reasoning if not requested
        if not request.include_reasoning:
            classification.reasoning = None
        
        return classification
        
    except ollama.ResponseError as e:
        raise HTTPException(
            status_code=503,
            detail=f"LLM service unavailable: {str(e)}"
        )
    except ValueError as e:
        # JSON parsing failed, return safe default
        return ClassifyResponse(
            intents=[Intent(type='thought', confidence=0.5)],
            primary_intent='thought',
            suggested_workflow='process-thought',
            reasoning=f"Classification parsing failed, defaulting to thought"
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Classification failed: {str(e)}"
        )


@router.get("/classify/test")
async def test_classification():
    """Test classification with sample messages"""
    samples = [
        "I've been thinking about how to improve the onboarding flow",
        "Check out this article https://example.com/article",
        "Remind me to call John tomorrow at 3pm",
        "How does the authentication system work?",
        "Find my notes about Kubernetes",
    ]
    
    results = []
    for sample in samples:
        try:
            result = await classify_message(ClassifyRequest(text=sample, include_reasoning=True))
            results.append({
                "message": sample,
                "primary": result.primary_intent,
                "workflow": result.suggested_workflow,
                "intents": [i.dict() for i in result.intents]
            })
        except Exception as e:
            results.append({
                "message": sample,
                "error": str(e)
            })
    
    return {"test_results": results}
```

---

## Step 2: Register Router in FastAPI

Update `ml-services/app/main.py`:

```python
from fastapi import FastAPI
from app.embed import router as embed_router
from app.transcribe import router as transcribe_router
from app.classify import router as classify_router  # Add this

app = FastAPI(
    title="Cognitive ML Services",
    description="ML endpoints for the Cognitive Platform",
    version="2.0.0"  # Bump version
)

app.include_router(embed_router)
app.include_router(transcribe_router)
app.include_router(classify_router)  # Add this

@app.get("/health")
def health():
    return {
        "status": "ok",
        "services": ["embed", "transcribe", "classify"]  # Update list
    }
```

---

## Step 3: Create TypeScript Classification Service

Create `platform/src/services/classify.ts`:

```typescript
import { config } from '../config.js';

export interface Intent {
  type: 'thought' | 'link' | 'task' | 'question' | 'search' | 'command';
  confidence: number;
}

export interface ClassificationResult {
  intents: Intent[];
  primary_intent: Intent['type'];
  suggested_workflow: string;
  reasoning?: string;
}

/**
 * Classify message intent using LLM
 */
export async function classify(
  text: string,
  includeReasoning = false
): Promise<ClassificationResult> {
  const response = await fetch(`${config.ML_SERVICES_URL}/classify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      text, 
      include_reasoning: includeReasoning 
    }),
  });

  if (!response.ok) {
    // Fallback on error
    console.warn(`Classification failed: ${response.statusText}`);
    return {
      intents: [{ type: 'thought', confidence: 0.5 }],
      primary_intent: 'thought',
      suggested_workflow: 'process-thought',
    };
  }

  return response.json() as Promise<ClassificationResult>;
}

/**
 * Check if classification service is available
 */
export async function checkClassifyHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${config.ML_SERVICES_URL}/classify/test`);
    return response.ok;
  } catch {
    return false;
  }
}
```

---

## Step 4: Create Router Skill

Create `platform/src/skills/core/classify.skill.ts`:

```typescript
import type { Skill, SkillContext } from '../types.js';
import { classify, ClassificationResult } from '../../services/classify.js';

export interface ClassifyInput {
  text: string;
  include_reasoning?: boolean;
}

export type ClassifyOutput = ClassificationResult;

export const classifySkill: Skill<ClassifyInput, ClassifyOutput> = {
  name: 'classify',
  description: 'Classify message intent using LLM router',
  version: '1.0.0',

  async execute(input: ClassifyInput, context: SkillContext): Promise<ClassifyOutput> {
    context.log(`Classifying: "${input.text.slice(0, 50)}..."`);
    
    const result = await classify(input.text, input.include_reasoning);
    
    const intentsStr = result.intents
      .map(i => `${i.type}(${(i.confidence * 100).toFixed(0)}%)`)
      .join(', ');
    
    context.log(`Classified: [${intentsStr}] → ${result.suggested_workflow}`);
    
    return result;
  },
};
```

---

## Step 5: Register Classify Skill

Update `platform/src/skills/index.ts`:

```typescript
// Add import
import { classifySkill } from './core/classify.skill.js';

// Update registerCoreSkills
export function registerCoreSkills(): void {
  registry.register(embedSkill);
  registry.register(storeMemorySkill);
  registry.register(transcribeSkill);
  registry.register(classifySkill);  // Add this
  
  console.log('✅ Core skills registered');
  console.log(`   Available: ${registry.list().map(s => s.name).join(', ')}`);
}

// Export
export { embedSkill, storeMemorySkill, transcribeSkill, classifySkill };
```

---

## Step 6: Update Message Processor

Update `platform/src/workers/message-processor.ts`:

```typescript
import { classify } from '../services/classify.js';
import { addEnrichment } from '../core/envelope-factory.js';

// In processMessage function, replace classifySimple with:

// Classify intent using LLM
console.log('🤖 Classifying intent...');
const classifyStart = Date.now();
const classification = await classify(textToEmbed);

addEnrichment(envelope, 'classify', {
  intents: classification.intents,
  primary_intent: classification.primary_intent,
}, classifyStart);

// Add intents to routing
envelope.routing.intents = classification.intents.map(i => i.type);
envelope.routing.workflows = [classification.suggested_workflow];

console.log(`✅ Classified as: ${classification.primary_intent}`);

// Use primary intent for memory type
const memoryType = classification.primary_intent;
```

---

## Step 7: Install Ollama Python Package

Update `ml-services/requirements.txt`:

```
fastapi==0.109.0
uvicorn==0.27.0
httpx==0.25.2
python-multipart==0.0.6
pydantic==2.5.3
ollama>=0.1.6  # Ensure this is present
```

---

## Testing

### Test Classification Endpoint

```bash
# Test the classification endpoint directly
curl -X POST http://localhost:8000/classify \
  -H "Content-Type: application/json" \
  -d '{"text": "Check out this article about AI", "include_reasoning": true}'

# Expected response:
{
  "intents": [
    {"type": "link", "confidence": 0.9},
    {"type": "thought", "confidence": 0.4}
  ],
  "primary_intent": "link",
  "suggested_workflow": "process-link",
  "reasoning": "Message suggests saving an article about AI..."
}
```

### Test Sample Messages

```bash
# Run the built-in test endpoint
curl http://localhost:8000/classify/test | jq .
```

---

## Acceptance Criteria

- [ ] `ml-services/app/classify.py` exists and runs
- [ ] `/classify` endpoint returns valid JSON
- [ ] `/classify/test` shows correct classifications
- [ ] `platform/src/services/classify.ts` compiles
- [ ] `platform/src/skills/core/classify.skill.ts` exists
- [ ] Skill is registered on startup
- [ ] Message processor uses LLM classification
- [ ] Envelope routing contains intents
- [ ] Classification accuracy >90% on sample messages
- [ ] Latency <2s for classification

---

## Performance Considerations

- **Model**: `llama3.2:3b` is chosen for speed (~1s)
- **Temperature**: 0.1 for consistent results
- **Token limit**: 256 to prevent long responses
- **Fallback**: Returns `thought` if classification fails

---

## Next Packet

After completing W09, proceed to:
- [W12: Task Extraction](./W12-task-extraction.md) - Uses classification
- [W11: Link Processing](./W11-link-processing.md) - Routes based on intent
