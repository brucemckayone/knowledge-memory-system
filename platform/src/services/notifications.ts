/**
 * Notifications aggregator (iOS API v1 — ASK-018, GET /api/notifications).
 *
 * Serves the active, already-composed notification cards across the four kinds
 * (letter, walk, promise, contradiction). The backend owns composition,
 * dismissal, and age-out — iOS receives ONLY active cards (no user dismiss per
 * design) and does its own selection / sort / 4-card cap. We therefore return
 * every undismissed row, recency-desc; iOS applies the priority rules.
 *
 * The rows live in public.notification_cards (migration 049_ios_milestone1.sql).
 * "Active" = dismissed_at IS NULL. The composing patrols that POPULATE the table
 * (promise ripening, contradiction patrol, letter/walk landing) are a documented
 * follow-up; this endpoint is the read+serialize half of the contract iOS pins.
 *
 * Encode-boundary discipline (mirrors the iOS decoder, ASK-018):
 *   - kind MUST equal target.type — a divergent row is DROPPED (logged), never
 *     served, so the client never rejects the whole payload over one bad row.
 *   - notificationId / meta / title / body / cta / targetId must be non-blank;
 *     a row with any blank required field is DROPPED (the decoder would reject
 *     it as dataCorrupted).
 *   - severity (contradictions) and dueAt (promises) are optional and omitted
 *     when null rather than serialized as null.
 */

import { db, notificationCards } from '../db/index.js';
import { isNull, desc } from 'drizzle-orm';

export type NotificationKind = 'letter' | 'walk' | 'promise' | 'contradiction';
export type NotificationSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface NotificationTarget {
  type: NotificationKind;
  targetId: string;
  /** Optional — promise cards only. */
  dueAt?: string;
}

export interface NotificationCardDTO {
  notificationId: string;
  kind: NotificationKind;
  meta: string;
  title: string;
  body: string;
  cta: string;
  target: NotificationTarget;
  createdAt: string;
  /** Optional — contradictions only. */
  severity?: NotificationSeverity;
}

export interface NotificationsResponse {
  notifications: NotificationCardDTO[];
}

const VALID_KINDS: ReadonlySet<string> = new Set(['letter', 'walk', 'promise', 'contradiction']);

function nonBlank(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Read active notification cards (undismissed), newest-first, and serialize to
 * the iOS wire shape. Rows that would fail the iOS decoder (blank required
 * field, kind != target type, unknown kind) are dropped with a warn log so the
 * served payload always decodes cleanly. `limit` caps the rows read (the iOS
 * carousel renders at most 4; default 20 leaves headroom for client selection).
 */
export async function listActiveNotifications(limit = 20): Promise<NotificationsResponse> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 20, 100));

  const rows = await db
    .select()
    .from(notificationCards)
    .where(isNull(notificationCards.dismissedAt))
    .orderBy(desc(notificationCards.createdAt))
    .limit(safeLimit);

  const notifications: NotificationCardDTO[] = [];
  for (const r of rows) {
    if (!VALID_KINDS.has(r.kind)) {
      console.warn(`[notifications] dropping card ${r.notificationId}: unknown kind "${r.kind}"`);
      continue;
    }
    // target.type mirrors kind for the four v1 kinds (bridge-shift relaxes this
    // when it lands — see ASK-018). target_type may be null in the row; default
    // it to kind so a well-formed-but-sparse row still serves.
    const targetType = r.targetType ?? r.kind;
    if (targetType !== r.kind) {
      console.warn(
        `[notifications] dropping card ${r.notificationId}: kind "${r.kind}" != target type "${targetType}"`,
      );
      continue;
    }
    if (
      !nonBlank(r.notificationId) ||
      !nonBlank(r.meta) ||
      !nonBlank(r.title) ||
      !nonBlank(r.body) ||
      !nonBlank(r.cta) ||
      !nonBlank(r.targetId)
    ) {
      console.warn(`[notifications] dropping card ${r.notificationId}: blank required field`);
      continue;
    }

    const target: NotificationTarget = {
      type: r.kind as NotificationKind,
      targetId: r.targetId,
    };
    if (r.dueAt) target.dueAt = r.dueAt.toISOString();

    const dto: NotificationCardDTO = {
      notificationId: r.notificationId,
      kind: r.kind as NotificationKind,
      meta: r.meta,
      title: r.title,
      body: r.body,
      cta: r.cta,
      target,
      createdAt: r.createdAt.toISOString(),
    };
    if (nonBlank(r.severity)) dto.severity = r.severity as NotificationSeverity;

    notifications.push(dto);
  }

  return { notifications };
}
