import json, re, math, sys, os

ROOT = r"C:\Users\bruce.mckay\dev\nmemo"
ARC = os.path.join(ROOT, "docs/architecture/cross-corpus-audit/multihop-artifacts")
CORP = os.path.join(ROOT, "docs/architecture/cross-corpus-audit/convergence-artifacts")
OUT = os.path.join(ROOT, "docs/architecture/single-graph/prereg-artifacts")
SCR = r"C:\Users\bruce.mckay\AppData\Local\Temp\claude\C--Users-bruce-mckay-dev-nmemo\fac01e71-246c-4396-9db4-90ccdc6915e8\scratchpad"
CORPORA = ["dal-nlp", "dal-cv"]
DOC_FILE = {"dal-nlp": "corpus-A.json", "dal-cv": "corpus-B.json"}

print("loading cache...", flush=True)
cache = json.load(open(os.path.join(OUT, "embed-cache.json"), encoding="utf-8"))
print("cache vectors:", len(cache), flush=True)

def name_text(name, desc):
    return name

def desc_text(name, desc):
    d = (desc or "").strip()
    if not d:
        return name
    return f"{name}\n{d}"

def matcher(name):
    return re.compile(r"(?<![a-z0-9])" + re.escape(name) + r"(?![a-z0-9])")

# ---- load docs, entities, build query pairs ----
docsById = {}
entsByCorpus = {}
pairs = []
attrByCorpus = {}
for c in CORPORA:
    docs = json.load(open(os.path.join(CORP, DOC_FILE[c]), encoding="utf-8"))
    for d in docs:
        docsById[d["id"]] = d
    attr = json.load(open(os.path.join(ARC, f"attribution-{c}.json"), encoding="utf-8"))
    p2e = attr["paperToEntities"]
    attrByCorpus[c] = p2e
    order = json.load(open(os.path.join(ARC, f"ingest-ledger-{c}.json"), encoding="utf-8"))
    pos = {id: i for i, id in enumerate(order)}
    e2p = {}
    for paper, ents in p2e.items():
        for e in ents:
            e2p.setdefault(e, []).append(paper)
    for entityId, ps in e2p.items():
        uniq = [p for p in dict.fromkeys(ps) if p in docsById and p in pos]
        if len(uniq) < 2:
            continue
        uniq.sort(key=lambda p: pos[p])
        for docId in uniq[1:]:
            pairs.append((entityId, docId, c))
    ents = [json.loads(l) for l in open(os.path.join(SCR, f"ents-{c}.jsonl"), encoding="utf-8") if l.strip()]
    entsByCorpus[c] = ents

print("query pairs:", len(pairs), flush=True)

# ---- vectors from cache; check integrity ----
missing = 0
bad = 0
def getvec(txt):
    global missing, bad
    v = cache.get(txt)
    if v is None:
        missing += 1
        return None
    if len(v) != 768:
        bad += 1
    return v

vecName = {}
vecDesc = {}
for c in CORPORA:
    ents = entsByCorpus[c]
    vecName[c] = [getvec(name_text(e["name"], e["description"])) for e in ents]
    vecDesc[c] = [getvec(desc_text(e["name"], e["description"])) for e in ents]
print(f"missing entity vectors: {missing}  wrong-length: {bad}", flush=True)

# check query vectors
qmissing = 0
for c in CORPORA:
    for docId in set(p[1] for p in pairs if p[2] == c):
        d = docsById[docId]
        if cache.get(f"{d['title']} {d['abstract']}") is None:
            qmissing += 1
print("missing query vectors:", qmissing, flush=True)

def dot(a, b):
    s = 0.0
    for i in range(len(a)):
        s += a[i] * b[i]
    return s

