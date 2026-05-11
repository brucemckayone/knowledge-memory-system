"""
Document Parsing Endpoint (W37)

Extracts text and metadata from PDF and DOCX files.
Supports chunking for large documents.
"""

from fastapi import APIRouter, UploadFile, File, HTTPException
from pydantic import BaseModel
from typing import Optional, List
import io
import re

router = APIRouter()


class DocumentSection(BaseModel):
    heading: Optional[str] = None
    content: str
    page: Optional[int] = None


class ParseDocumentResponse(BaseModel):
    title: str
    sections: List[DocumentSection]
    word_count: int
    page_count: int
    format: str
    metadata: dict


def parse_pdf(data: bytes) -> ParseDocumentResponse:
    """Parse PDF document using pymupdf."""
    try:
        import pymupdf
    except ImportError:
        raise HTTPException(status_code=501, detail="pymupdf not installed")

    doc = pymupdf.open(stream=data, filetype="pdf")
    sections: List[DocumentSection] = []
    metadata = dict(doc.metadata) if doc.metadata else {}
    title = metadata.get("title", "") or ""
    all_text: List[str] = []

    for page_num in range(len(doc)):
        page = doc.load_page(page_num)
        text = page.get_text("text")
        if text.strip():
            sections.append(DocumentSection(
                content=text.strip(),
                page=page_num + 1,
            ))
            all_text.append(text)

    # Try to extract title from first page if metadata is empty
    if not title and sections:
        first_lines = sections[0].content.split('\n')
        title = first_lines[0][:200] if first_lines else "Untitled"

    full_text = '\n'.join(all_text)
    word_count = len(full_text.split())

    doc.close()

    return ParseDocumentResponse(
        title=title,
        sections=sections,
        word_count=word_count,
        page_count=len(doc) if hasattr(doc, '__len__') else len(sections),
        format="pdf",
        metadata=metadata,
    )


def parse_docx(data: bytes) -> ParseDocumentResponse:
    """Parse DOCX document using python-docx."""
    try:
        import docx
    except ImportError:
        raise HTTPException(status_code=501, detail="python-docx not installed")

    doc = docx.Document(io.BytesIO(data))
    sections: List[DocumentSection] = []
    current_heading: Optional[str] = None
    current_content: List[str] = []
    title = ""

    for para in doc.paragraphs:
        text = para.text.strip()
        if not text:
            continue

        if para.style.name.startswith('Heading'):
            # Save previous section
            if current_content:
                sections.append(DocumentSection(
                    heading=current_heading,
                    content='\n'.join(current_content),
                ))
                current_content = []

            current_heading = text
            if not title:
                title = text
        else:
            current_content.append(text)

    # Save last section
    if current_content:
        sections.append(DocumentSection(
            heading=current_heading,
            content='\n'.join(current_content),
        ))

    if not title and sections:
        title = sections[0].content[:200]

    full_text = '\n'.join(s.content for s in sections)
    word_count = len(full_text.split())

    # Extract core properties
    metadata = {}
    if doc.core_properties:
        props = doc.core_properties
        if props.author:
            metadata["author"] = props.author
        if props.created:
            metadata["created"] = str(props.created)

    return ParseDocumentResponse(
        title=title or "Untitled",
        sections=sections,
        word_count=word_count,
        page_count=len(sections),
        format="docx",
        metadata=metadata,
    )


@router.post("/parse-document", response_model=ParseDocumentResponse)
async def parse_document(file: UploadFile = File(...)):
    """
    Parse a PDF or DOCX document into structured sections.

    Accepts file upload; returns extracted text, sections, and metadata.
    """
    data = await file.read()
    filename = file.filename or ""

    if filename.endswith('.pdf') or file.content_type == 'application/pdf':
        return parse_pdf(data)
    elif filename.endswith('.docx') or file.content_type == 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        return parse_docx(data)
    else:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type: {filename}. Supported: .pdf, .docx"
        )
