-- 010_source_ref_index.sql — Phase 3 of Reasoning Layer Hardening
--
-- Reverse-lookup index for causal_edges.source_references. JSONB stays as
-- the authoritative forward-facing format; this join table is a derived
-- read index (cascade invalidation, blast radius, contradiction detection,
-- gardener context).
--
-- NOTE: 001_consolidated.sql sets search_path = ag_catalog, public, "$user"
-- at session level. DO NOT change it. All DDL uses explicit public.
-- qualifier so objects land in the right schema (not ag_catalog).
--
-- Forward-only and idempotent: CREATE TABLE/INDEX IF NOT EXISTS, backfill
-- with ON CONFLICT DO NOTHING. Running twice is safe.

-- ============================================
-- 1. edge_source_refs — denormalised ref index
-- ============================================
CREATE TABLE IF NOT EXISTS public.edge_source_refs (
  edge_id     UUID NOT NULL REFERENCES public.causal_edges(id) ON DELETE CASCADE,
  ref_type    VARCHAR(10) NOT NULL,
  ref_id      UUID NOT NULL,
  relevance   TEXT,
  PRIMARY KEY (edge_id, ref_type, ref_id),

  CONSTRAINT valid_ref_type CHECK (ref_type IN ('memory', 'fact', 'entity'))
);

CREATE INDEX IF NOT EXISTS idx_edge_source_refs_lookup
  ON public.edge_source_refs (ref_type, ref_id);

CREATE INDEX IF NOT EXISTS idx_edge_source_refs_edge
  ON public.edge_source_refs (edge_id);

-- ============================================
-- 2. Backfill from existing causal_edges.source_references
-- ============================================
-- Two stored shapes are present in production:
--   array:  [{"type":"memory","id":"...","relevance":"..."}]
--   string: "[{\"type\":\"memory\",\"id\":\"...\",\"relevance\":\"...\"}]"
-- The string form is legacy data from an earlier code path. The current
-- insert in causal.ts uses JSON.stringify(...)::jsonb which produces a
-- native array, but historical rows must still be backfilled correctly.
-- The CASE below normalises both shapes to a JSONB array before
-- jsonb_array_elements iterates them.

INSERT INTO public.edge_source_refs (edge_id, ref_type, ref_id, relevance)
SELECT
  n.edge_id,
  (ref->>'type')::varchar,
  (ref->>'id')::uuid,
  ref->>'relevance'
FROM (
  SELECT
    e.id AS edge_id,
    CASE
      WHEN jsonb_typeof(e.source_references) = 'array'
        THEN e.source_references
      WHEN jsonb_typeof(e.source_references) = 'string'
        THEN (e.source_references #>> '{}')::jsonb
      ELSE '[]'::jsonb
    END AS refs
  FROM public.causal_edges e
) n
CROSS JOIN LATERAL jsonb_array_elements(n.refs) ref
WHERE ref->>'type' IN ('memory', 'fact', 'entity')
  AND ref->>'id' IS NOT NULL
ON CONFLICT (edge_id, ref_type, ref_id) DO NOTHING;