# ---- Tier A / Tier B per query doc ----
tierA = {}         # key c#doc -> set(idx)
tierBmatched = {}  # key c#doc -> list of (idx, nameLen, multi)
tierBsizes = []
relevantFracs = []
for c in CORPORA:
    ents = entsByCorpus[c]
    idxOf = {e["id"]: i for i, e in enumerate(ents)}
    matchers = []
    for i, e in enumerate(ents):
        nm = (e["name"] or "").strip()
        if len(nm) < 3:
            matchers.append(None)
        else:
            matchers.append((i, matcher(nm.lower()), len(nm), bool(re.search(r"\s", nm))))
    p2e = attrByCorpus[c]
    qdocs = set(p[1] for p in pairs if p[2] == c)
    for docId in qdocs:
        d = docsById[docId]
        text = f"{d['title']} {d['abstract']}".lower()
        a = set()
        for eid in p2e.get(docId, []):
            if eid in idxOf:
                a.add(idxOf[eid])
        matched = []
        for m in matchers:
            if m is None:
                continue
            i, re_, nl, multi = m
            if i in a:
                continue
            if re_.search(text):
                matched.append((i, nl, multi))
        tierA[f"{c}#{docId}"] = a
        tierBmatched[f"{c}#{docId}"] = matched
        tierBsizes.append(len(matched))
        relevantFracs.append((len(a) + len(matched)) / len(ents))

meanTierB = sum(tierBsizes) / len(tierBsizes)
meanRelFrac = sum(relevantFracs) / len(relevantFracs)
print(f"Tier-B mean/doc: {meanTierB:.4f}  mean |relevant|/|corpus|: {meanRelFrac*100:.2f}%", flush=True)

def tierBset(key, minLen, multiOnly):
    out = set()
    for (i, nl, multi) in tierBmatched.get(key, []):
        if nl < minLen:
            continue
        if multiOnly and not multi:
            continue
        out.add(i)
    return out

CONFIGS = [("min3", 3, False), ("min5", 5, False), ("min8", 8, False), ("multi", 3, True)]

# ---- rank both arms; strict + condensed ----
strict = {"NAME": [], "DESC": []}
cond = {lab: {"NAME": [], "DESC": []} for lab, _, _ in CONFIGS}
corpusOf = []
entityOf = []
docOf = []
targetVerbatim = []
tie_at_target = 0
missrows = []  # (arm, corpus, aO, bC, cC, strictmiss)
recovered = {"NAME": [], "DESC": []}  # (strictMiss, recovered, corpus)

for c in CORPORA:
    ents = entsByCorpus[c]
    idxOf = {e["id"]: i for i, e in enumerate(ents)}
    vN = vecName[c]
    vD = vecDesc[c]
    for (entityId, docId, cc) in [p for p in pairs if p[2] == c]:
        t = idxOf.get(entityId)
        if t is None:
            continue
        d = docsById[docId]
        qv = cache.get(f"{d['title']} {d['abstract']}")
        key = f"{c}#{docId}"
        aSet = tierA[key]
        for arm, vecs in (("NAME", vN), ("DESC", vD)):
            scores = []
            for v in vecs:
                if qv is None or v is None:
                    scores.append(float("nan"))
                else:
                    scores.append(dot(qv, v))
            # ranking: indices with score > -inf (drop NaN), sort desc by score, asc by index
            idx = [i for i in range(len(scores)) if scores[i] > -math.inf]
            idx.sort(key=lambda i: (-scores[i], i))
            # posT
            try:
                posT = idx.index(t)
            except ValueError:
                posT = -1
            sRank = math.inf if posT < 0 else posT + 1
            strict[arm].append(sRank)
            # tie detection at target
            if posT >= 0:
                ts = scores[t]
                nties = sum(1 for i in idx if scores[i] == ts)
                if nties > 1:
                    tie_at_target += 1
            # condensed per config
            for lab, minLen, multiOnly in CONFIGS:
                bSet = tierBset(key, minLen, multiOnly)
                if posT < 0:
                    cond[lab][arm].append(math.inf)
                    continue
                above = 0
                for r in range(posT):
                    i = idx[r]
                    if i == t:
                        continue
                    if i in aSet or i in bSet:
                        continue
                    above += 1
                cond[lab][arm].append(above + 1)
            # miss-mass at min3
            if sRank > 10:
                bSet = tierBset(key, 3, False)
                aO = bC = cC = 0
                for i in idx[:10]:
                    if i == t:
                        continue
                    if i in aSet:
                        aO += 1
                    elif i in bSet:
                        bC += 1
                    else:
                        cC += 1
                missrows.append((arm, c, aO, bC, cC))
            crv = cond["min3"][arm][-1]
            recovered[arm].append((1 if sRank > 10 else 0, 1 if (sRank > 10 and crv <= 10) else 0, c))
        corpusOf.append(c)
        entityOf.append(entityId)
        docOf.append(docId)
        tvname = ents[t]["name"].lower()
        targetVerbatim.append(bool(matcher(tvname).search(f"{d['title']} {d['abstract']}".lower())))

