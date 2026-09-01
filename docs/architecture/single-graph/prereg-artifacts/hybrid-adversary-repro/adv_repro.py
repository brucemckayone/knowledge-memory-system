import json, re, math, os

ROOT = r"C:\Users\bruce.mckay\dev\nmemo"
ARC  = os.path.join(ROOT, "docs/architecture/cross-corpus-audit/multihop-artifacts")
CORP = os.path.join(ROOT, "docs/architecture/cross-corpus-audit/convergence-artifacts")
OUT  = os.path.join(ROOT, "docs/architecture/single-graph/prereg-artifacts")
SCR  = r"C:\Users\bruce.mckay\AppData\Local\Temp\claude\C--Users-bruce-mckay-dev-nmemo\fac01e71-246c-4396-9db4-90ccdc6915e8\scratchpad"
CORPORA = ["dal-nlp", "dal-cv"]
DOC_FILE = {"dal-nlp": "corpus-A.json", "dal-cv": "corpus-B.json"}
K_VALUES = [10, 30, 60, 100]
HEADLINE_K = 60
BM25_K1, BM25_B = 1.2, 0.75

print("loading cache...", flush=True)
cache = json.load(open(os.path.join(OUT, "embed-cache.json"), encoding="utf-8"))
print("cache vectors:", len(cache), flush=True)

# ---------- entity embed text (mode 'name' => bare name) ----------
def entity_name_text(name, desc):
    return name  # mode='name' returns name regardless of desc

def tokenise(t):
    return [x for x in re.split(r"[^a-z0-9]+", t.lower()) if len(x) > 0]

def matcher(name):
    esc = re.escape(name)
    return re.compile(r"(?<![a-z0-9])" + esc + r"(?![a-z0-9])")

# ---------- load docs, entities, build pairs ----------
docsById = {}
entsByCorpus = {}
attrByCorpus = {}
pairs = []
for c in CORPORA:
    docs = json.load(open(os.path.join(CORP, DOC_FILE[c]), encoding="utf-8"))
    for d in docs:
        docsById[d["id"]] = d
    attr = json.load(open(os.path.join(ARC, f"attribution-{c}.json"), encoding="utf-8"))["paperToEntities"]
    attrByCorpus[c] = attr
    order = json.load(open(os.path.join(ARC, f"ingest-ledger-{c}.json"), encoding="utf-8"))
    pos = {id: i for i, id in enumerate(order)}
    e2p = {}
    for paper, ents in attr.items():
        for e in ents:
            e2p.setdefault(e, []).append(paper)
    for entityId, ps in e2p.items():
        uniq = [p for p in dict.fromkeys(ps) if p in docsById and p in pos]
        if len(uniq) < 2:
            continue
        uniq.sort(key=lambda p: pos[p])
        for docId in uniq[1:]:
            pairs.append((entityId, docId, c))
    ents = json.load(open(os.path.join(SCR, f"ents-{c}.json"), encoding="utf-8"))
    entsByCorpus[c] = ents

print("query pairs:", len(pairs), flush=True)

# ---------- cache coverage integrity ----------
miss_ent = 0; miss_q = 0; badlen = 0
for c in CORPORA:
    for e in entsByCorpus[c]:
        v = cache.get(entity_name_text(e["name"], e["description"]))
        if v is None: miss_ent += 1
        elif len(v) != 768: badlen += 1
for (eid, docId, c) in pairs:
    d = docsById[docId]
    if cache.get(f"{d['title']} {d['abstract']}") is None:
        miss_q += 1
print(f"cache coverage: missing entity vecs={miss_ent} missing query vecs={miss_q} wrong-len={badlen}", flush=True)

def dot(a, b):
    s = 0.0
    for i in range(len(a)):
        s += a[i] * b[i]
    return s

# ---------- BM25 ----------
def build_bm25(names):
    doc_tokens = [tokenise(x) for x in names]
    doc_len = [len(t) for t in doc_tokens]
    avg = sum(doc_len) / max(1, len(doc_len))
    df = {}
    for toks in doc_tokens:
        for t in set(toks):
            df[t] = df.get(t, 0) + 1
    tf = []
    for toks in doc_tokens:
        m = {}
        for t in toks:
            m[t] = m.get(t, 0) + 1
        tf.append(m)
    return doc_len, avg, df, tf, len(names)

def bm25_scores(idx, query):
    doc_len, avg, df, tf, n = idx
    out = [0.0] * n
    for q in set(tokenise(query)):
        dfq = df.get(q)
        if not dfq:
            continue
        idf = math.log(1 + (n - dfq + 0.5) / (dfq + 0.5))
        for d in range(n):
            f = tf[d].get(q)
            if not f:
                continue
            out[d] += idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * (doc_len[d] / avg))))
    return out

def rank_by_score(scores, min_score=-math.inf):
    idx = [i for i in range(len(scores)) if scores[i] > min_score]
    idx.sort(key=lambda i: (-scores[i], i))
    return idx

def rrf_retrieved(rankings, K, universe):
    s = [0.0] * universe
    for r in rankings:
        for i in range(len(r)):
            s[r[i]] += 1.0 / (K + i + 1)
    return s

