/**
 * GET /api/notifications — contradiction-first notification cards (ASK-018).
 *
 * v1 ships CONTRADICTION-FIRST: the only ready composition source is
 * getContradictions() (services/contradictions.ts). This handler does the two
 * halves of the contract iOS pins:
 *
 *   1. COMPOSE + PERSIST. For the latest active (unresolved) contradictions
 *      (capped, newest-first), it composes one Voice-C card per contradiction
 *      via the composer (phraseContradiction) and UPSERTs it into
 *      public.notification_cards. Idempotent: the wire notificationId is
 *      derived deterministically from the contradiction id
 *      ("contradiction:<id>"), and the upsert keys on the
 *      notification_cards_notification_id_uniq index — so re-running never
 *      duplicates a card for the same contradiction. A card whose contradiction
 *      has since been resolved/dismissed is age-out: we stamp dismissed_at so
 *      it stops being served.
 *
 *   2. READ + SERIALIZE. It returns every undismissed row (dismissed_at IS NULL),
 *      newest-first, mapped to the iOS NotificationCard wire contract.
 *
 * G4 (pinned): for a contradiction card, target.type = "contradiction" and
 * target.targetId = the contradiction record id (the iOS rise view resolves it
 * to fact_a later). kind === target.type, always.
 *
 * Encode-boundary discipline (mirrors the iOS decoder): kind MUST equal
 * target.type; notificationId / meta / title / body / cta / targetId must be
 * non-blank — a row failing either is DROPPED (warn-logged), never served, so
 * the client never rejects the whole payload over one bad row. notificationId
 * is unique across the array (the unique index guarantees this at the row
 * level; we also de-dupe defensively on serialize). Empty => { notifications: [] }.
 */

import type { Context } from 'hono';
import { db, entities, notificationCards } from '../db/index.js';
import { sql, eq, isNull, desc } from 'drizzle-orm';
import {
  getContradictions,
  type ContradictionRow,
  type ContradictionSeverity,
} from '../services/contradictions.js';
import {
  phraseContradiction,
  assertVoiceC,
} from '../services/voice-c-composer.js';

// --- wire contract ----------------------------------------------------------

export type NotificationKind = 'contradiction';
export type NotificationSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface NotificationTarget {
  /** MUST equal the card kind. v1 ships only "contradiction". */
  type: NotificationKind;
  /** The contradiction record id (G4). Non-empty. */
  targetId: string;
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
  /** Contradictions carry severity. */
  severity?: NotificationSeverity;
}

export interface NotificationsResponse {
  notifications: NotificationCardDTO[];
}

// --- composition constants ---------------------------------------------------

/** How many of the latest active contradictions to compose into cards. */
const COMPOSE_CAP = 10;
/** Stable wire-id prefix so re-runs upsert the same row per contradiction. */
const WIRE_PREFIX = 'contradiction:';
/** Verbatim Voice-C cta — lowercase, no forbidden verbs. */
const CTA = 'read with me';
/** Verbatim Voice-C meta + title — lowercase, encouraging, never a system self. */
const META = 'a tension to sit with';
const TITLE = 'two things pull apart';

