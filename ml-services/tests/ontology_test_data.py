"""
Golden test datasets for ontology embedding benchmarks.

Separated from the benchmark runner for clarity and reuse.
"""

# ============================================================================
# SET A: Canonical ontology with known aliases
# ============================================================================

ONTOLOGY = {
    # Professional
    "works_at": {
        "description": "Currently employed at organization",
        "category": "professional",
        "aliases": ["employed_at", "works_for", "employee_of", "working_at"],
    },
    "worked_at": {
        "description": "Previously employed at organization",
        "category": "professional",
        "aliases": ["formerly_at", "ex_employee_of", "used_to_work_at"],
    },
    "manages": {
        "description": "Manages another person",
        "category": "professional",
        "aliases": ["supervises", "leads", "directs", "oversees"],
    },
    "reports_to": {
        "description": "Reports to another person",
        "category": "professional",
        "aliases": ["managed_by", "supervised_by", "under"],
    },
    "founded": {
        "description": "Founded an organization",
        "category": "professional",
        "aliases": ["created", "started", "established", "co_founded"],
    },
    "ceo_of": {
        "description": "CEO of organization",
        "category": "professional",
        "aliases": ["chief_executive_of", "runs", "heads"],
    },
    "member_of": {
        "description": "Member of organization/group",
        "category": "professional",
        "aliases": ["belongs_to", "part_of", "affiliated_with"],
    },
    # Personal
    "knows": {
        "description": "Knows another person",
        "category": "personal",
        "aliases": ["acquainted_with", "met", "familiar_with"],
    },
    "friend_of": {
        "description": "Friends with another person",
        "category": "personal",
        "aliases": ["friends_with", "close_to"],
    },
    "married_to": {
        "description": "Married to another person",
        "category": "personal",
        "aliases": ["spouse_of", "husband_of", "wife_of", "partner_of"],
    },
    "parent_of": {
        "description": "Parent of another person",
        "category": "personal",
        "aliases": ["father_of", "mother_of"],
    },
    "child_of": {
        "description": "Child of another person",
        "category": "personal",
        "aliases": ["son_of", "daughter_of"],
    },
    "sibling_of": {
        "description": "Sibling of another person",
        "category": "personal",
        "aliases": ["brother_of", "sister_of"],
    },
    # Location
    "lives_in": {
        "description": "Currently lives in location",
        "category": "location",
        "aliases": ["resides_in", "based_in", "located_in", "living_in"],
    },
    "lived_in": {
        "description": "Previously lived in location",
        "category": "location",
        "aliases": ["formerly_in", "used_to_live_in"],
    },
    "born_in": {
        "description": "Born in location",
        "category": "location",
        "aliases": ["birthplace", "native_of", "from"],
    },
    "visited": {
        "description": "Visited a location",
        "category": "location",
        "aliases": ["traveled_to", "went_to", "been_to"],
    },
    # Education
    "studied_at": {
        "description": "Studied at institution",
        "category": "education",
        "aliases": ["attended", "enrolled_at", "graduated_from", "alumnus_of"],
    },
    "has_degree": {
        "description": "Has academic degree",
        "category": "education",
        "aliases": ["earned_degree", "holds_degree", "degree_in"],
    },
    # Creation
    "created": {
        "description": "Created something",
        "category": "creation",
        "aliases": ["authored", "built", "made", "developed", "wrote", "designed"],
    },
    "owns": {
        "description": "Owns something",
        "category": "creation",
        "aliases": ["has", "possesses", "owner_of"],
    },
    # Skills
    "knows_about": {
        "description": "Has knowledge of topic",
        "category": "skills",
        "aliases": ["understands", "familiar_with_topic", "knowledgeable_in"],
    },
    "skilled_in": {
        "description": "Has skill in area",
        "category": "skills",
        "aliases": ["proficient_in", "expert_in", "good_at", "specializes_in"],
    },
    "interested_in": {
        "description": "Interested in topic",
        "category": "skills",
        "aliases": ["likes", "enjoys", "passionate_about", "into"],
    },
    # Events
    "attended_event": {
        "description": "Attended an event",
        "category": "events",
        "aliases": ["went_to_event", "participated_in"],
    },
    "organized": {
        "description": "Organized an event",
        "category": "events",
        "aliases": ["hosted", "arranged", "planned"],
    },
    "spoke_at": {
        "description": "Spoke at an event",
        "category": "events",
        "aliases": ["presented_at", "gave_talk_at", "keynote_at"],
    },
}

