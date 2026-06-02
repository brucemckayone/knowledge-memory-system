-- 038_fact_units.sql — fact->unit evidentiary links (nmemo-yxj.6)
--
-- ADDITIVE evidentiary index. Links each fact to the small embedding unit(s)
-- (epic nmemo-yxj / yxj.2) whose char offsets cover the fact's source_text span
-- within its parent window. This is a SECOND, finer grain on top of the
-- canonical provenance: facts.source_memory_id STAYS the parent window
-- (load-bearing for centroids/extract) and is NOT moved onto units. The
-- resolved persistence target per design doc 38 §7 (graph-anchored fallback).
--
-- unit_point_id is a STORED REFERENCE to a Qdrant unit satellite point id, NOT
-- an FK — units live in the Qdrant 'memories' collection, not Postgres. The
-- fallback join is fact_units -> unit_point_id -> Qdrant retrieve. Unit ids are
-- now DETERMINISTIC (uuidv5(memoryId, unitIndex), see pipeline.ts unitPointId)
-- so extract() reconstructs them from the parent-window text + splitIntoUnits
-- with zero Qdrant reads.
--
-- NOTE: 001_consolidated.sql sets search_path = ag_catalog, public, "$user" at
-- session level and we MUST NOT change it (AGE triggers + cypher() depend on
-- it). So ALL DDL below uses explicit public. qualifiers — without them new
-- objects would land in ag_catalog (first in the path) and the FK to
-- public.facts would fail cross-schema. See 002_causal_graph.sql / 037.

CREATE TABLE IF NOT EXISTS public.fact_units (
  fact_id        UUID NOT NULL REFERENCES public.facts(id) ON DELETE CASCADE,
  unit_point_id  TEXT NOT NULL,                                   -- Qdrant unit satellite point id (not an FK)
  char_start     INTEGER,
  char_end       INTEGER,
  match_kind     VARCHAR(20) NOT NULL DEFAULT 'offset_overlap',   -- offset_overlap | window_fallback
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (fact_id, unit_point_id)
);

-- Hot read for the fallback: "given these neighbour facts, get their evidence units".
CREATE INDEX IF NOT EXISTS idx_fact_units_fact ON public.fact_units (fact_id);
-- Reverse lookup (unit -> facts) for future unit-grained analyses.
CREATE INDEX IF NOT EXISTS idx_fact_units_unit ON public.fact_units (unit_point_id);
