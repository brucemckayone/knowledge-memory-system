"""
Core LLM Service
Standardizes Ollama interactions, JSON extraction, and error handling.
"""

import json
import re
from typing import Optional, Dict, Any, Type, TypeVar
from pydantic import BaseModel
import ollama
from fastapi import HTTPException

T = TypeVar("T", bound=BaseModel)

class LLMService:
    def __init__(self, model: str = "llama3.2:3b"):
        self.model = model
        self.client = ollama.Client()

    def generate(
        self,
        prompt: str,
        options: Optional[Dict[str, Any]] = None
    ) -> str:
        """
        Generate text response from LLM.
        """
        try:
            response = self.client.generate(
                model=self.model,
                prompt=prompt,
                options=options or {
                    "temperature": 0.1,
                    "num_predict": 512,
                }
            )
            return response['response']
        except ollama.ResponseError as e:
            raise HTTPException(
                status_code=503,
                detail=f"LLM service unavailable: {str(e)}"
            )
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"LLM generation failed: {str(e)}"
            )

    def extract_json(self, text: str) -> Dict[str, Any]:
        """
        Extract and parse JSON from text.
        """
        # Try to find JSON block
        match = re.search(r'\{[\s\S]*\}|\[[\s\S]*\]', text)
        json_str = match.group() if match else text

        try:
            return json.loads(json_str)
        except json.JSONDecodeError:
            # Try a bit harder to fix common issues if needed, or fail
            # For now, simplistic fallback
            try:
                # Sometimes LLMs wrap in code blocks ```json ... ```
                # regex above handles inner content but if it failed to parse...
                pass 
            except:
                pass
            raise ValueError(f"Could not parse JSON from response: {text[:100]}...")

    def generate_json(
        self,
        prompt: str,
        response_model: Optional[Type[T]] = None,
        options: Optional[Dict[str, Any]] = None
    ) -> Any:
        """
        Generate and parse JSON response.
        If response_model is provided, validates and returns Pydantic object.
        Otherwise returns dict/list.
        """
        text = self.generate(prompt, options)
        
        try:
            data = self.extract_json(text)
            
            if response_model:
                try:
                    # Handle if data is list but model expects object or vice-versa
                    # Usually specific endpoint logic handles this, but here we assume direct mapping
                    return response_model.model_validate(data)
                except Exception as e:
                    # Provide raw data if validation fails so caller can handle or debug
                    raise ValueError(f"Schema validation failed: {str(e)}")
            
            return data

        except ValueError as e:
            # Allow fallback handling by caller by re-raising with context
            raise ValueError(f"JSON parsing failed: {str(e)}")

# Singleton instance for default model
llm_client = LLMService()