function nonBlank(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

// --- compose + persist -------------------------------------------------------

/**
 * Resolve a gentle, Voice-C-safe subject phrase for a contradiction. When the
 * contradiction names an entity we lower-case its canonical name; otherwise we
 * fall back to "this" so the prose still reads naturally without echoing raw
 * DB reasoning (which may contain UUIDs / forbidden verbs).
 */
async function resolveSubject(entityId: string | null): Promise<string> {
  if (!entityId) return 'this';
  const rows = await db
    .select({ name: entities.canonicalName })
    .from(entities)
    .where(eq(entities.id, entityId))
    .limit(1);
  const name = rows[0]?.name;
  return nonBlank(name) ? name : 'this';
}

/**
 * Compose one card per active contradiction and UPSERT into notification_cards.
 * Idempotent on notification_id (the unique index), so repeated calls never
 * duplicate a card for the same contradiction; the body is refreshed on
 * conflict so a re-detected contradiction stays current.
 */
async function composeAndPersist(contradictions: ContradictionRow[]): Promise<void> {
  for (const ctr of contradictions) {
    const subject = await resolveSubject(ctr.entityId);

    // phraseContradiction yields gentle Voice-C prose with a span over the
    // whole observed clause, sourced to the contradiction id. We feed it two
    // soft claims built from the subject rather than the raw heuristic
    // reasoning string (which can carry uppercase UUIDs / forbidden verbs).
    const composition = phraseContradiction({
      contradictionId: ctr.id,
      sourceType: 'event',
      firstClaim: `something you've held about ${subject}`,
      secondClaim: `something else you've held about ${subject}`,
    });
    // belt-and-braces: the helper already asserts, but guard the served prose.
    assertVoiceC(composition.text);

    const notificationId = `${WIRE_PREFIX}${ctr.id}`;

    await db
      .insert(notificationCards)
      .values({
        notificationId,
        kind: 'contradiction',
        meta: META,
        title: TITLE,
        body: composition.text,
        cta: CTA,
        targetType: 'contradiction',
        targetId: ctr.id,
        severity: ctr.severity,
      })
      .onConflictDoUpdate({
        target: notificationCards.notificationId,
        set: {
          body: composition.text,
          severity: ctr.severity,
          // re-detection of a previously age-out contradiction re-activates it.
          dismissedAt: null,
        },
      });
  }
}

/**
 * Age out cards whose backing contradiction is no longer active (resolved /
 * dismissed): stamp dismissed_at so they stop being served. We only touch the
 * cards we own (notification_id LIKE 'contradiction:%') and only those whose
 * contradiction id is NOT in the currently-active set.
 */
async function ageOutResolved(activeIds: string[]): Promise<void> {
  const idList = activeIds.length > 0 ? sql.join(activeIds.map((id) => sql`${id}`), sql`, `) : null;
  await db.execute(sql`
    UPDATE public.notification_cards
    SET dismissed_at = NOW()
    WHERE dismissed_at IS NULL
      AND kind = 'contradiction'
      AND notification_id LIKE ${WIRE_PREFIX + '%'}
      AND (
        ${idList === null ? sql`TRUE` : sql`target_id NOT IN (${idList})`}
      )
  `);
}

// --- read + serialize --------------------------------------------------------

/**
 * Read active cards (dismissed_at IS NULL), newest-first, and serialize to the
 * iOS wire shape. Drops any row that would fail the iOS decoder (blank required
 * field, kind != target type, unknown kind, duplicate notificationId).
 */
async function serializeActive(limit: number): Promise<NotificationsResponse> {
  const rows = await db
    .select()
    .from(notificationCards)
    .where(isNull(notificationCards.dismissedAt))
    .orderBy(desc(notificationCards.createdAt))
    .limit(limit);

  const seen = new Set<string>();
  const notifications: NotificationCardDTO[] = [];

  for (const r of rows) {
    if (r.kind !== 'contradiction') {
      console.warn(`[notifications] dropping card ${r.notificationId}: unsupported kind "${r.kind}"`);
      continue;
    }
    // target.type MUST equal kind (G4). target_type may be sparse; default to kind.
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
    if (seen.has(r.notificationId)) {
      console.warn(`[notifications] dropping card ${r.notificationId}: duplicate notificationId`);
      continue;
    }
    seen.add(r.notificationId);

    const dto: NotificationCardDTO = {
      notificationId: r.notificationId,
      kind: 'contradiction',
      meta: r.meta!,
      title: r.title,
      body: r.body,
      cta: r.cta!,
      target: { type: 'contradiction', targetId: r.targetId! },
      createdAt: r.createdAt.toISOString(),
    };
    if (nonBlank(r.severity)) dto.severity = r.severity as NotificationSeverity;

    notifications.push(dto);
  }

  return { notifications };
}

// --- public entry points -----------------------------------------------------

/**
 * Plain async core: compose+persist the latest active contradictions, age out
 * the resolved ones, then read+serialize the active cards. Returns the iOS
 * NotificationsResponse. Callable directly (tests) or via the Hono handler.
 */
export async function getNotifications(limit = 20): Promise<NotificationsResponse> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 20, 100));

  const active = await getContradictions({ unresolvedOnly: true, limit: COMPOSE_CAP });
  await composeAndPersist(active);
  await ageOutResolved(active.map((c) => c.id));

  return serializeActive(safeLimit);
}

/**
 * Hono handler for GET /api/notifications. Composition/persistence failures
 * yield 500 with an error body; an empty knowledge graph yields the well-formed
 * empty payload { notifications: [] } (never null).
 */
export async function notificationsHandler(c: Context): Promise<Response> {
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  try {
    const result = await getNotifications(limit ?? 20);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

// silence "unused" on the severity type re-export consumers may not import.
export type { ContradictionSeverity };
