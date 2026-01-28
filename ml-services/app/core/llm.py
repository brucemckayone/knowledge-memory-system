"""
Core LLM Service
Standardizes Z.AI GLM-4.7 interactions, JSON extraction, and error handling.
"""

import json
import re
import os
from typing import Optional, Dict, Any, Type, TypeVar
from pydantic import BaseModel
from openai import OpenAI
from fastapi import HTTPException

T = TypeVar("T", bound=BaseModel)

class LLMService:
    def __init__(self, model: str = "glm-4.7"):
        self.model = model
        api_key = os.getenv("ZAI_API_KEY")
        if not api_key:
            raise ValueError("ZAI_API_KEY environment variable is required")

        # Z.AI coding plan uses a different base URL
        self.client = OpenAI(
            api_key=api_key,
            base_url="https://api.z.ai/api/coding/paas/v4"
        )

    def generate(
        self,
        prompt: str,
        options: Optional[Dict[str, Any]] = None
    ) -> str:
        """
        Generate text response from LLM using Z.AI's chat completions API.
        """
        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": "You are a helpful AI assistant."},
                    {"role": "user", "content": prompt}
                ],
                temperature=options.get("temperature", 0.1) if options else 0.1,
                max_tokens=options.get("num_predict", 512) if options else 512,
            )
            return response.choices[0].message.content
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