n = len(strict["NAME"])
def hit(ranks, k):
    return [1 if r <= k else 0 for r in ranks]
def R(ranks, k):
    return sum(hit(ranks, k)) / len(ranks)

print("\n=== INDEPENDENT REPRODUCTION ===", flush=True)
print(f"n = {n}")
print(f"exact score ties at target (any arm/config): {tie_at_target}")
print(f"ARM-NAME strict R@10 = {R(strict['NAME'],10):.20f}")
print(f"ARM-DESC strict R@10 = {R(strict['DESC'],10):.20f}")
print(f"ARM-NAME cond(min3) R@10 = {R(cond['min3']['NAME'],10):.20f}")
print(f"ARM-DESC cond(min3) R@10 = {R(cond['min3']['DESC'],10):.20f}")

dStrict = R(strict["DESC"], 10) - R(strict["NAME"], 10)
dCond = R(cond["min3"]["DESC"], 10) - R(cond["min3"]["NAME"], 10)
print(f"Delta strict    = {dStrict:.20f}")
print(f"Delta condensed = {dCond:.20f}")
print(f"SHIFT           = {dCond - dStrict:.20f}")

# condensed >= strict everywhere check
print("\n=== cond >= strict at all k, both arms ===")
viol = 0
for arm in ("NAME", "DESC"):
    for k in (1, 5, 10, 20):
        s = R(strict[arm], k)
        cc = R(cond["min3"][arm], k)
        flag = "OK" if cc >= s - 1e-12 else "VIOLATION"
        if cc < s - 1e-12:
            viol += 1
        print(f"  {arm} R@{k}: strict {s:.4f} -> cond {cc:.4f}  {flag}")
print("violations:", viol)

# per-corpus
print("\n=== per corpus R@10 (min3) ===")
for c in CORPORA:
    idxs = [i for i in range(n) if corpusOf[i] == c]
    def Rc(ranks, k):
        return sum(1 for i in idxs if ranks[i] <= k) / len(idxs)
    sN = Rc(strict["NAME"], 10); sD = Rc(strict["DESC"], 10)
    cN = Rc(cond["min3"]["NAME"], 10); cD = Rc(cond["min3"]["DESC"], 10)
    print(f"  {c}: n={len(idxs)} NAME s{sN:.4f}/c{cN:.4f} DESC s{sD:.4f}/c{cD:.4f} "
          f"Dstrict {sD-sN:+.4f} Dcond {cD-cN:+.4f} shift {(cD-cN)-(sD-sN):+.4f}")

# per-k pooled
print("\n=== per-k pooled ===")
for k in (1, 5, 10, 20):
    print(f"  R@{k}: NAME {R(strict['NAME'],k):.4f}->{R(cond['min3']['NAME'],k):.4f}  "
          f"DESC {R(strict['DESC'],k):.4f}->{R(cond['min3']['DESC'],k):.4f}")

# sensitivity: cond R@10 and shift point estimate at each config
print("\n=== sensitivity (cond R@10, shift point est) ===")
for lab, minLen, multiOnly in CONFIGS:
    nB = 0; cntdoc = 0
    for c in CORPORA:
        for docId in set(p[1] for p in pairs if p[2] == c):
            nB += len(tierBset(f"{c}#{docId}", minLen, multiOnly)); cntdoc += 1
    cN = R(cond[lab]["NAME"], 10); cD = R(cond[lab]["DESC"], 10)
    dC = cD - cN
    print(f"  {lab}: meanTierB/doc {nB/cntdoc:.1f}  NAMEcond {cN:.6f}  DESCcond {cD:.6f}  shift {dC - dStrict:+.6f}")

# miss-mass
print("\n=== miss-mass (min3) ===")
for arm in ("NAME", "DESC"):
    for c in CORPORA:
        rows = [r for r in missrows if r[0] == arm and r[1] == c]
        rec = [r for r in recovered[arm] if r[2] == c]
        sm = sum(1 for r in rec if r[0] == 1)
        rc = sum(1 for r in rec if r[1] == 1)
        aO = sum(r[2] for r in rows)/len(rows) if rows else 0
        bC = sum(r[3] for r in rows)/len(rows) if rows else 0
        cC = sum(r[4] for r in rows)/len(rows) if rows else 0
        print(f"  {arm}/{c} misses={len(rows)} TierA(o) {aO:.2f} TierB {bC:.2f} TierC {cC:.2f} | recovered {rc}/{sm}")

