/**
 * /api/onboarding/* route handlers (iOS API v1 — ASK-010 / EPIC 2).
 *
 * Thin HTTP wrappers over the onboarding service (src/services/onboarding.ts).
 * These handlers own ONLY the wire concerns the iOS OnboardingState /
 * OnboardingPrompt / InferredFocus contract pins:
 *
 *   - GET /api/onboarding/current-prompt -> bare OnboardingState object (NO
 *     envelope key — the iOS APIClient.send decodes Response = OnboardingState
 *     directly; a wrapper like { state: ... } would fail to decode). Sparse /
 *     fresh-DB => 200 with the seeded stage_1 + opening prompt (the service
 *     seeds on first read so the home's hero is never blank).
 *   - POST /api/onboarding/confirm-focus   body { entityIds: [uuid...] }
 *     -> 2xx empty on success; 400 on a bad body or wrong stage.
 *   - POST /api/onboarding/untangle-focus  body { entityId: "uuid" }
 *     -> 2xx empty on success; 400 on a bad body or wrong stage.
 *   - POST /api/onboarding/rename-focus    body { entityId: "uuid", newName: "..." }
 *     -> 2xx empty on success; 400 on a bad body or wrong stage.
 *
 * WIRE CONTRACT (iOS Sources/MnemoBackend/ASK/Onboarding/OnboardingState.swift):
 *   - all fields camelCase (promptId, issuedAt, isHardTopic, inferredFocus,
 *     entityId, supportingEntries).
 *   - stage ∈ the closed 5-value enum (unknown => iOS dataCorrupted; the DB
 *     CHECK + the service's OnboardingStage type guarantee we never emit else).
 *   - prompt.{promptId,text,kind} non-empty; issuedAt ISO-8601.
 *   - prompt:null is meaningful (confirmed stage).
 *   - inferredFocus present ONLY at awaiting_confirmation (omitted otherwise;
 *     iOS decodeIfPresent handles absent→null).
 *   - isHardTopic omitted when false (absent→false on the decoder); v1 always
 *     omits (no classifier yet).
 *
 * The service does the stage evaluation, prompt composition, and persistence;
 * this file is only the HTTP boundary + the FAIL-LOUD wire normalization that
 * guarantees the bytes iOS can decode (mirrors routes/going.ts).
 *
 * Wiring: src/index.ts mounts the 4 routes under /api/onboarding/*. The corpus's
 * §"Endpoints needed" names /advance + /inferred-focus; those are NOT built —
 * advance is implicit via /ingest (the post-extract hook runs evaluateStage),
 * and inferred-focus is folded into GET current-prompt's awaiting_confirmation
 * payload. rename-focus IS in the iOS contract (MNEMO-tpb.1) and IS built here.
 */

import type { Context } from 'hono';
import {
  getOnboardingState,
  confirmFocus,
  untangleFocus,
  renameFocus,
  ValidationError,
  type OnboardingStage,
  type PromptKind,
  type OnboardingPrompt,
  type InferredFocusItem,
  type OnboardingState,
} from '../services/onboarding.js';

// --- wire closed enums (mirror the iOS decoders) -----------------------------

const VALID_STAGES: ReadonlySet<OnboardingStage> = new Set([
  'stage_1',
  'stage_2',
  'stage_3',
  'awaiting_confirmation',
  'confirmed',
]);

const VALID_PROMPT_KINDS: ReadonlySet<PromptKind> = new Set([
  'opening',
  'entity-citing',
  'themed',
  'confirmation',
  're-entry-softener',
]);

