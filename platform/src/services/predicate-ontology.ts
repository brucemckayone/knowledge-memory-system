/**
 * Predicate Ontology — pure definition + normalisation.
 *
 * The DB-free core of the predicate ontology: the canonical alias map and the
 * structural normalisation helpers (Layer 1). Split out of `predicates.ts` so
 * pure, DB-free consumers — chiefly the graph-integrity invariant module
 * (`graph-invariants.ts`, doc 39 §2.C) — can import the ontology without
 * dragging in the postgres pool that `predicates.ts` opens at import-time.
 *
 * `predicates.ts` re-exports everything here, so existing importers
 * (causal-agent, predicate-signature, ontology-* tests) are unaffected.
 */

export interface PredicateInfo {
  predicate: string;
  description: string;
  inversePredicate?: string;
  predicateType?: string;
  isExclusive: boolean;
  category?: string;
  aliases: string[];
  isCanonical: boolean;
  usageCount: number;
}

/**
 * Canonical ontology definition
 * Categories: professional, personal, location, education, creation, skills, events
 */
export const CANONICAL_ONTOLOGY: Record<string, {
  description: string;
  inverse?: string;
  type?: string;
  exclusive: boolean;
  category: string;
  aliases: string[];
}> = {
  // Professional relationships
  works_at: {
    description: 'Employment relationship between person and organization',
    inverse: 'employs',
    type: 'employment',
    exclusive: true,
    category: 'professional',
    aliases: ['employed_at', 'works_for', 'employee_of', 'working_at', 'worked_at', 'formerly_at', 'ex_employee_of', 'used_to_work_at'],
  },
  manages: {
    description: 'Manages another person',
    inverse: 'reports_to',
    type: 'hierarchy',
    exclusive: false,
    category: 'professional',
    aliases: ['supervises', 'leads', 'directs', 'oversees'],
  },
  reports_to: {
    description: 'Reports to another person',
    inverse: 'manages',
    type: 'hierarchy',
    exclusive: true,
    category: 'professional',
    aliases: ['managed_by', 'supervised_by', 'under'],
  },
  founded: {
    description: 'Founded an organization',
    type: 'founding',
    exclusive: false,
    category: 'professional',
    aliases: ['created', 'started', 'established', 'co_founded'],
  },
  ceo_of: {
    description: 'CEO of organization',
    type: 'role',
    exclusive: true,
    category: 'professional',
    aliases: ['chief_executive_of', 'runs', 'heads'],
  },
  member_of: {
    description: 'Member of organization/group',
    inverse: 'has_member',
    type: 'membership',
    exclusive: false,
    category: 'professional',
    aliases: ['belongs_to', 'part_of', 'affiliated_with'],
  },

  // Personal relationships
  knows: {
    description: 'Knows another person',
    inverse: 'known_by',
    type: 'social',
    exclusive: false,
    category: 'personal',
    aliases: ['acquainted_with', 'met', 'familiar_with'],
  },
  friend_of: {
    description: 'Friends with another person',
    type: 'social',
    exclusive: false,
    category: 'personal',
    aliases: ['friends_with', 'close_to'],
  },
  married_to: {
    description: 'Married to another person',
    type: 'family',
    exclusive: true,
    category: 'personal',
    aliases: ['spouse_of', 'husband_of', 'wife_of', 'partner_of'],
  },
  parent_of: {
    description: 'Parent of another person',
    inverse: 'child_of',
    type: 'family',
    exclusive: false,
    category: 'personal',
    aliases: ['father_of', 'mother_of'],
  },
  child_of: {
    description: 'Child of another person',
    inverse: 'parent_of',
    type: 'family',
    exclusive: false,
    category: 'personal',
    aliases: ['son_of', 'daughter_of'],
  },
  sibling_of: {
    description: 'Sibling of another person',
    type: 'family',
    exclusive: false,
    category: 'personal',
    aliases: ['brother_of', 'sister_of'],
  },

  // Location relationships
  lives_in: {
    description: 'Residential relationship between person and location',
    type: 'residence',
    exclusive: true,
    category: 'location',
    aliases: ['resides_in', 'based_in', 'located_in', 'living_in', 'lived_in', 'formerly_in', 'used_to_live_in'],
  },
  born_in: {
    description: 'Born in location',
    type: 'origin',
    exclusive: true,
    category: 'location',
    aliases: ['birthplace', 'native_of', 'from'],
  },
  visited: {
    description: 'Visited a location',
    type: 'travel',
    exclusive: false,
    category: 'location',
    aliases: ['traveled_to', 'went_to', 'been_to'],
  },

  // Education
  studied_at: {
    description: 'Studied at institution',
    type: 'education',
    exclusive: false,
    category: 'education',
    aliases: ['attended', 'enrolled_at', 'graduated_from', 'alumnus_of'],
  },
  has_degree: {
    description: 'Has academic degree',
    type: 'qualification',
    exclusive: false,
    category: 'education',
    aliases: ['earned_degree', 'holds_degree', 'degree_in'],
  },

  // Creation/Ownership
  created: {
    description: 'Created something',
    inverse: 'created_by',
    type: 'creation',
    exclusive: false,
    category: 'creation',
    aliases: ['authored', 'built', 'made', 'developed', 'wrote', 'designed'],
  },
  owns: {
    description: 'Owns something',
    inverse: 'owned_by',
    type: 'ownership',
    exclusive: false,
    category: 'creation',
    aliases: ['has', 'possesses', 'owner_of'],
  },

  // Knowledge/Skills
  knows_about: {
    description: 'Has knowledge of topic',
    type: 'knowledge',
    exclusive: false,
    category: 'skills',
    aliases: ['understands', 'familiar_with_topic', 'knowledgeable_in'],
  },
  skilled_in: {
    description: 'Has skill in area',
    type: 'skill',
    exclusive: false,
    category: 'skills',
    aliases: ['proficient_in', 'expert_in', 'good_at', 'specializes_in'],
  },
  interested_in: {
    description: 'Interested in topic',
    type: 'interest',
    exclusive: false,
    category: 'skills',
    aliases: ['likes', 'enjoys', 'passionate_about', 'into'],
  },

  // Events
  attended_event: {
    description: 'Attended an event',
    type: 'participation',
    exclusive: false,
    category: 'events',
    aliases: ['went_to_event', 'participated_in'],
  },
  organized: {
    description: 'Organized an event',
    type: 'participation',
    exclusive: false,
    category: 'events',
    aliases: ['hosted', 'arranged', 'planned'],
  },
  spoke_at: {
    description: 'Spoke at an event',
    type: 'participation',
    exclusive: false,
    category: 'events',
    aliases: ['presented_at', 'gave_talk_at', 'keynote_at'],
  },
};

