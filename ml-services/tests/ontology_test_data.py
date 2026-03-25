"""
Golden test datasets for ontology embedding benchmarks.

Separated from the benchmark runner for clarity and reuse.

Design principle: tense is NOT a predicate distinction — it's handled by
valid_at/invalid_at timestamps on facts. Tense variants are aliases of the
base predicate. Inverses are registered explicitly, not merged.
"""

# ============================================================================
# SET A: Canonical ontology with known aliases
# Tense variants (worked_at, lived_in) folded as aliases of base predicates.
# ============================================================================

ONTOLOGY = {
    # Professional
    "works_at": {
        "description": "Employment relationship between person and organization",
        "category": "professional",
        "aliases": [
            "employed_at", "works_for", "employee_of", "working_at",
            # Tense variants — same predicate, temporality via timestamps
            "worked_at", "formerly_at", "ex_employee_of", "used_to_work_at",
        ],
    },
    "manages": {
        "description": "Manages another person",
        "category": "professional",
        "aliases": ["supervises", "leads", "directs", "oversees"],
    },
    "reports_to": {
        "description": "Reports to or works under another person in a hierarchy",
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
        "description": "Residential relationship between person and location",
        "category": "location",
        "aliases": [
            "resides_in", "based_in", "located_in", "living_in",
            # Tense variants — same predicate, temporality via timestamps
            "lived_in", "formerly_in", "used_to_live_in",
        ],
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
        "description": "Produced, authored, or built something — the subject made the object",
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

# ============================================================================
# INVERSE PAIR REGISTRY
# Each pair: (predicate_a, predicate_b) — same relationship, opposite direction.
# The system should recognize these as related but NOT merge them.
# ============================================================================

INVERSE_PAIRS = [
    ("works_at", "employs"),
    ("manages", "reports_to"),
    ("parent_of", "child_of"),
    ("owns", "owned_by"),
    ("created", "created_by"),
    ("member_of", "has_member"),
    ("knows", "known_by"),
    ("located_in", "contains"),
    ("part_of", "has_part"),
]

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

    # Subtle temporal (met is point-in-time, knows is ongoing — debatable)
    ("knows", "met",
     "Knows another person",
     "Met another person at a point in time",
     "ongoing relationship vs point-in-time event — borderline case"),

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
    ("visited", "lives_in",
     "Visited a location",
     "Residential relationship between person and location",
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
    ("has a job at", "works_at"),
    ("used to work for", "works_at"),
    ("previously employed at", "works_at"),
    ("left their job at", "works_at"),
    ("was fired from", "works_at"),

    # Management
    ("is the manager of", "manages"),
    ("is in charge of", "manages"),
    ("supervises the team at", "manages"),
    ("is responsible for managing", "manages"),
    ("reports directly to", "reports_to"),
    ("works under", "reports_to"),
    ("is supervised by", "reports_to"),

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
    ("relocated to", "lives_in"),
    ("calls home", "lives_in"),
    ("grew up in", "born_in"),
    ("spent their childhood in", "born_in"),
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

# ============================================================================
# SET F: Predicate type-pair metadata (subject_type, object_type)
# Used by multi-signal scoring to penalise type mismatches.
# ============================================================================

PREDICATE_TYPE_PAIRS = {
    "works_at": ("person", "company"),
    "manages": ("person", "person"),
    "reports_to": ("person", "person"),
    "founded": ("person", "company"),
    "ceo_of": ("person", "company"),
    "member_of": ("person", "company"),
    "knows": ("person", "person"),
    "friend_of": ("person", "person"),
    "married_to": ("person", "person"),
    "parent_of": ("person", "person"),
    "child_of": ("person", "person"),
    "sibling_of": ("person", "person"),
    "lives_in": ("person", "place"),
    "born_in": ("person", "place"),
    "visited": ("person", "place"),
    "studied_at": ("person", "company"),
    "has_degree": ("person", "concept"),
    "created": ("person", "concept"),
    "owns": ("person", "concept"),
    "knows_about": ("person", "concept"),
    "skilled_in": ("person", "concept"),
    "interested_in": ("person", "concept"),
    "attended_event": ("person", "event"),
    "organized": ("person", "event"),
    "spoke_at": ("person", "event"),
}


# ============================================================================
# SET G: Static ConceptNet synonym map
# Maps surface predicates to their canonical equivalents.
# ============================================================================

CONCEPTNET_SYNONYMS = {
    "supervises": "manages",
    "leads": "manages",
    "directs": "manages",
    "oversees": "manages",
    "employs": "works_at",  # Note: this is actually an INVERSE, not synonym
    "resides_in": "lives_in",
    "based_in": "lives_in",
    "authored": "created",
    "built": "created",
    "developed": "created",
    "wrote": "created",
    "designed": "created",
    "possesses": "owns",
    "acquainted_with": "knows",
    "friends_with": "friend_of",
    "graduated_from": "studied_at",
    "enrolled_at": "studied_at",
    "presented_at": "spoke_at",
    "traveled_to": "visited",
    "hosted": "organized",
    "expert_in": "skilled_in",
    "proficient_in": "skilled_in",
}


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


# ============================================================================
# SET E: Annotated extraction samples for B6 benchmark
# Each entry has text (realistic Telegram message / note) and expected triples.
# expected[].predicate is the CANONICAL predicate the extraction should map to.
# expected[].novel = True means the predicate should NOT map to any canonical.
# ============================================================================

EXTRACTION_SAMPLES_ANNOTATED = [
    # --- Professional: works_at ---
    {
        "text": "Sarah has been working at Google since 2020.",
        "expected": [
            {"subject": "Sarah", "predicate": "works_at", "object": "Google"},
        ],
    },
    {
        "text": "Reminder: Dave is now employed by Microsoft's Azure division.",
        "expected": [
            {"subject": "Dave", "predicate": "works_at", "object": "Microsoft"},
        ],
    },
    {
        "text": "Talked to Rachel — she left Amazon last month and joined Stripe.",
        "expected": [
            {"subject": "Rachel", "predicate": "works_at", "object": "Amazon"},
            {"subject": "Rachel", "predicate": "works_at", "object": "Stripe"},
        ],
    },
    # --- Professional: manages / reports_to ---
    {
        "text": "Lisa reports to James, who manages the entire engineering department.",
        "expected": [
            {"subject": "Lisa", "predicate": "reports_to", "object": "James"},
            {"subject": "James", "predicate": "manages", "object": "engineering department"},
        ],
    },
    {
        "text": "Kevin supervises a team of 12 developers at the London office.",
        "expected": [
            {"subject": "Kevin", "predicate": "manages", "object": "team"},
        ],
    },
    # --- Professional: founded / ceo_of ---
    {
        "text": "Elon Musk co-founded OpenAI and is the CEO of Tesla.",
        "expected": [
            {"subject": "Elon Musk", "predicate": "founded", "object": "OpenAI"},
            {"subject": "Elon Musk", "predicate": "ceo_of", "object": "Tesla"},
        ],
    },
    {
        "text": "My friend Priya started a fintech company in Singapore last year.",
        "expected": [
            {"subject": "Priya", "predicate": "founded", "object": "fintech company"},
        ],
    },
    # --- Professional: member_of ---
    {
        "text": "Carlos is a member of the IEEE and the ACM.",
        "expected": [
            {"subject": "Carlos", "predicate": "member_of", "object": "IEEE"},
            {"subject": "Carlos", "predicate": "member_of", "object": "ACM"},
        ],
    },
    # --- Personal: knows / friend_of ---
    {
        "text": "Met Daniel at the meetup last week — seems really sharp.",
        "expected": [
            {"subject": "I", "predicate": "knows", "object": "Daniel"},
        ],
    },
    {
        "text": "Sophie and I have been close friends since university.",
        "expected": [
            {"subject": "I", "predicate": "friend_of", "object": "Sophie"},
        ],
    },
    # --- Personal: married_to ---
    {
        "text": "Mike and Emma got married last summer.",
        "expected": [
            {"subject": "Mike", "predicate": "married_to", "object": "Emma"},
        ],
    },
    # --- Personal: parent_of / sibling_of ---
    {
        "text": "Anna is the mother of two kids, Liam and Zoe.",
        "expected": [
            {"subject": "Anna", "predicate": "parent_of", "object": "Liam"},
            {"subject": "Anna", "predicate": "parent_of", "object": "Zoe"},
        ],
    },
    {
        "text": "Jake's older brother Marcus works as a pilot for Air Canada.",
        "expected": [
            {"subject": "Jake", "predicate": "sibling_of", "object": "Marcus"},
            {"subject": "Marcus", "predicate": "works_at", "object": "Air Canada"},
        ],
    },
    # --- Location: lives_in ---
    {
        "text": "Maria moved to London recently, she used to live in Tokyo.",
        "expected": [
            {"subject": "Maria", "predicate": "lives_in", "object": "London"},
            {"subject": "Maria", "predicate": "lives_in", "object": "Tokyo"},
        ],
    },
    {
        "text": "We're based in Berlin now, loving the tech scene here.",
        "expected": [
            {"subject": "We", "predicate": "lives_in", "object": "Berlin"},
        ],
    },
    # --- Location: born_in ---
    {
        "text": "Fun fact: Sundar Pichai was born in Chennai, India.",
        "expected": [
            {"subject": "Sundar Pichai", "predicate": "born_in", "object": "Chennai"},
        ],
    },
    # --- Location: visited ---
    {
        "text": "Just got back from a week in Barcelona — amazing food.",
        "expected": [
            {"subject": "I", "predicate": "visited", "object": "Barcelona"},
        ],
    },
    {
        "text": "Nadia traveled to Japan and South Korea over the holidays.",
        "expected": [
            {"subject": "Nadia", "predicate": "visited", "object": "Japan"},
            {"subject": "Nadia", "predicate": "visited", "object": "South Korea"},
        ],
    },
    # --- Education: studied_at / has_degree ---
    {
        "text": "Omar graduated from MIT with a degree in computer science.",
        "expected": [
            {"subject": "Omar", "predicate": "studied_at", "object": "MIT"},
            {"subject": "Omar", "predicate": "has_degree", "object": "computer science"},
        ],
    },
    {
        "text": "Elena studied physics at Cambridge before switching to data science.",
        "expected": [
            {"subject": "Elena", "predicate": "studied_at", "object": "Cambridge"},
        ],
    },
    # --- Creation: created ---
    {
        "text": "Guido van Rossum created Python back in the early 90s.",
        "expected": [
            {"subject": "Guido van Rossum", "predicate": "created", "object": "Python"},
        ],
    },
    {
        "text": "Hannah wrote a really popular open-source testing library.",
        "expected": [
            {"subject": "Hannah", "predicate": "created", "object": "testing library"},
        ],
    },
    # --- Creation: owns ---
    {
        "text": "My uncle owns a small restaurant in downtown Portland.",
        "expected": [
            {"subject": "uncle", "predicate": "owns", "object": "restaurant"},
        ],
    },
    # --- Skills: skilled_in ---
    {
        "text": "Aisha is an expert in Kubernetes and cloud infrastructure.",
        "expected": [
            {"subject": "Aisha", "predicate": "skilled_in", "object": "Kubernetes"},
        ],
    },
    {
        "text": "Ben is really proficient at Rust and systems programming.",
        "expected": [
            {"subject": "Ben", "predicate": "skilled_in", "object": "Rust"},
        ],
    },
    # --- Skills: knows_about ---
    {
        "text": "Yuki understands quantum computing better than anyone I know.",
        "expected": [
            {"subject": "Yuki", "predicate": "knows_about", "object": "quantum computing"},
        ],
    },
    # --- Skills: interested_in ---
    {
        "text": "Leo is super passionate about renewable energy and sustainability.",
        "expected": [
            {"subject": "Leo", "predicate": "interested_in", "object": "renewable energy"},
        ],
    },
    {
        "text": "I've been getting into woodworking lately, really enjoying it.",
        "expected": [
            {"subject": "I", "predicate": "interested_in", "object": "woodworking"},
        ],
    },
    # --- Events: spoke_at ---
    {
        "text": "Dr. Kim gave a keynote at PyCon 2025 about async patterns.",
        "expected": [
            {"subject": "Dr. Kim", "predicate": "spoke_at", "object": "PyCon 2025"},
        ],
    },
    # --- Events: attended_event ---
    {
        "text": "Went to KubeCon last week, tons of great talks.",
        "expected": [
            {"subject": "I", "predicate": "attended_event", "object": "KubeCon"},
        ],
    },
    {
        "text": "Rosa and Ivan both attended the AI summit in Geneva.",
        "expected": [
            {"subject": "Rosa", "predicate": "attended_event", "object": "AI summit"},
            {"subject": "Ivan", "predicate": "attended_event", "object": "AI summit"},
        ],
    },
    # --- Events: organized ---
    {
        "text": "Sam organized the company hackathon — it was a huge success.",
        "expected": [
            {"subject": "Sam", "predicate": "organized", "object": "hackathon"},
        ],
    },
    # --- Novel predicates (should NOT map to any canonical) ---
    {
        "text": "Sarah has been mentoring junior developers at the company for three years.",
        "expected": [
            {"subject": "Sarah", "predicate": "mentors", "object": "junior developers", "novel": True},
        ],
    },
    {
        "text": "Tom invested in three startups last quarter including a biotech firm.",
        "expected": [
            {"subject": "Tom", "predicate": "invested_in", "object": "startups", "novel": True},
        ],
    },
    {
        "text": "Spotify and Apple Music compete fiercely in the streaming market.",
        "expected": [
            {"subject": "Spotify", "predicate": "competes_with", "object": "Apple Music", "novel": True},
        ],
    },
]
