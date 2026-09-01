import json, re, os
from collections import Counter

ROOT = r"C:\Users\bruce.mckay\dev\nmemo"
ARC = os.path.join(ROOT, "docs/architecture/cross-corpus-audit/multihop-artifacts")
CORP = os.path.join(ROOT, "docs/architecture/cross-corpus-audit/convergence-artifacts")
SCR = r"C:\Users\bruce.mckay\AppData\Local\Temp\claude\C--Users-bruce-mckay-dev-nmemo\fac01e71-246c-4396-9db4-90ccdc6915e8\scratchpad"
CORPORA = ["dal-nlp", "dal-cv"]
DOC_FILE = {"dal-nlp": "corpus-A.json", "dal-cv": "corpus-B.json"}

def matcher(name):
    return re.compile(r"(?<![a-z0-9])" + re.escape(name) + r"(?![a-z0-9])")

for c in CORPORA:
    docs = json.load(open(os.path.join(CORP, DOC_FILE[c]), encoding="utf-8"))
    docsById = {d["id"]: d for d in docs}
    attr = json.load(open(os.path.join(ARC, f"attribution-{c}.json"), encoding="utf-8"))
    p2e = attr["paperToEntities"]
    order = json.load(open(os.path.join(ARC, f"ingest-ledger-{c}.json"), encoding="utf-8"))
    pos = {id: i for i, id in enumerate(order)}
    e2p = {}
    for paper, ents in p2e.items():
        for e in ents:
            e2p.setdefault(e, []).append(paper)
    qdocs = set()
    for entityId, ps in e2p.items():
        uniq = [p for p in dict.fromkeys(ps) if p in docsById and p in pos]
        if len(uniq) < 2:
            continue
        uniq.sort(key=lambda p: pos[p])
        for docId in uniq[1:]:
            qdocs.add(docId)
    ents = [json.loads(l) for l in open(os.path.join(SCR, f"ents-{c}.jsonl"), encoding="utf-8") if l.strip()]

    # duplicate names
    names = [e["name"] for e in ents]
    dup = Counter(names)
    ndup_names = sum(1 for k, v in dup.items() if v > 1)
    ndup_ents = sum(v for k, v in dup.items() if v > 1)
    print(f"\n===== {c}: {len(ents)} entities, {ndup_names} names duplicated across {ndup_ents} entities =====")
    print("  top duplicated names:", [f"{k!r}x{v}" for k, v in dup.most_common(8) if v > 1])

    # name length distribution
    lens = Counter(len(e["name"].strip()) for e in ents)
    short = sum(v for k, v in lens.items() if k < 5)
    print(f"  entities with name length 3-4: {sum(v for k,v in lens.items() if 3<=k<5)}  <3: {sum(v for k,v in lens.items() if k<3)}")

    # For each entity name (len>=3), how many query docs does it match verbatim?
    matchers = []
    for e in ents:
        nm = e["name"].strip()
        if len(nm) >= 3:
            matchers.append((nm, matcher(nm.lower())))
    doctexts = {d: f"{docsById[d]['title']} {docsById[d]['abstract']}".lower() for d in qdocs}
    matchcount = Counter()
    for nm, re_ in matchers:
        cnt = sum(1 for d in qdocs if re_.search(doctexts[d]))
        if cnt > 0:
            matchcount[nm] = cnt
    nq = len(qdocs)
    # names matching a large fraction of docs = likely generic
    generic = [(nm, cnt) for nm, cnt in matchcount.items() if cnt >= 0.5 * nq]
    generic.sort(key=lambda x: -x[1])
    print(f"  query docs: {nq}; distinct names matching >=1 doc: {len(matchcount)}")
    print(f"  names matching >=50% of query docs (candidate generic terms): {len(generic)}")
    for nm, cnt in generic[:25]:
        print(f"      {cnt}/{nq}  {nm!r}")
    # short-name matches (len 3-4) that fire
    shortmatch = [(nm, cnt) for nm, cnt in matchcount.items() if len(nm) < 5]
    shortmatch.sort(key=lambda x: -x[1])
    print(f"  short-name (len3-4) matchers firing: {len(shortmatch)}; top by doc-frequency:")
    for nm, cnt in shortmatch[:15]:
        print(f"      {cnt}/{nq}  {nm!r}")
