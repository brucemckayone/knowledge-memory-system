import { config } from '../config.js';

const base = () => config.NMEMO_URL;

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${base()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Nmemo ${path} ${r.status}: ${await r.text()}`);
  return r.json() as Promise<T>;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${base()}${path}`);
  if (!r.ok) throw new Error(`Nmemo ${path} ${r.status}: ${await r.text()}`);
  return r.json() as Promise<T>;
}

// ── Graph read operations ──────────────────────────────────────────────────

export interface NmemoEntity {
  id: string;
  canonicalName: string;
  entityType: string;
  confidence: number;
  summary?: string | null;
}

export interface NmemoFact {
  id: string;
  subjectEntityId: string;
  predicate: string;
  objectEntityId?: string | null;
  objectValue?: string | null;
  confidence?: number | null;
  sourceText?: string | null;
}

export interface GraphSData {
  nodes: Array<{ id: string; label: string; type: string; confidence: number; sources?: unknown[] }>;
  links: Array<{ id: string; source: string; target: string; predicate: string; confidence?: number; objectValue?: string | null }>;
}

export async function getGraphS(): Promise<GraphSData> {
  return get<GraphSData>('/api/viz/graph-s');
}

export async function getContradictions() {
  return get<{ contradictions: unknown[] }>('/api/contradictions?unresolved=true&limit=20');
}

export async function getActivePatterns() {
  return get<{ patterns: unknown[] }>('/api/patterns?status=canonical,provisional&limit=20');
}

export interface ReasonQueryResult { triggered: boolean; result: string; durationMs: number }

export async function queryReasoning(question: string): Promise<ReasonQueryResult> {
  return post<ReasonQueryResult>('/api/reason/query', { question });
}

// ── Content ingestion ──────────────────────────────────────────────────────

export interface IngestResult {
  memoryId: string;
  entities: NmemoEntity[];
  facts: NmemoFact[];
}

export async function ingestContent(text: string, source = 'learn'): Promise<IngestResult> {
  return post<IngestResult>('/ingest', { text, source });
}

// ── Learning-specific write operations (via /api/learn/ endpoints) ─────────

export interface RecordFactParams {
  subjectName: string;
  subjectType: string;
  predicate: string;
  objectName?: string;
  objectType?: string;
  objectValue?: string;
  confidence?: number;
  sourceText?: string;
}

export interface RecordFactResult {
  entityId: string;
  factId: string;
}

export async function recordFact(params: RecordFactParams): Promise<RecordFactResult> {
  return post<RecordFactResult>('/api/learn/record', params);
}

export interface ConceptResult {
  entity: NmemoEntity | null;
  facts: NmemoFact[];
}

export async function getConcept(name: string): Promise<ConceptResult> {
  const encoded = encodeURIComponent(name);
  return get<ConceptResult>(`/api/learn/concept/${encoded}`);
}

export async function getLearnerFacts(): Promise<{ facts: NmemoFact[] }> {
  return get<{ facts: NmemoFact[] }>('/api/learn/learner-facts');
}

export async function getImpact(type: 'fact' | 'entity', id: string) {
  return get(`/api/impact/${type}/${id}?depth=3`);
}
