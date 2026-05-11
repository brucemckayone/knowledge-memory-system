#!/usr/bin/env node
/**
 * Claude Code Stop hook — captures the latest conversation turn
 * (user message + assistant response) and stores it in Qdrant
 * via the platform's /store endpoint.
 *
 * Receives hook context JSON on stdin with transcript_path and session_id.
 * Reads the transcript JSONL, extracts the last turn, POSTs to /store.
 * All errors swallowed — this must never break the conversation.
 */

import { readFileSync } from 'node:fs';
import { request } from 'node:http';

const PORT = process.env.NMEMO_PORT || '3001';
const INGEST_URL = `http://127.0.0.1:${PORT}/ingest/queue`;
const MIN_TEXT_LENGTH = 30;
const MAX_CHUNK_LENGTH = 5000; // stay under nomic-embed-text context limit

async function main() {
  // 1. Read hook context from stdin
  const stdinBufs = [];
  for await (const buf of process.stdin) stdinBufs.push(buf);
  const raw = Buffer.concat(stdinBufs).toString();
  if (!raw.trim()) return;

  const input = JSON.parse(raw);
  const transcriptPath = input.transcript_path;
  const sessionId = input.session_id || 'unknown';

  // Only capture on real assistant turns, not slash commands / tool stops
  if (input.stop_reason && input.stop_reason !== 'end_turn') return;

  if (!transcriptPath) return;

  // 2. Read and parse transcript (JSONL — one JSON object per line)
  const fileContent = readFileSync(transcriptPath, 'utf-8');
  const lines = fileContent.split('\n').filter(l => l.trim());

  // Parse all entries (we iterate from end so need them all parsed)
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }

  // 3. Walk backwards from end to find the last turn
  //    First: collect assistant text blocks (working backwards)
  //    Then: find the preceding user message

  const assistantTexts = [];
  let userText = '';
  let foundAssistant = false;
  let foundUser = false;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];

    // Collect assistant text blocks
    if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      const textBlocks = entry.message.content
        .filter(b => b.type === 'text' && b.text)
        .map(b => b.text);
      if (textBlocks.length > 0) {
        assistantTexts.unshift(...textBlocks);
        foundAssistant = true;
      }
      continue;
    }

    // Once we've found assistant text, look for the preceding user message
    if (foundAssistant && entry.type === 'user' && !foundUser) {
      const content = entry.message?.content;

      // Skip tool results (array content)
      if (typeof content !== 'string') continue;

      // Skip meta/system messages
      if (entry.isMeta) continue;

      // Skip CLI commands and their output
      if (content.includes('<command-name>') || content.includes('<local-command')) continue;

      userText = content.trim();
      foundUser = true;
      break;
    }

    // If we hit a non-assistant, non-user entry after finding assistant text,
    // keep looking (there can be system/file-history entries interspersed)
    if (foundAssistant && entry.type === 'user' && typeof entry.message?.content !== 'string') {
      continue; // tool_result — skip and keep looking
    }
  }

  if (!foundUser || !userText) return;

  // 4. Format the turn
  const assistantResponse = assistantTexts.join('\n').trim();
  const text = assistantResponse
    ? `User: ${userText}\n\nAssistant: ${assistantResponse}`
    : `User: ${userText}`;

  // 5. Skip trivially short turns
  if (text.length < MIN_TEXT_LENGTH) return;

  // 6. Split into chunks if text exceeds embedding model context limit.
  //    Split on paragraph boundaries to keep semantic coherence.
  const chunks = [];
  if (text.length <= MAX_CHUNK_LENGTH) {
    chunks.push(text);
  } else {
    const paragraphs = text.split(/\n\n+/);
    let current = '';
    let lastPara = ''; // overlap: carry last paragraph into next chunk
    for (const para of paragraphs) {
      if (current && (current.length + para.length + 2) > MAX_CHUNK_LENGTH) {
        chunks.push(current);
        current = lastPara ? lastPara + '\n\n' + para : para;
      } else {
        current = current ? current + '\n\n' + para : para;
      }
      lastPara = para;
    }
    if (current) chunks.push(current);
  }

  // 7. Fire-and-forget POST each chunk to /ingest
  const source = `conversation:${sessionId}`;
  for (const chunk of chunks) {
    const body = JSON.stringify({ text: chunk, source });
    const req = request(INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', () => {});
    req.end(body);
  }
}

main().catch(() => {});
