-- 045_predicate_enrichment.sql
-- Epic nmemo-213 (PC2, nmemo-213.2) — living predicate ontology enrichment.
-- Design: docs/architecture/truth-graph/42-living-predicate-ontology.md §5.
--
-- Adds the two pieces the deterministic multi-signal fold needs and the
-- fact_predicates registry lacks:
--   1. embedding VECTOR(768) + HNSW (vector_cosine_ops) — enriched-embedding
--      nearest-neighbour retrieval of canonical predicates. Embeddings are
--      computed by ml-services (Ollama nomic) and backfilled by
--      backfillPredicateEmbeddings() (predicate-embeddings.ts), NOT here —
--      SQL cannot call /embed. The column + index are created here; the
--      vectors are written by the TS backfill once ml-services is reachable.
--   2. subject_type / object_type — the per-predicate type pair for the
--      type-pair-overlap signal (0.30 of the score).
--
-- inverse_predicate already exists (001) but was left NULL by the 001 seed and
-- by 039. This migration populates subject_type/object_type AND inverse_predicate
-- for the 27 current CANONICAL_ONTOLOGY predicates (predicate-ontology.ts), and
-- upserts any canonical row the drifted 001 seed never created (syncOntologyToDb
-- was deprecated/never-run, nmemo-2yv.23). Static data only — no ml dependency.
--
-- Explicit public. qualifiers — 001 set search_path = ag_catalog, public at
-- session level (AGE gotcha; see CLAUDE.md / mig 029 / 037 / 039 headers). DO NOT
-- change it. Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
-- ON CONFLICT DO UPDATE.

ALTER TABLE public.fact_predicates ADD COLUMN IF NOT EXISTS embedding vector(768);
ALTER TABLE public.fact_predicates ADD COLUMN IF NOT EXISTS subject_type varchar(50);
ALTER TABLE public.fact_predicates ADD COLUMN IF NOT EXISTS object_type varchar(50);

CREATE INDEX IF NOT EXISTS idx_fact_predicates_embedding
  ON public.fact_predicates USING hnsw (embedding vector_cosine_ops);

-- Canonical ontology snapshot: predicate, description, inverse_predicate,
-- predicate_type, is_exclusive, category, aliases, subject_type, object_type.
-- Mirrors predicate-ontology.ts::CANONICAL_ONTOLOGY (27 predicates) +
-- ontology_test_data.py::PREDICATE_TYPE_PAIRS (job_title/headquartered_in pairs
-- added: a title is a concept-valued attribute; an HQ is company->place).
-- Two DELIBERATE divergences from CANONICAL_ONTOLOGY's alias lists: 'created' is
-- dropped from founded.aliases (it is itself a canonical predicate, so listing it
-- as an alias is an alias-shadows-canonical no-op) and 'has' is dropped from
-- owns.aliases (over-generic — it is in the benchmark NOISE set). Harmless either
-- way today (the createFact path keys on the exact predicate string, not the
-- aliases column), but kept out so the DB snapshot is the cleaner of the two.
INSERT INTO public.fact_predicates
  (predicate, description, inverse_predicate, predicate_type, is_exclusive, category, aliases, subject_type, object_type, is_canonical, status)
