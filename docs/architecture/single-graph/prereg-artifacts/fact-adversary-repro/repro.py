import json, re, math, os
import numpy as np

ROOT = r"C:\Users\bruce.mckay\dev\nmemo"
ARC  = os.path.join(ROOT, "docs/architecture/cross-corpus-audit/multihop-artifacts")
CORP = os.path.join(ROOT, "docs/architecture/cross-corpus-audit/convergence-artifacts")
OUT  = os.path.join(ROOT, "docs/architecture/single-graph/prereg-artifacts")
SCR  = os.path.dirname(os.path.abspath(__file__))
CORPORA = ["dal-nlp", "dal-cv"]
DOC_FILE = {"dal-nlp": "corpus-A.json", "dal-cv": "corpus-B.json"}

print("loading cache...", flush=True)
cache = json.load(open(os.path.join(OUT, "embed-cache.json"), encoding="utf-8"))
print("cache vectors:", len(cache), flush=True)

def matcher(name):
    esc = re.escape(name)
    return re.compile(r"(?<![a-z0-9])" + esc + r"(?![a-z0-9])")

# ---------- load entities from MY fresh DB dump (id order preserved) ----------
def load_ents(c):
    ents = []
    with open(os.path.join(SCR, f"ents-{c}.tsv"), encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line: continue
            parts = line.split("\t")
            eid = parts[0]; name = parts[1] if len(parts) > 1 else ""
            desc = parts[2] if len(parts) > 2 else ""
            ents.append({"id": eid, "name": name, "description": desc})
    return ents

# ---------- load facts from MY fresh DB dump ----------
def load_facts(c):
    ids=[]; subj=[]; obj=[]; vecs=[]
    with open(os.path.join(SCR, f"facts-{c}.tsv"), encoding="utf-8") as f:
        for line in f:
            line=line.rstrip("\n")
            if not line: continue
            fid, s, o, emb = line.split("\t")
            inner = emb.strip().lstrip("[").rstrip("]")
            v = np.fromstring(inner, sep=",", dtype=np.float64)
            ids.append(fid); subj.append(s); obj.append(o); vecs.append(v)
    return ids, subj, obj, vecs

# ---------- load docs, attribution, ledger, build pairs (same as harness) ----------
docsById = {}
entsByCorpus = {}
attrByCorpus = {}
factToPaperByCorpus = {}
pairs = []
for c in CORPORA:
    docs = json.load(open(os.path.join(CORP, DOC_FILE[c]), encoding="utf-8"))
    for d in docs:
        docsById[d["id"]] = d
    attrFull = json.load(open(os.path.join(ARC, f"attribution-{c}.json"), encoding="utf-8"))
    attr = attrFull["paperToEntities"]
    attrByCorpus[c] = attr
    factToPaperByCorpus[c] = attrFull["factToPaper"]
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
    entsByCorpus[c] = load_ents(c)

print("query pairs:", len(pairs), flush=True)

# ---------- cache coverage ----------
miss_ent=0; miss_q=0; badlen=0
for c in CORPORA:
    for e in entsByCorpus[c]:
        v = cache.get(e["name"])   # mode='name'
        if v is None: miss_ent += 1
        elif len(v) != 768: badlen += 1
for (eid,docId,c) in pairs:
    d = docsById[docId]
    if cache.get(f"{d['title']} {d['abstract']}") is None:
        miss_q += 1
print(f"cache coverage: missing entity name-vecs={miss_ent} missing query vecs={miss_q} wrong-len={badlen}", flush=True)

# ---------- relevant sets (Tier A + Tier B min-3) ----------
relevantByKey = {}
for c in CORPORA:
    ents = entsByCorpus[c]
    idxOf = {e["id"]: i for i, e in enumerate(ents)}
    matchers = []
    for i, e in enumerate(ents):
        nm = (e["name"] or "").strip()
        matchers.append(None if len(nm) < 3 else (i, matcher(nm.lower())))
    attr = attrByCorpus[c]
    for p in [q for q in pairs if q[2] == c]:
        docId = p[1]; key = f"{c}#{docId}"
        if key in relevantByKey: continue
        d = docsById[docId]
        text = f"{d['title']} {d['abstract']}".lower()
        rel = set()
        for eid in attr.get(docId, []):
            i = idxOf.get(eid)
            if i is not None: rel.add(i)
        for m in matchers:
            if m is None: continue
            i, re_ = m
            if i in rel: continue
            if re_.search(text): rel.add(i)
        relevantByKey[key] = rel

# ---------- build normalized fact matrices + per-entity membership ----------
factState = {}
rawNormSum=0.0; rawNormCount=0; dimViol=0; selfDotViol=0
for c in CORPORA:
    ents = entsByCorpus[c]
    idxOf = {e["id"]: i for i, e in enumerate(ents)}
    ids, subj, obj, vecs = load_facts(c)
    paper = []
    keptvecs = []
    entFacts = {}   # entity idx -> list of fact-row-index (into keptvecs)
    f2p = factToPaperByCorpus[c]
    fact_ids_kept = []
    for k in range(len(ids)):
        v = vecs[k]
        if v.shape[0] != 768 or not np.all(np.isfinite(v)):
            dimViol += 1; continue
        rn = float(np.sqrt(np.dot(v,v)))
        rawNormSum += rn; rawNormCount += 1
        nv = v / rn if rn != 0 else v.copy()
        if abs(float(np.dot(nv,nv)) - 1.0) > 1e-6: selfDotViol += 1
        fi = len(keptvecs)
        keptvecs.append(nv)
        paper.append(f2p.get(ids[k], ""))
        fact_ids_kept.append(ids[k])
        for eid in (subj[k], obj[k]):
            ei = idxOf.get(eid)
            if ei is not None:
                entFacts.setdefault(ei, []).append(fi)
    F = np.array(keptvecs, dtype=np.float64)  # (nfacts,768) normalized
    factState[c] = dict(F=F, paper=paper, entFacts=entFacts, fact_ids=fact_ids_kept, subj=subj, obj=obj, ids=ids)
    print(f"{c}: {len(ids)} active embedded facts, {len(entFacts)}/{len(ents)} entities with >=1 fact", flush=True)

print("\n=== integrity ===")
print(f"  dim/finite violations {dimViol}; mean RAW norm {rawNormSum/max(1,rawNormCount):.3f}; self-dot violations {selfDotViol}")

# ---------- rank helpers ----------
def rank_by_score(scores, min_score=-math.inf):
    idx = [i for i in range(len(scores)) if scores[i] > min_score]
    idx.sort(key=lambda i: (-scores[i], i))
    return idx

def rrf_retrieved(rankings, K, universe):
    s = [0.0]*universe
    for r in rankings:
        for i in range(len(r)):
            s[r[i]] += 1.0/(K + i + 1)
    return s

def strict_rank_of(ranking, t):
    try: return ranking.index(t)+1
    except ValueError: return math.inf

def condensed_rank_of(ranking, t, relevant):
    try: posT = ranking.index(t)
    except ValueError: return math.inf
    above=0
    for r in range(posT):
        i = ranking[r]
        if i==t: continue
        if i in relevant: continue
        above += 1
    return above+1

# ---------- score arms ----------
ARMS = ["NAME","FACTMAX","FACTMEAN","FACTNAME"]
strictRank = {a: [] for a in ARMS}
condRank   = {a: [] for a in ARMS}
corpusOf, entityOf, docOf = [], [], []
factmaxEqName = []
noEligibleFact = 0
pairsWithExclusion = 0
targetFactCount = []
targetFactMaxHit = []

for c in CORPORA:
    ents = entsByCorpus[c]
    idxOf = {e["id"]: i for i, e in enumerate(ents)}
    U = len(ents)
    vName = np.array([cache[e["name"]] for e in ents], dtype=np.float64)  # (U,768)
    fs = factState[c]
    F = fs["F"]; paper = fs["paper"]; entFacts = fs["entFacts"]
    for p in [q for q in pairs if q[2]==c]:
        entityId, docId, _ = p
        t = idxOf.get(entityId)
        if t is None: continue
        d = docsById[docId]
        qv = np.array(cache[f"{d['title']} {d['abstract']}"], dtype=np.float64)
        rel = relevantByKey[f"{c}#{docId}"]

        factScore = F @ qv           # (nfacts,)
        nameScore = vName @ qv       # (U,)

        entMax = [-math.inf]*U
        entSum = [0.0]*U
        entCnt = [0]*U
        excludedThisPair = 0
        for ei, fidxs in entFacts.items():
            for fi in fidxs:
                if paper[fi] == docId:
                    excludedThisPair += 1; continue
                sc = float(factScore[fi])
                if sc > entMax[ei]: entMax[ei] = sc
                entSum[ei] += sc; entCnt[ei] += 1
        if excludedThisPair > 0: pairsWithExclusion += 1
        entMean = [ (entSum[i]/entCnt[i]) if entCnt[i]>0 else -math.inf for i in range(U) ]

        rName = rank_by_score([float(x) for x in nameScore])
        rFactMax = rank_by_score(entMax, -math.inf)
        rFactMean = rank_by_score(entMean, -math.inf)
        rFactName = rank_by_score(rrf_retrieved([rName, rFactMax], 60, U), 0)

        strictRank["NAME"].append(strict_rank_of(rName, t)); condRank["NAME"].append(condensed_rank_of(rName, t, rel))
        strictRank["FACTMAX"].append(strict_rank_of(rFactMax, t)); condRank["FACTMAX"].append(condensed_rank_of(rFactMax, t, rel))
        strictRank["FACTMEAN"].append(strict_rank_of(rFactMean, t)); condRank["FACTMEAN"].append(condensed_rank_of(rFactMean, t, rel))
        strictRank["FACTNAME"].append(strict_rank_of(rFactName, t)); condRank["FACTNAME"].append(condensed_rank_of(rFactName, t, rel))

        if entCnt[t]==0: noEligibleFact += 1
        targetFactCount.append(entCnt[t])
        targetFactMaxHit.append(1 if strict_rank_of(rFactMax, t) <= 10 else 0)

        fTop=set(rFactMax[:10]); nTop=set(rName[:10])
        factmaxEqName.append(1 if fTop==nTop else 0)

        corpusOf.append(c); entityOf.append(entityId); docOf.append(docId)

n = len(strictRank["NAME"])
def hit(arm,k,table): return [1 if r<=k else 0 for r in table[arm]]
def hitS(arm,k): return hit(arm,k,strictRank)
def hitC(arm,k): return hit(arm,k,condRank)
def mean(xs): return sum(xs)/len(xs) if xs else float('nan')

print(f"\nn={n}")
print(f"pairsWithExclusion={pairsWithExclusion}  noEligibleFact={noEligibleFact}  factmaxEqName={mean(factmaxEqName)*100:.1f}%")
print("\n=== arms strict/condensed R@10 ===")
for a in ARMS:
    print(f"  {a:9s} strict {mean(hitS(a,10)):.10f}  cond {mean(hitC(a,10)):.10f}")

# ---------- bootstrap ----------
def mulberry32(seed):
    a=[seed & 0xFFFFFFFF]
    def rnd():
        a[0]=(a[0]+0x6d2b79f5)&0xFFFFFFFF
        x=(a[0]^(a[0]>>15))&0xFFFFFFFF
        t=(x*((1|a[0])&0xFFFFFFFF))&0xFFFFFFFF
        y=(t^(t>>7))&0xFFFFFFFF
        z=(y*((61|t)&0xFFFFFFFF))&0xFFFFFFFF
        t=(((t+z)&0xFFFFFFFF)^t)&0xFFFFFFFF
        return ((t^(t>>14))&0xFFFFFFFF)/4294967296
    return rnd

def clustered_bootstrap(a,b,clusterOf,resamples=10000,seed=20260831):
    byc={}
    for i,cc in enumerate(clusterOf): byc.setdefault(cc,[]).append(i)
    clusters=list(byc.values()); nc=len(clusters)
    delta=mean(a)-mean(b); rnd=mulberry32(seed); deltas=[]
    for _ in range(resamples):
        sa=sb=0.0; nn=0
        for _ in range(nc):
            pick=clusters[int(rnd()*nc)]
            for i in pick: sa+=a[i]; sb+=b[i]; nn+=1
        deltas.append((sa/nn - sb/nn) if nn else 0.0)
    deltas.sort()
    return delta, deltas[int(0.025*resamples)], deltas[int(0.975*resamples)-1]

def verdict(lo,hi): return "ABOVE 0" if lo>0 else ("BELOW 0" if hi<0 else "SPANS 0")

pairKeys=[str(i) for i in range(n)]
print("\n=== PRIMARY strict FACTMAX - NAME ===")
for lab,cl in (("byPair",pairKeys),("byEntity",entityOf),("byDocument",docOf)):
    d,lo,hi=clustered_bootstrap(hitS("FACTMAX",10),hitS("NAME",10),cl)
    print(f"  {lab:10s} {d:+.6f} [{lo:+.6f},{hi:+.6f}] {verdict(lo,hi)}")

print("\n=== secondaries (byPair) ===")
for lab,a,b,tbl in (("FACTMAX-NAME cond","FACTMAX","NAME",hitC),
                    ("FACTMEAN-NAME strict","FACTMEAN","NAME",hitS),
                    ("FACTNAME-NAME strict","FACTNAME","NAME",hitS),
                    ("FACTNAME-NAME cond","FACTNAME","NAME",hitC)):
    d,lo,hi=clustered_bootstrap(tbl(a,10),tbl(b,10),pairKeys)
    print(f"  {lab:24s} {d:+.6f} [{lo:+.6f},{hi:+.6f}] {verdict(lo,hi)}")

print("\n=== FACTNAME cluster bootstraps (NOT in harness) ===")
for orc,tbl in (("strict",hitS),("cond",hitC)):
    for lab,cl in (("byEntity",entityOf),("byDocument",docOf)):
        d,lo,hi=clustered_bootstrap(tbl("FACTNAME",10),tbl("NAME",10),cl)
        print(f"  FACTNAME-NAME {orc:6s} {lab:10s} {d:+.6f} [{lo:+.6f},{hi:+.6f}] {verdict(lo,hi)}")

print("\n=== FACTMAX cluster bootstraps for FACTNAME (degree inheritance) ===")
# already have primary above

print("\n=== k-ladder strict/cond ===")
for k in [1,5,10,20]:
    print(f"  R@{k:2d} NAME {mean(hitS('NAME',k)):.3f}/{mean(hitC('NAME',k)):.3f}  FACTMAX {mean(hitS('FACTMAX',k)):.3f}/{mean(hitC('FACTMAX',k)):.3f}  FACTNAME {mean(hitS('FACTNAME',k)):.3f}/{mean(hitC('FACTNAME',k)):.3f}")

print("\n=== FACTNAME - NAME strict at k-ladder (byPair) ===")
for k in [1,5,10,20]:
    d,lo,hi=clustered_bootstrap(hitS("FACTNAME",k),hitS("NAME",k),pairKeys)
    print(f"  R@{k:2d} {d:+.6f} [{lo:+.6f},{hi:+.6f}] {verdict(lo,hi)}")

print("\n=== per corpus FACTMAX-NAME strict ===")
for c in CORPORA:
    idx=[i for i in range(n) if corpusOf[i]==c]
    fh=[hitS("FACTMAX",10)[i] for i in idx]; nh=[hitS("NAME",10)[i] for i in idx]
    d,lo,hi=clustered_bootstrap(fh,nh,[str(i) for i in idx])
    print(f"  {c}: n={len(idx)} NAME {mean(nh):.3f} FACTMAX {mean(fh):.3f} {d:+.4f}[{lo:+.4f},{hi:+.4f}]{verdict(lo,hi)}")

print("\n=== per corpus FACTNAME-NAME strict ===")
for c in CORPORA:
    idx=[i for i in range(n) if corpusOf[i]==c]
    fh=[hitS("FACTNAME",10)[i] for i in idx]; nh=[hitS("NAME",10)[i] for i in idx]
    d,lo,hi=clustered_bootstrap(fh,nh,[str(i) for i in idx])
    print(f"  {c}: n={len(idx)} NAME {mean(nh):.3f} FACTNAME {mean(fh):.3f} {d:+.4f}[{lo:+.4f},{hi:+.4f}]{verdict(lo,hi)}")

# degree diagnostic
hitCounts=[targetFactCount[i] for i in range(n) if targetFactMaxHit[i]==1]
missCounts=[targetFactCount[i] for i in range(n) if targetFactMaxHit[i]==0]
print(f"\ndegree diagnostic: FACTMAX hits mean fact-count {mean(hitCounts):.3f} vs misses {mean(missCounts):.3f}")
