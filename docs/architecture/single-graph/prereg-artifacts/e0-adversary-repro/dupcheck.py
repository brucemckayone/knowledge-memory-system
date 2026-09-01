import json, re, math, os

ROOT = r"C:\Users\bruce.mckay\dev\nmemo"
ARC = os.path.join(ROOT, "docs/architecture/cross-corpus-audit/multihop-artifacts")
CORP = os.path.join(ROOT, "docs/architecture/cross-corpus-audit/convergence-artifacts")
OUT = os.path.join(ROOT, "docs/architecture/single-graph/prereg-artifacts")
SCR = r"C:\Users\bruce.mckay\AppData\Local\Temp\claude\C--Users-bruce-mckay-dev-nmemo\fac01e71-246c-4396-9db4-90ccdc6915e8\scratchpad"
CORPORA = ["dal-nlp", "dal-cv"]
DOC_FILE = {"dal-nlp": "corpus-A.json", "dal-cv": "corpus-B.json"}

cache = json.load(open(os.path.join(OUT, "embed-cache.json"), encoding="utf-8"))

def dot(a, b):
    return sum(a[i]*b[i] for i in range(len(a)))

docsById = {}
entsByCorpus = {}
pairs = []
for c in CORPORA:
    docs = json.load(open(os.path.join(CORP, DOC_FILE[c]), encoding="utf-8"))
    for d in docs: docsById[d["id"]] = d
    attr = json.load(open(os.path.join(ARC, f"attribution-{c}.json"), encoding="utf-8"))
    p2e = attr["paperToEntities"]
    order = json.load(open(os.path.join(ARC, f"ingest-ledger-{c}.json"), encoding="utf-8"))
    pos = {id:i for i,id in enumerate(order)}
    e2p = {}
    for paper, ents in p2e.items():
        for e in ents: e2p.setdefault(e, []).append(paper)
    for entityId, ps in e2p.items():
        uniq = [p for p in dict.fromkeys(ps) if p in docsById and p in pos]
        if len(uniq) < 2: continue
        uniq.sort(key=lambda p: pos[p])
        for docId in uniq[1:]: pairs.append((entityId, docId, c))
    ents = [json.loads(l) for l in open(os.path.join(SCR, f"ents-{c}.jsonl"), encoding="utf-8") if l.strip()]
    entsByCorpus[c] = ents

# NAME arm only. For each pair: target strict rank, and count of same-name duplicates ranking above target.
tot = 0
miss = 0
miss_with_dup_above = 0
dup_above_on_miss = []
recover_if_dedup = 0  # miss but would be <=10 if same-name dups above removed
targets_with_any_dup = 0
for c in CORPORA:
    ents = entsByCorpus[c]
    idxOf = {e["id"]:i for i,e in enumerate(ents)}
    names = [ (e["name"] or "").strip().lower() for e in ents ]
    vN = [cache[e["name"]] for e in ents]  # NAME arm text == bare name
    for (entityId, docId, cc) in [p for p in pairs if p[2]==c]:
        t = idxOf[entityId]
        d = docsById[docId]
        qv = cache[f"{d['title']} {d['abstract']}"]
        scores = [dot(qv, v) for v in vN]
        idx = list(range(len(scores)))
        idx.sort(key=lambda i: (-scores[i], i))
        posT = idx.index(t)
        sRank = posT + 1
        tot += 1
        tname = names[t]
        # duplicates of target name (excluding target itself)
        ndup_total = sum(1 for i in range(len(names)) if names[i]==tname and i!=t)
        if ndup_total > 0: targets_with_any_dup += 1
        dup_above = sum(1 for r in range(posT) if names[idx[r]]==tname)
        if sRank > 10:
            miss += 1
            if dup_above > 0:
                miss_with_dup_above += 1
                dup_above_on_miss.append(dup_above)
            # rank after removing same-name dups above
            rank_dedup = 1 + sum(1 for r in range(posT) if names[idx[r]] != tname)
            if rank_dedup <= 10: recover_if_dedup += 1

print(f"NAME arm, n={tot}")
print(f"targets with >=1 same-name duplicate entity: {targets_with_any_dup}/{tot} ({targets_with_any_dup/tot*100:.1f}%)")
print(f"strict misses (rank>10): {miss}")
print(f"  misses with >=1 same-name dup ranked above target: {miss_with_dup_above}")
if dup_above_on_miss:
    print(f"  mean same-name dups above target on those misses: {sum(dup_above_on_miss)/len(dup_above_on_miss):.2f}")
    print(f"  max: {max(dup_above_on_miss)}")
print(f"  misses that would enter top-10 if same-name dups above were removed: {recover_if_dedup}")
print(f"  => NAME strict R@10 would rise from {(tot-miss)/tot:.4f} to {(tot-miss+recover_if_dedup)/tot:.4f}")
