import { createHash } from 'crypto';

/**
 * Context UUID Generation Utility
 *
 * Generates deterministic UUIDs from platform + conversation_id using UUID v5 (RFC 4122).
 * This allows the same conversation to always map to the same UUID without DB lookups.
 *
 * CRITICAL: Never change CONTEXT_NAMESPACE after deployment - it would break all existing mappings.
 */

// Fixed namespace UUID for context IDs - NEVER CHANGE after deployment
const CONTEXT_NAMESPACE = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

/**
 * Generate a UUID v5 from a name and namespace.
 *
 * UUID v5 uses SHA-1 hash with specific version (5) and variant (RFC 4122) bits.
 * The result is deterministic: same name + namespace always produces same UUID.
 */
function uuidv5(name: string, namespace: string): string {
  // Convert namespace UUID to bytes
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');

  // Hash namespace + name with SHA-1
  const hash = createHash('sha1').update(namespaceBytes).update(name).digest();

  // Set version (5) in the 7th byte's upper nibble
  // SHA-1 always produces 20 bytes, so indices 6 and 8 are always valid
  hash[6] = (hash[6]! & 0x0f) | 0x50;

  // Set variant (RFC 4122: 10xx) in the 9th byte
  hash[8] = (hash[8]! & 0x3f) | 0x80;

  // Format as UUID string (only use first 16 bytes)
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Generate a deterministic context UUID from platform and conversation ID.
 *
 * @param platform - The platform identifier (e.g., 'telegram', 'discord')
 * @param conversationId - The platform-specific conversation identifier
 * @returns A deterministic UUID v5
 *
 * @example
 * getContextUUID('telegram', '12345') // Always returns the same UUID
 */
export function getContextUUID(platform: string, conversationId: string): string {
  return uuidv5(`${platform}:${conversationId}`, CONTEXT_NAMESPACE);
}

/**
 * Full context identifier including source information and generated UUID.
 */
export interface ContextIdentifier {
  platform: string;
  conversationId: string;
  uuid: string;
}

/**
 * Create a complete context identifier with all components.
 *
 * @param platform - The platform identifier
 * @param conversationId - The platform-specific conversation identifier
 * @returns Object with platform, conversationId, and deterministic UUID
 */
export function createContextIdentifier(
  platform: string,
  conversationId: string
): ContextIdentifier {
  return {
    platform,
    conversationId,
    uuid: getContextUUID(platform, conversationId),
  };
}
