"""Postgres advisory-lock keys for the ml-services compute endpoints.

Bead nmemo-2yv.87: each derived-state compute endpoint
(/topology/compute, /clustering/compute, /drift/compute) wraps its
work in `pg_try_advisory_xact_lock(key)` inside a single connection
transaction. The lock auto-releases at transaction end (commit, rollback,
connection drop), so there is no manual cleanup and no risk of a stuck
"in_progress" status row blocking the next call.

Lock keys are arbitrary distinct bigints. Coordinate any new advisory-lock
caller against this table to avoid collisions.

Coordination note — platform/src/services/cross-cluster-generator.ts holds a
transaction-scoped lock via `pg_try_advisory_xact_lock(hashtext('cross_cluster_generator'))`.
Postgres `pg_try_advisory_xact_lock(<integer>)` shares ONE keyspace across all
single-argument callers (int4 is implicitly widened to bigint), so the hashed
text value and the bigints below could in principle collide. They do not:
hashtext returns int4 values, whose range (~±2^31) leaves a comfortable gap
above the small bigints 1001/1002/1003. Future additions to either side must
keep that invariant — if a new caller needs a bigint near hashtext's range,
re-evaluate.
"""

# Bigint keys for ml-services compute endpoints. Distinct from the
# cross-cluster generator's hashtext-derived int4 key (different namespace).
COMPUTE_LOCK_KEYS = {
    "topology": 1001,
    "semantic_clustering": 1002,
    "drift": 1003,
}
