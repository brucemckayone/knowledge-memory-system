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

export async function getEntityById(id: string): Promise<NmemoEntity | null> {
  const r = await fetch(`${base()}/api/learn/entity/${encodeURIComponent(id)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Nmemo /api/learn/entity/:id ${r.status}: ${await r.text()}`);
  return r.json() as Promise<NmemoEntity>;
}

export async function getLearnerFacts(): Promise<{ facts: NmemoFact[] }> {
  return get<{ facts: NmemoFact[] }>('/api/learn/learner-facts');
}

export async function getImpact(type: 'fact' | 'entity', id: string) {
  return get(`/api/impact/${type}/${id}?depth=3`);
}

// ── Patrol read endpoints ─────────────────────────────────────────────────

export interface DecayCandidate {
  entity_id: string;
  canonical_name: string;
  entity_type: string;
  last_fact_at: string;
  peak_confidence: number;
  fact_count: number;
}

export async function getDecayCandidates(thresholdDays: number): Promise<{ thresholdDays: number; candidates: DecayCandidate[] }> {
  return get(`/api/learn/decay-candidates?threshold_days=${encodeURIComponent(String(thresholdDays))}`);
}

export interface SameAsConceptLink {
  id: string;
  entity_a_id: string;
  entity_b_id: string;
  a_name: string;
  b_name: string;
  reasoning: string;
  confidence: number;
  created_at: string;
}

export async function getSameAsConcepts(): Promise<{ links: SameAsConceptLink[] }> {
  return get('/api/learn/same-as-concepts');
}

export interface ConceptCluster {
  entityIds: string[];
  entityNames: string[];
  size: number;
  edgeCount: number;
}

export async function getConceptClusters(minSize: number, lookbackDays = 30): Promise<{ minSize: number; lookbackDays: number; clusters: ConceptCluster[] }> {
  return get(`/api/learn/concept-clusters?min_size=${minSize}&lookback_days=${lookbackDays}`);
}

// ── Graph snapshot ───────────────────────────────────────────────────────

export interface GraphSnapshot {
  conceptCount: number;
  factCount: number;
  growthThisWeek: number;
}

export async function getGraphSnapshot(): Promise<GraphSnapshot> {
  return get<GraphSnapshot>('/api/learn/graph-snapshot');
}

// ── Blast radius / impact ────────────────────────────────────────────────

export interface BlastRadiusReport {
  root: { nodeType: string; nodeId: string; summary: string };
  severitySummary: { critical: number; high: number; medium: number; low: number };
  totalAffected: number;
}

export async function getBlastRadius(type: 'fact' | 'entity' | 'causal_event', id: string, depth = 2): Promise<BlastRadiusReport> {
  return get<BlastRadiusReport>(`/api/impact/${type}/${encodeURIComponent(id)}?depth=${depth}`);
}

// ── Struggle areas (composed from learner-facts + contradictions) ────────

export interface StruggleArea {
  entityId: string | null;
  predicate: string;
  confidence: number;
  objectValue: string | null;
  sourceText: string | null;
  createdAt: string;
}

export async function getStruggleAreas(): Promise<{ weakAreas: StruggleArea[]; confusions: StruggleArea[] }> {
  const learner = await getLearnerFacts();
  const weakAreas: StruggleArea[] = [];
  const confusions: StruggleArea[] = [];
  for (const f of learner.facts) {
    const row: StruggleArea = {
      entityId: f.objectEntityId ?? null,
      predicate: f.predicate,
      confidence: f.confidence ?? 0,
      objectValue: f.objectValue ?? null,
      sourceText: f.sourceText ?? null,
      createdAt: (f as unknown as { createdAt?: string }).createdAt ?? '',
    };
    if (f.predicate === 'understands' && (f.confidence ?? 1) < 0.6) weakAreas.push(row);
    else if (f.predicate === 'confused_by' || f.predicate === 'lacks_understanding_of' || f.predicate === 'struggles_with') confusions.push(row);
  }
  return { weakAreas, confusions };
}
