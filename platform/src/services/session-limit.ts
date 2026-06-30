/**
 * Session / usage-limit detection + reset-time parsing for the resumable
 * batch-ingest driver (scripts/ingest-resumable.ts).
 *
 * When the LLM provider is Claude Code (ml-services shells out to `claude -p`),
 * an exhausted subscription/usage window makes the CLI exit non-zero with a
 * message like:
 *
 *     You've hit your session limit · resets 1pm (Europe/London)
 *
 * llm.py's _run() packs that text into the HTTP 500 body's `stderr_tail`,
 * agentFetch surfaces it as the thrown Error message, and handleBatch returns
 * it verbatim in the response body — so the whole string reaches a caller.
 *
 * Unlike a transient 503 / flaky `rc=1` (which exponential backoff recovers), a
 * usage limit resets on a wall-clock schedule HOURS away: retrying in-process is
 * pointless and just burns attempts. The resumable driver instead DETECTS the
 * limit, parses the reset time, sleeps until then, and resumes where it left
 * off.
 *
 * Both functions are PURE — parseResetAt takes `now` rather than reading the
 * clock — so they unit-test without infra or a real clock.
 */

/**
 * Signatures distinctive of a subscription/usage limit (a wait-it-out
 * condition), deliberately NARROW so a transient HTTP 429 "rate limit" or a 503
 * queue-full (both short-backoff-recoverable) do NOT match. We key on the
 * subscription-specific wording the Claude CLI emits, not the generic word
 * "limit".
 */
const LIMIT_SIGNATURES: RegExp[] = [
  /session limit/i,
  /usage limit/i,
  /hit your (?:session|usage|monthly|weekly)?\s*limit/i,
  /reached your (?:session|usage|monthly|weekly)?\s*limit/i,
  /admin-settings\/usage/i,
  /claude\.ai\/[^\s]*usage/i,
  // "limit … resets <clock-time>" — the reset clause is the reliable tell that
  // this is a scheduled-reset limit and not a transient throttle.
  /limit[^.]{0,80}reset/i,
];

/** Coerce any thrown value / response body into a searchable string. */
function toText(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * True when `err` (an Error, a string, or a response-body object) looks like a
 * Claude subscription/usage limit — the signal to pause-and-resume rather than
 * retry. False for transient throttles (429/503) and ordinary failures.
 */
export function isSessionLimitError(err: unknown): boolean {
  const text = toText(err);
  if (!text) return false;
  return LIMIT_SIGNATURES.some((re) => re.test(text));
}

/**
 * Parse the reset moment out of a limit message, relative to `now`. Returns the
 * next future Date the limit is said to reset, or null if no reset hint is
 * found.
 *
 * Recognised forms (case-insensitive; "reset"/"resets"/"reset at"):
 *   - ISO timestamp           "resets 2026-06-24T13:00:00Z"     → exact instant
 *   - relative                "resets in 2 hours" / "in 45 min" → now + delta
 *   - clock time              "resets 1pm" / "1:30pm" / "13:00" → next such time
 *
 * Clock times are interpreted in the HOST's local timezone (the CLI prints the
 * reset in the user's zone, and the driver is expected to run in that zone). If
 * the computed time is at or before `now`, it rolls to the next day — a limit
 * "resets 1pm" seen at 2pm means 1pm tomorrow.
 */
export function parseResetAt(text: string, now: Date): Date | null {
  if (!text) return null;

  // 1. ISO-8601 instant.
  const iso = text.match(
    /reset[a-z]*(?:\s+(?:at|by))?\s+(\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i,
  );
  if (iso?.[1]) {
    const d = new Date(iso[1].replace(' ', 'T'));
    if (!Number.isNaN(d.getTime())) return d;
  }

  // 2. Relative — "resets in N hours / minutes" (singular or plural unit).
  const rel = text.match(/reset[a-z]*\s+in\s+(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i);
  if (rel?.[1]) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const ms = /^h/.test(unit) ? n * 3_600_000 : n * 60_000;
    return new Date(now.getTime() + ms);
  }

  // 3. Clock time — "resets 1pm", "resets at 1:30pm", "resets 13:00".
  const clock = text.match(
    /reset[a-z]*(?:\s+(?:at|by))?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i,
  );
  if (clock?.[1]) {
    let hour = Number(clock[1]);
    const minute = clock[2] ? Number(clock[2]) : 0;
    const meridiem = clock[3]?.toLowerCase();
    if (hour > 23 || minute > 59) return null;
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    const candidate = new Date(now);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate.getTime() <= now.getTime()) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate;
  }

  return null;
}
