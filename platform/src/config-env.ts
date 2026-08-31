/**
 * Side-effect-free env-parsing helpers for config.ts.
 *
 * Separate from config.ts on purpose: importing config.ts runs `loadConfig()`,
 * which calls `process.exit(1)` when DATABASE_URL is absent — so it cannot be
 * imported from a pure unit test (vitest.unit.config.ts runs with zero infra).
 * These helpers live here so they can be tested directly.
 */
import { z } from 'zod';

/**
 * Strict boolean env parser (bead nmemo-9b4).
 *
 * `z.coerce.boolean()` applies `Boolean(value)`, and `Boolean('false') === true`
 * — so the only two values an operator would type to DISABLE a flag
 * (`false`, `0`) both ENABLED it. Every boolean flag in config.ts used it, which
 * meant a flag reported the opposite of what was set on exactly the inputs a
 * human would try. Verified: `z.coerce.boolean().parse('false')` returns `true`.
 *
 * This accepts the conventional spellings in both directions and THROWS on
 * anything else, so a typo is a startup failure rather than a silent default.
 * Unset or blank falls back to `defaultValue`.
 */
const TRUE_WORDS = ['true', '1', 'yes', 'on'];
const FALSE_WORDS = ['false', '0', 'no', 'off'];

export function envBool(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw.trim() === '') return defaultValue;
      const v = raw.trim().toLowerCase();
      if (TRUE_WORDS.includes(v)) return true;
      if (FALSE_WORDS.includes(v)) return false;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `expected one of ${[...TRUE_WORDS, ...FALSE_WORDS].join(', ')} (got "${raw}")`,
      });
      return z.NEVER;
    });
}