// Build reverse lookup for aliases
const aliasToCanonical: Map<string, string> = new Map();
for (const [canonical, info] of Object.entries(CANONICAL_ONTOLOGY)) {
  for (const alias of info.aliases) {
    aliasToCanonical.set(alias.toLowerCase(), canonical);
  }
}

/**
 * Normalize a predicate to its canonical form
 */
export function normalizePredicate(predicate: string): string {
  const normalized = predicate.toLowerCase().replace(/\s+/g, '_');

  // Check if already canonical
  if (CANONICAL_ONTOLOGY[normalized]) {
    return normalized;
  }

  // Check alias lookup
  const canonical = aliasToCanonical.get(normalized);
  if (canonical) {
    return canonical;
  }

  // Return as-is if not found (will be flagged for review)
  return normalized;
}

/**
 * Get predicate info from ontology
 */
export function getPredicateInfo(predicate: string): PredicateInfo | null {
  const canonical = normalizePredicate(predicate);
  const info = CANONICAL_ONTOLOGY[canonical];

  if (!info) {
    return null;
  }

  return {
    predicate: canonical,
    description: info.description,
    inversePredicate: info.inverse,
    predicateType: info.type,
    isExclusive: info.exclusive,
    category: info.category,
    aliases: info.aliases,
    isCanonical: true,
    usageCount: 0,
  };
}

/**
 * Check if predicate is in canonical ontology
 */
export function isCanonicalPredicate(predicate: string): boolean {
  const normalized = predicate.toLowerCase().replace(/\s+/g, '_');
  return !!CANONICAL_ONTOLOGY[normalized];
}
