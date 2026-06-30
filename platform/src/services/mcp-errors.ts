/**
 * Actionable MCP tool errors (doc 38 P2 — Approach B).
 *
 * Under optimistic concurrency the agent recovers from write conflicts by
 * retrying, but only if the error tells it WHAT happened and WHAT to do. The
 * raw `Error: <pg message>` is not actionable. This maps known Postgres
 * SQLSTATEs to a tagged, instructive message the agent can act on.
 *
 * Pure — unit-tested without infra. Consumed by the MCP server's tool-call
 * catch (graph-mcp.ts).
 */

export function toActionableMcpError(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  const msg = err instanceof Error ? err.message : String(err);
  switch (code) {
    case '23505': // unique_violation — e.g. uniq_facts_active_triple (P1)
      return `Error [duplicate]: this record already exists and was treated as corroborated — do NOT retry it. (${msg})`;
    case '23503': // foreign_key_violation — referenced entity gone, or has dependents blocking delete
      return `Error [entity_missing]: a referenced entity is gone or has dependents (it may have been merged/redirected by reconciliation). Re-resolve the mention with resolve_entity and retry; skip if the fact was already asserted. (${msg})`;
    case '23514': // check_violation
      return `Error [invalid_input]: a value violated a constraint — fix the input rather than retrying as-is. (${msg})`;
    case '40001': // serialization_failure
    case '40P01': // deadlock_detected
      return `Error [conflict_retry]: a transient write conflict occurred — retry this operation. (${msg})`;
    default:
      return `Error: ${msg}`;
  }
}