# Novel predicates that SHOULD be recognized as genuinely new
NOVEL_PREDICATES = {
    "mentors": {
        "description": "Provides mentorship and guidance to a less experienced person",
    },
    "competes_with": {
        "description": "Is a competitor of another organization in the same market",
    },
    "invested_in": {
        "description": "Made a financial investment in a company or project",
    },
    "teaches": {
        "description": "Teaches a subject or skill to students",
    },
    "diagnosed_with": {
        "description": "Was medically diagnosed with a condition",
    },
}


# ============================================================================
# SET B: Adversarial pairs — related but must NOT be merged
# ============================================================================

ADVERSARIAL_PAIRS = [
    # (predicate_a, predicate_b, description_a, description_b, reason)

    # Near-synonyms with meaningful distinctions
    ("mentors", "teaches",
     "Provides mentorship and guidance to a less experienced person",
     "Teaches a subject or skill to students",
     "mentoring is 1:1 guidance, teaching is formal instruction"),
    ("mentors", "coaches",
     "Provides mentorship and guidance to a less experienced person",
     "Provides coaching to improve specific skills or performance",
     "mentoring is long-term development, coaching is skill-specific"),
    ("teaches", "coaches",
     "Teaches a subject or skill to students",
     "Provides coaching to improve specific skills or performance",
     "teaching is knowledge transfer, coaching is performance improvement"),
    ("manages", "leads",
     "Manages another person",
     "Leads a team or initiative with influence and direction",
     "manages = direct authority, leads = influence/direction"),
    ("knows", "knows_about",
     "Knows another person",
     "Has knowledge of topic",
     "knows = person relationship, knows_about = topic knowledge"),
    ("created", "founded",
     "Created something",
     "Founded an organization",
     "created = general making, founded = establishing an organization"),
    ("owns", "created",
     "Owns something",
     "Created something",
     "owns = current possession, created = act of making"),

    # Inverses (must not merge — different direction)
    ("parent_of", "child_of",
     "Parent of another person",
     "Child of another person",
     "inverse direction — parent vs child"),
    ("manages", "reports_to",
     "Manages another person",
     "Reports to another person",
     "inverse direction — manager vs report"),
    ("works_at", "employs",
     "Currently employed at organization",
     "Employs a person at the organization",
     "inverse direction — employee vs employer"),
    ("teaches", "studied_at",
     "Teaches a subject or skill to students",
     "Studied at institution",
     "teacher vs student role — opposite sides"),

    # Tense variants (temporal meaning)
    ("works_at", "worked_at",
     "Currently employed at organization",
     "Previously employed at organization",
     "current vs past employment — temporal distinction matters"),
    ("lives_in", "lived_in",
     "Currently lives in location",
     "Previously lived in location",
     "current vs past residence — temporal distinction matters"),
    ("knows", "met",
     "Knows another person",
     "Met another person at a point in time",
     "ongoing relationship vs point-in-time event"),

    # Domain ambiguity
    ("runs", "manages",
     "Runs an organization or operation",
     "Manages another person",
     "'runs' a company = similar to manages, but 'runs' physically = unrelated"),
    ("leads", "manages",
     "Leads a team or initiative with influence and direction",
     "Manages another person",
     "'leads' = influence, 'manages' = authority — overlapping but distinct"),
    ("created", "built",
     "Created something",
     "Built or constructed something",
     "'created' a company = founded, 'built' a feature = developed — context-dependent"),

    # Subtle but real distinctions
    ("interested_in", "skilled_in",
     "Interested in topic",
     "Has skill in area",
     "interest vs competence — very different implications"),
    ("friend_of", "knows",
     "Friends with another person",
     "Knows another person",
     "friendship implies closeness, knowing is weaker"),
    ("member_of", "works_at",
     "Member of organization/group",
     "Currently employed at organization",
     "membership vs employment — different commitments"),
    ("visited", "lived_in",
     "Visited a location",
     "Previously lived in location",
     "temporary visit vs residential stay"),
    ("spoke_at", "attended_event",
     "Spoke at an event",
     "Attended an event",
     "speaker vs attendee — different roles"),
    ("organized", "attended_event",
     "Organized an event",
     "Attended an event",
     "organizer vs attendee — different roles"),
]


# ============================================================================
# SET C: Noise predicates — should never be promoted
# ============================================================================