function nonBlank(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Normalize a composed prompt into the exact iOS wire shape. Idempotent for an
 * already-valid prompt; load-bearing as the last line of defense before the
 * bytes reach the iOS JSONDecoder. A prompt that cannot satisfy the contract
 * is DROPPED to null (warn-logged) rather than served — so the client renders
 * a prompt-less state instead of throwing (blank hero) over a bad row. Mirrors
 * toWireDirection in routes/going.ts.
 */
function toWirePrompt(p: OnboardingPrompt | null): OnboardingPrompt | null {
  if (p === null) return null; // prompt:null is meaningful (confirmed stage)
  if (!nonBlank(p.promptId)) {
    console.warn('[onboarding] dropping prompt: blank promptId');
    return null;
  }
  if (!nonBlank(p.text)) {
    console.warn(`[onboarding] dropping prompt ${p.promptId}: blank text`);
    return null;
  }
  if (!VALID_PROMPT_KINDS.has(p.kind)) {
    console.warn(
      `[onboarding] dropping prompt ${p.promptId}: invalid kind "${p.kind}"`,
    );
    return null;
  }
  // issuedAt MUST be parseable ISO-8601 (iOS .iso8601 decoder). Validate + re-
  // serialize so the wire carries a canonical string.
  const parsed = Date.parse(p.issuedAt);
  if (!nonBlank(p.issuedAt) || Number.isNaN(parsed)) {
    console.warn(
      `[onboarding] dropping prompt ${p.promptId}: issuedAt not ISO-8601 ("${p.issuedAt}")`,
    );
    return null;
  }
  return {
    promptId: p.promptId,
    text: p.text,
    kind: p.kind,
    issuedAt: new Date(parsed).toISOString(),
  };
}

/** Normalize an inferredFocus item. iOS rejects blank entityId/name + negative
 *  supportingEntries. A bad item is dropped (warn-logged). */
function toWireInferredFocus(
  items: InferredFocusItem[] | null | undefined,
): InferredFocusItem[] | null {
  if (!Array.isArray(items)) return null;
  const out: InferredFocusItem[] = [];
  for (const it of items) {
    if (!nonBlank(it.entityId)) {
      console.warn('[onboarding] dropping inferredFocus item: blank entityId');
      continue;
    }
    if (!nonBlank(it.name)) {
      console.warn(
        `[onboarding] dropping inferredFocus item ${it.entityId}: blank name`,
      );
      continue;
    }
    const supportingEntries = Math.trunc(it.supportingEntries);
    if (!Number.isFinite(supportingEntries) || supportingEntries < 0) {
      console.warn(
        `[onboarding] dropping inferredFocus item ${it.entityId}: negative/non-finite supportingEntries`,
      );
      continue;
    }
    out.push({
      entityId: it.entityId,
      name: it.name,
      supportingEntries,
    });
  }
  return out;
}

/**
 * Normalize the service state into the exact iOS OnboardingState wire shape.
 * The service already enforces most invariants; this is the belt-and-braces
 * decode-boundary guard (mirrors toGoingTowardResponse in routes/going.ts).
 *
 * inferredFocus is shipped ONLY at awaiting_confirmation (omitted otherwise);
 * the service already scopes it, but enforce the wire contract here too —
 * a stray inferredFocus at any other stage is dropped, never served.
 */
function toWireState(state: OnboardingState): OnboardingState {
  if (!VALID_STAGES.has(state.stage)) {
    // Should be impossible (DB CHECK + TS type), but fail-loud: the iOS decoder
    // would throw on an unknown stage. Ship stage_1 + a default opening prompt
    // rather than let the client blank-screen. (A throw here would 500 the
    // GET, which the iOS APIClient maps to a "still listening" fallback — also
    // acceptable, but a degraded-but-decodable state is friendlier.)
    console.warn(
      `[onboarding] invalid stage "${state.stage}" — falling back to stage_1`,
    );
    return {
      stage: 'stage_1',
      prompt: null,
    };
  }
  const prompt = toWirePrompt(state.prompt);
  const wire: OnboardingState = {
    stage: state.stage,
    prompt,
  };
  // isHardTopic: emit ONLY when true (v1 never emits; the field stays absent
  // so the decoder's absent→false default applies). When a classifier ships,
  // the service sets it true and we pass it through.
  if (state.isHardTopic === true) {
    wire.isHardTopic = true;
  }
  // inferredFocus: present ONLY at awaiting_confirmation.
  if (state.stage === 'awaiting_confirmation') {
    const focus = toWireInferredFocus(state.inferredFocus);
    wire.inferredFocus = focus ?? [];
  }
  return wire;
}

/** Read + validate a JSON body. Returns the parsed body or throws ValidationError. */
async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('request body must be valid JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * GET /api/onboarding/current-prompt. Returns the bare OnboardingState object
 * (NO envelope). Fresh-DB => 200 with the seeded stage_1 + opening prompt.
 * Any failure => 500 (iOS maps 500 to the "still listening" fallback).
 */
export async function onboardingCurrentHandler(c: Context): Promise<Response> {
  try {
    const state = await getOnboardingState();
    return c.json(toWireState(state));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

/**
 * POST /api/onboarding/confirm-focus  body { entityIds: [uuid...] }.
 * Confirms the inferred focus + advances awaiting_confirmation → confirmed.
 * 2xx empty on success; 400 on a bad body or wrong stage; 500 on internal error.
 */
export async function confirmFocusHandler(c: Context): Promise<Response> {
  try {
    const body = await readJsonBody(c);
    await confirmFocus({ entityIds: body.entityIds });
    return c.body(null, 204);
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 400);
    }
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

/**
 * POST /api/onboarding/untangle-focus  body { entityId: "uuid" }.
 * Removes one inferred focus candidate; does NOT advance the stage
 * (INVARIANT — design/08-onboarding.md). 2xx empty on success; 400 on a bad
 * body or wrong stage; 500 on internal error.
 */
export async function untangleFocusHandler(c: Context): Promise<Response> {
  try {
    const body = await readJsonBody(c);
    await untangleFocus({ entityId: body.entityId });
    return c.body(null, 204);
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 400);
    }
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

/**
 * POST /api/onboarding/rename-focus  body { entityId: "uuid", newName: "..." }.
 * Renames one inferred focus candidate's label (+ propagates to the entity's
 * canonical_name as gardening of Graph S); does NOT advance the stage.
 * 2xx empty on success; 400 on a bad body or wrong stage; 500 on internal error.
 */
export async function renameFocusHandler(c: Context): Promise<Response> {
  try {
    const body = await readJsonBody(c);
    await renameFocus({ entityId: body.entityId, newName: body.newName });
    return c.body(null, 204);
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 400);
    }
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

export default onboardingCurrentHandler;