print(f"\ntarget-verbatim rate: {sum(targetVerbatim)/n*100:.1f}%")

# ---- bootstrap (mulberry32 replicated) ----
def mulberry32(seed):
    a = seed & 0xFFFFFFFF
    def rnd():
        nonlocal a
        a = (a + 0x6d2b79f5) & 0xFFFFFFFF
        t = (a ^ (a >> 15)) & 0xFFFFFFFF
        t = (t * ((1 | a) & 0xFFFFFFFF)) & 0xFFFFFFFF
        t2 = (t ^ (t >> 7)) & 0xFFFFFFFF
        t2 = (t2 * ((61 | t) & 0xFFFFFFFF)) & 0xFFFFFFFF
        t = (((t + t2) & 0xFFFFFFFF) ^ t) & 0xFFFFFFFF
        return (((t ^ (t >> 14)) & 0xFFFFFFFF)) / 4294967296
    return rnd

def clustered_bootstrap(a, b, clusterOf, resamples=10000, seed=20260831):
    byc = {}
    for i, c in enumerate(clusterOf):
        byc.setdefault(c, []).append(i)
    clusters = list(byc.values())
    delta = (sum(a)/len(a)) - (sum(b)/len(b))
    rnd = mulberry32(seed)
    deltas = []
    nc = len(clusters)
    for r in range(resamples):
        sa = sb = 0.0; nn = 0
        for _ in range(nc):
            pick = clusters[int(rnd() * nc)]
            for i in pick:
                sa += a[i]; sb += b[i]; nn += 1
        deltas.append((sa/nn - sb/nn) if nn else 0.0)
    deltas.sort()
    return delta, deltas[int(0.025*resamples)], deltas[int(0.975*resamples)-1]

hNs = hit(strict["NAME"], 10); hDs = hit(strict["DESC"], 10)
hNc = hit(cond["min3"]["NAME"], 10); hDc = hit(cond["min3"]["DESC"], 10)
dS = [hDs[i]-hNs[i] for i in range(n)]
dC = [hDc[i]-hNc[i] for i in range(n)]
pairKeys = [str(i) for i in range(n)]

print("\n=== bootstrap CIs (byPair) ===")
d,lo,hi = clustered_bootstrap(hDs, hNs, pairKeys); print(f"  Dstrict    {d:+.6f} [{lo:+.6f}, {hi:+.6f}]")
d,lo,hi = clustered_bootstrap(hDc, hNc, pairKeys); print(f"  Dcond      {d:+.6f} [{lo:+.6f}, {hi:+.6f}]")
d,lo,hi = clustered_bootstrap(dC, dS, pairKeys);   print(f"  SHIFT      {d:+.6f} [{lo:+.6f}, {hi:+.6f}]")
d,lo,hi = clustered_bootstrap(dC, dS, entityOf);   print(f"  SHIFT(ent) {d:+.6f} [{lo:+.6f}, {hi:+.6f}]")
d,lo,hi = clustered_bootstrap(dC, dS, docOf);      print(f"  SHIFT(doc) {d:+.6f} [{lo:+.6f}, {hi:+.6f}]")

# per-corpus shift CI (dal-cv, the "lands on 0" one)
for c in CORPORA:
    idxs = [i for i in range(n) if corpusOf[i] == c]
    dCc = [dC[i] for i in idxs]; dSc = [dS[i] for i in idxs]
    keys = [str(i) for i in idxs]
    hDcc=[hDc[i] for i in idxs]; hNcc=[hNc[i] for i in idxs]
    d,lo,hi = clustered_bootstrap(dCc, dSc, keys)
    dd,dlo,dhi = clustered_bootstrap(hDcc, hNcc, keys)
    print(f"  [{c}] shift {d:+.6f} [{lo:+.6f},{hi:+.6f}]  Dcond {dd:+.6f} [{dlo:+.6f},{dhi:+.6f}]")