NOISE_PREDICATES = [
    # Over-generic
    {"label": "related_to", "desc": "Has some unspecified relationship"},
    {"label": "connected_with", "desc": "Connected in some way"},
    {"label": "associated_with", "desc": "Associated somehow"},
    {"label": "involves", "desc": "Involves in some capacity"},
    {"label": "has", "desc": "Has something"},
    {"label": "is", "desc": "Is something"},
    {"label": "does", "desc": "Does something"},
    {"label": "about", "desc": "About something"},

    # Over-specific (one-off, not generalizable)
    {"label": "had_coffee_with", "desc": "Had coffee with someone"},
    {"label": "sat_next_to_at_conference", "desc": "Sat next to someone at a conference"},
    {"label": "emailed_about_budget", "desc": "Sent email about a budget topic"},
    {"label": "disagreed_with_on_tuesday", "desc": "Had a disagreement on a specific day"},
    {"label": "bumped_into_at_store", "desc": "Ran into someone at a store"},

    # Meaningless / vague
    {"label": "something_about", "desc": "Something about a topic"},
    {"label": "kind_of_like", "desc": "Similar to in some vague way"},
    {"label": "maybe_related", "desc": "Possibly related"},

    # Noisy near-duplicates of existing
    {"label": "sort_of_works_at", "desc": "Partially employed at organization"},
    {"label": "basically_knows", "desc": "More or less knows a person"},
]


# ============================================================================
# SET D: Natural language predicates — LLM extraction output
# ============================================================================

# (natural_language_phrase, expected_canonical)
NATURAL_LANGUAGE_PREDICATES = [
    # Employment
    ("is employed by", "works_at"),
    ("works for", "works_at"),
    ("has been working at", "works_at"),
    ("is a contractor at", "works_at"),
    ("joined the team at", "works_at"),
    ("used to work for", "worked_at"),
    ("previously employed at", "worked_at"),
    ("left their job at", "worked_at"),
    ("was fired from", "worked_at"),

    # Management
    ("is the manager of", "manages"),
    ("is in charge of", "manages"),
    ("supervises the team at", "manages"),
    ("is responsible for managing", "manages"),
    ("reports directly to", "reports_to"),
    ("works under", "reports_to"),
    ("answers to", "reports_to"),

    # Social
    ("is friends with", "friend_of"),
    ("has known since college", "knows"),
    ("was introduced to", "knows"),
    ("has been in contact with", "knows"),
    ("is married to", "married_to"),
    ("is the father of", "parent_of"),
    ("is the daughter of", "child_of"),
    ("is the brother of", "sibling_of"),

    # Location
    ("has been living in", "lives_in"),
    ("is based out of", "lives_in"),
    ("relocated to", "lives_in"),
    ("calls home", "lives_in"),
    ("grew up in", "lived_in"),
    ("spent their childhood in", "lived_in"),
    ("was born in", "born_in"),
    ("is originally from", "born_in"),
    ("traveled to", "visited"),
    ("took a trip to", "visited"),

    # Skills/Knowledge
    ("is an expert in", "skilled_in"),
    ("has experience with", "skilled_in"),
    ("is proficient at", "skilled_in"),
    ("is passionate about", "interested_in"),
    ("has a keen interest in", "interested_in"),
    ("studied at", "studied_at"),
    ("graduated from", "studied_at"),
    ("went to school at", "studied_at"),

    # Creation
    ("is the author of", "created"),
    ("developed the", "created"),
    ("built the", "created"),
    ("co-founded", "founded"),
    ("started the company", "founded"),
    ("is the owner of", "owns"),

    # Events
    ("gave a talk at", "spoke_at"),
    ("presented at", "spoke_at"),
    ("was a speaker at", "spoke_at"),
    ("went to the event", "attended_event"),
    ("participated in", "attended_event"),
    ("put together the event", "organized"),
]


# ============================================================================
# SET E: Sample texts for real LLM extraction testing
# ============================================================================

EXTRACTION_SAMPLES = [
    "Sarah has been mentoring junior developers at the company for three years.",
    "John left Google last year and is now running his own startup in Berlin.",
    "Dr. Chen teaches machine learning at Stanford and previously worked at DeepMind.",
    "Alice and Bob have been collaborating on the open-source project since 2023.",
    "The CEO announced that Acme Corp acquired TechVentures for $2B.",
    "Maria speaks fluent Japanese and lived in Tokyo for five years before moving to London.",
    "Tom invested in three startups last quarter including a biotech company.",
    "The team uses TypeScript, React, and PostgreSQL for the main product.",
    "Lisa reports to James, who manages the entire engineering department.",
    "Mike and Emma got married last summer and recently bought a house in Cambridge.",
]