def rrf_full(rankings, K, universe):
    s = [0.0] * universe
    for r in rankings:
        rank_of = [len(r)] * universe
        for i in range(len(r)):
            rank_of[r[i]] = i
        for u in range(universe):
            s[u] += 1.0 / (K + rank_of[u] + 1)
    return s

def strict_rank_of(ranking, t):
    try:
        return ranking.index(t) + 1
    except ValueError:
        return math.inf

def condensed_rank_of(ranking, t, relevant):
    try:
        posT = ranking.index(t)
    except ValueError:
        return math.inf
    above = 0
    for r in range(posT):
        i = ranking[r]
        if i == t: continue
        if i in relevant: continue
        above += 1
    return above + 1

# ---------- relevant sets (Tier A + Tier B min-3) ----------
relevantByKey = {}
tierA_byKey = {}
tierB_byKey = {}
for c in CORPORA:
    ents = entsByCorpus[c]
    idxOf = {e["id"]: i for i, e in enumerate(ents)}
    matchers = []
    for i, e in enumerate(ents):
        nm = (e["name"] or "").strip()
        matchers.append(None if len(nm) < 3 else (i, matcher(nm.lower())))
    attr = attrByCorpus[c]
    for p in [q for q in pairs if q[2] == c]:
        docId = p[1]
        key = f"{c}#{docId}"
        if key in relevantByKey:
            continue
        d = docsById[docId]
        text = f"{d['title']} {d['abstract']}".lower()
        rel = set()
        a = set()
        for eid in attr.get(docId, []):
            i = idxOf.get(eid)
            if i is not None:
                rel.add(i); a.add(i)
        b = set()
        for m in matchers:
            if m is None: continue
            i, re_ = m
            if i in rel: continue
            if re_.search(text):
                rel.add(i); b.add(i)
        relevantByKey[key] = rel
        tierA_byKey[key] = a
        tierB_byKey[key] = b

# ---------- rank every arm ----------
ARMS = ["NAME", "BM25n"] + [f"H{k}" for k in K_VALUES] + ["HFULL60"]
strictRank = {a: [] for a in ARMS}
condRank   = {a: [] for a in ARMS}
corpusOf, entityOf, docOf = [], [], []
hEqName = []
compJaccard = []
# store rankings for tier decomposition
store = []  # dict per pair

for c in CORPORA:
    ents = entsByCorpus[c]
    idxOf = {e["id"]: i for i, e in enumerate(ents)}
    vName = [cache[entity_name_text(e["name"], e["description"])] for e in ents]
    bmIdx = build_bm25([e["name"] for e in ents])
    U = len(ents)
    for p in [q for q in pairs if q[2] == c]:
        entityId, docId, _ = p
        t = idxOf.get(entityId)
        if t is None:
            continue
        d = docsById[docId]
        qtext = f"{d['title']} {d['abstract']}"
        qv = cache[qtext]
        rel = relevantByKey[f"{c}#{docId}"]

        rName = rank_by_score([dot(qv, v) for v in vName])
        rBmN  = rank_by_score(bm25_scores(bmIdx, qtext), 0)

        strictRank["NAME"].append(strict_rank_of(rName, t))
        condRank["NAME"].append(condensed_rank_of(rName, t, rel))
        strictRank["BM25n"].append(strict_rank_of(rBmN, t))
        condRank["BM25n"].append(condensed_rank_of(rBmN, t, rel))

        hByK = {}
        for K in K_VALUES:
            h = rank_by_score(rrf_retrieved([rName, rBmN], K, U), 0)
            hByK[K] = h
            strictRank[f"H{K}"].append(strict_rank_of(h, t))
            condRank[f"H{K}"].append(condensed_rank_of(h, t, rel))
        hf = rank_by_score(rrf_full([rName, rBmN], 60, U))
        strictRank["HFULL60"].append(strict_rank_of(hf, t))
        condRank["HFULL60"].append(condensed_rank_of(hf, t, rel))

        hTop = set(hByK[HEADLINE_K][:10])
        nTop = set(rName[:10])
        hEqName.append(1 if hTop == nTop else 0)
        dTop = set(rName[:10]); bTop = set(rBmN[:10])
        inter = len(dTop & bTop); uni = len(dTop | bTop)
        compJaccard.append(inter / uni if uni else 0.0)

        corpusOf.append(c); entityOf.append(entityId); docOf.append(docId)
        store.append(dict(c=c, t=t, rName=rName, rBmN=rBmN, hByK=hByK,
                          key=f"{c}#{docId}", rel=rel))

n = len(strictRank["NAME"])
def hit(arm, k, table): return [1 if r <= k else 0 for r in table[arm]]
def hitS(arm, k): return hit(arm, k, strictRank)
def hitC(arm, k): return hit(arm, k, condRank)
def mean(xs): return sum(xs)/len(xs) if xs else float('nan')

print("\n=== GATE ===")
print(f"n = {n}")
print(f"ARM-NAME strict R@10 = {mean(hitS('NAME',10)):.20f}")
print(f"BM25n    strict R@10 = {mean(hitS('BM25n',10)):.20f}")