VALUES
  ('works_at',         'Employment relationship between person and organization', 'employs',     'employment',   true,  'professional', ARRAY['employed_at','works_for','employee_of','working_at','worked_at','formerly_at','ex_employee_of','used_to_work_at'], 'person',  'company', true, 'canonical'),
  ('manages',          'Manages another person',                                 'reports_to',  'hierarchy',    false, 'professional', ARRAY['supervises','leads','directs','oversees'],                                                                  'person',  'person',  true, 'canonical'),
  ('reports_to',       'Reports to another person',                              'manages',     'hierarchy',    true,  'professional', ARRAY['managed_by','supervised_by','under'],                                                                        'person',  'person',  true, 'canonical'),
  ('founded',          'Founded an organization',                                NULL,          'founding',     false, 'professional', ARRAY['started','established','co_founded'],                                                                        'person',  'company', true, 'canonical'),
  ('ceo_of',           'CEO of organization',                                    NULL,          'role',         true,  'professional', ARRAY['chief_executive_of','runs','heads'],                                                                         'person',  'company', true, 'canonical'),
  ('job_title',        'Current job title/role held by a person',                NULL,          'role',         true,  'professional', ARRAY['title','role','position','job','occupation','role_at','current_title','job_role','current_role','designation'], 'person', 'concept', true, 'canonical'),
  ('member_of',        'Member of organization/group',                           'has_member',  'membership',   false, 'professional', ARRAY['belongs_to','part_of','affiliated_with'],                                                                    'person',  'company', true, 'canonical'),
  ('knows',            'Knows another person',                                   'known_by',    'social',       false, 'personal',     ARRAY['acquainted_with','met','familiar_with'],                                                                    'person',  'person',  true, 'canonical'),
  ('friend_of',        'Friends with another person',                            NULL,          'social',       false, 'personal',     ARRAY['friends_with','close_to'],                                                                                  'person',  'person',  true, 'canonical'),
  ('married_to',       'Married to another person',                              NULL,          'family',       true,  'personal',     ARRAY['spouse_of','husband_of','wife_of','partner_of'],                                                            'person',  'person',  true, 'canonical'),
  ('parent_of',        'Parent of another person',                               'child_of',    'family',       false, 'personal',     ARRAY['father_of','mother_of'],                                                                                    'person',  'person',  true, 'canonical'),
  ('child_of',         'Child of another person',                                'parent_of',   'family',       false, 'personal',     ARRAY['son_of','daughter_of'],                                                                                     'person',  'person',  true, 'canonical'),
  ('sibling_of',       'Sibling of another person',                              NULL,          'family',       false, 'personal',     ARRAY['brother_of','sister_of'],                                                                                   'person',  'person',  true, 'canonical'),
  ('lives_in',         'Residential relationship between person and location',   NULL,          'residence',    true,  'location',     ARRAY['resides_in','based_in','located_in','living_in','lived_in','formerly_in','used_to_live_in'],                'person',  'place',   true, 'canonical'),
  ('born_in',          'Born in location',                                       NULL,          'origin',       true,  'location',     ARRAY['birthplace','native_of','from'],                                                                            'person',  'place',   true, 'canonical'),
  ('visited',          'Visited a location',                                     NULL,          'travel',       false, 'location',     ARRAY['traveled_to','went_to','been_to'],                                                                          'person',  'place',   true, 'canonical'),
  ('headquartered_in', 'Headquarters location of an organization',               NULL,          'location',     true,  'location',     ARRAY['hq','headquarters','head_office','headquartered','hq_in','head_office_in'],                                 'company', 'place',   true, 'canonical'),
  ('studied_at',       'Studied at institution',                                 NULL,          'education',    false, 'education',    ARRAY['attended','enrolled_at','graduated_from','alumnus_of'],                                                     'person',  'company', true, 'canonical'),
  ('has_degree',       'Has academic degree',                                    NULL,          'qualification',false, 'education',    ARRAY['earned_degree','holds_degree','degree_in'],                                                                 'person',  'concept', true, 'canonical'),
  ('created',          'Created something',                                      'created_by',  'creation',     false, 'creation',     ARRAY['authored','built','made','developed','wrote','designed'],                                                    'person',  'concept', true, 'canonical'),
  ('owns',             'Owns something',                                         'owned_by',    'ownership',    false, 'creation',     ARRAY['possesses','owner_of'],                                                                                     'person',  'concept', true, 'canonical'),
  ('knows_about',      'Has knowledge of topic',                                 NULL,          'knowledge',    false, 'skills',       ARRAY['understands','familiar_with_topic','knowledgeable_in'],                                                     'person',  'concept', true, 'canonical'),
  ('skilled_in',       'Has skill in area',                                      NULL,          'skill',        false, 'skills',       ARRAY['proficient_in','expert_in','good_at','specializes_in'],                                                     'person',  'concept', true, 'canonical'),
  ('interested_in',    'Interested in topic',                                    NULL,          'interest',     false, 'skills',       ARRAY['likes','enjoys','passionate_about','into'],                                                                 'person',  'concept', true, 'canonical'),
  ('attended_event',   'Attended an event',                                      NULL,          'participation',false, 'events',       ARRAY['went_to_event','participated_in'],                                                                          'person',  'event',   true, 'canonical'),
  ('organized',        'Organized an event',                                     NULL,          'participation',false, 'events',       ARRAY['hosted','arranged','planned'],                                                                              'person',  'event',   true, 'canonical'),
  ('spoke_at',         'Spoke at an event',                                      NULL,          'participation',false, 'events',       ARRAY['presented_at','gave_talk_at','keynote_at'],                                                                 'person',  'event',   true, 'canonical')
ON CONFLICT (predicate) DO UPDATE SET
  description       = EXCLUDED.description,
  inverse_predicate = EXCLUDED.inverse_predicate,
  predicate_type    = EXCLUDED.predicate_type,
  is_exclusive      = EXCLUDED.is_exclusive,
  category          = EXCLUDED.category,
  aliases           = EXCLUDED.aliases,
  subject_type      = EXCLUDED.subject_type,
  object_type       = EXCLUDED.object_type,
  is_canonical      = true,
  status            = 'canonical';