print("\n=== arms table (strict R@10 / condensed R@10) ===")
for a in ARMS:
    print(f"  {a:8s} strict {mean(hitS(a,10)):.6f}  cond {mean(hitC(a,10)):.6f}")

print(f"\ndegeneracy H60==NAME top10: {mean(hEqName)*100:.4f}%")
print(f"component top-10 Jaccard: {mean(compJaccard):.6f}")

# ---------- bootstrap ----------
def mulberry32(seed):
    a = seed & 0xFFFFFFFF
    def rnd():
        nonlocal a
        a = (a + 0x6d2b79f5) & 0xFFFFFFFF
        x = (a ^ (a >> 15)) & 0xFFFFFFFF
        t = (x * ((1 | a) & 0xFFFFFFFF)) & 0xFFFFFFFF
        y = (t ^ (t >> 7)) & 0xFFFFFFFF
        z = (y * ((61 | t) & 0xFFFFFFFF)) & 0xFFFFFFFF
        t = (((t + z) & 0xFFFFFFFF) ^ t) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296
    return rnd

def clustered_bootstrap(a, b, clusterOf, resamples=10000, seed=20260831):
    byc = {}
    for i, cc in enumerate(clusterOf):
        byc.setdefault(cc, []).append(i)
    clusters = list(byc.values())
    nc = len(clusters)
    delta = mean(a) - mean(b)
    rnd = mulberry32(seed)
    deltas = []
    for _ in range(resamples):
        sa = sb = 0.0; nn = 0
        for _ in range(nc):
            pick = clusters[int(rnd() * nc)]
            for i in pick:
                sa += a[i]; sb += b[i]; nn += 1
        deltas.append((sa/nn - sb/nn) if nn else 0.0)
    deltas.sort()
    return delta, deltas[int(0.025*resamples)], deltas[int(0.975*resamples)-1]

def verdict(lo, hi):
    return "ABOVE 0" if lo > 0 else ("BELOW 0" if hi < 0 else "SPANS 0")

pairKeys = [str(i) for i in range(n)]
print("\n=== PRIMARY strict H60 - NAME ===")
for lab, cl in (("byPair", pairKeys), ("byEntity", entityOf), ("byDocument", docOf)):
    d, lo, hi = clustered_bootstrap(hitS("H60",10), hitS("NAME",10), cl)
    print(f"  {lab:10s} {d:+.6f} [{lo:+.6f}, {hi:+.6f}] {verdict(lo,hi)}")

print("\n=== condensed H60 - NAME (byPair) ===")
d, lo, hi = clustered_bootstrap(hitC("H60",10), hitC("NAME",10), pairKeys)
print(f"  {d:+.6f} [{lo:+.6f}, {hi:+.6f}] {verdict(lo,hi)}")

print("\n=== secondaries ===")
d, lo, hi = clustered_bootstrap(hitS("H60",10), hitS("BM25n",10), pairKeys)
print(f"  H60 - BM25n strict {d:+.6f} [{lo:+.6f}, {hi:+.6f}] {verdict(lo,hi)}")
print("  K-robustness (H(K)-NAME strict), byPair / byEntity / byDocument:")
for K in K_VALUES:
    dp,lop,hip = clustered_bootstrap(hitS(f"H{K}",10), hitS("NAME",10), pairKeys)
    de,loe,hie = clustered_bootstrap(hitS(f"H{K}",10), hitS("NAME",10), entityOf)
    dd,lod,hid = clustered_bootstrap(hitS(f"H{K}",10), hitS("NAME",10), docOf)
    print(f"    K={K:3d} HR@10 {mean(hitS(f'H{K}',10)):.4f} | pair {dp:+.4f}[{lop:+.4f},{hip:+.4f}]{verdict(lop,hip)}"
          f" | ent [{loe:+.4f},{hie:+.4f}]{verdict(loe,hie)} | doc [{lod:+.4f},{hid:+.4f}]{verdict(lod,hid)}")
d,lo,hi = clustered_bootstrap(hitS("HFULL60",10), hitS("NAME",10), pairKeys)
print(f"  full-ranking RRF60 - NAME strict {d:+.6f} [{lo:+.6f}, {hi:+.6f}] {verdict(lo,hi)}")
print(f"  retrieved-set H60 R@10 {mean(hitS('H60',10)):.10f} vs full-ranking {mean(hitS('HFULL60',10)):.10f}  identical={mean(hitS('H60',10))==mean(hitS('HFULL60',10))}")

print("\n=== per corpus (H60-NAME strict) ===")
for c in CORPORA:
    idx = [i for i in range(n) if corpusOf[i] == c]
    hh = [hitS("H60",10)[i] for i in idx]
    nh = [hitS("NAME",10)[i] for i in idx]
    d,lo,hi = clustered_bootstrap(hh, nh, [str(i) for i in idx])
    print(f"  {c}: n={len(idx)} NAME {mean(nh):.3f} H {mean(hh):.3f} {d:+.4f}[{lo:+.4f},{hi:+.4f}]{verdict(lo,hi)}")
