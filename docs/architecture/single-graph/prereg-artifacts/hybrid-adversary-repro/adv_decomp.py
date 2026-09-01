import json, re, math, os

ROOT = r"C:\Users\bruce.mckay\dev\nmemo"
ARC  = os.path.join(ROOT, "docs/architecture/cross-corpus-audit/multihop-artifacts")
CORP = os.path.join(ROOT, "docs/architecture/cross-corpus-audit/convergence-artifacts")
OUT  = os.path.join(ROOT, "docs/architecture/single-graph/prereg-artifacts")
SCR  = r"C:\Users\bruce.mckay\AppData\Local\Temp\claude\C--Users-bruce-mckay-dev-nmemo\fac01e71-246c-4396-9db4-90ccdc6915e8\scratchpad"
CORPORA = ["dal-nlp", "dal-cv"]
DOC_FILE = {"dal-nlp": "corpus-A.json", "dal-cv": "corpus-B.json"}
K_VALUES = [10, 30, 60, 100]; HEADLINE_K = 60
BM25_K1, BM25_B = 1.2, 0.75

cache = json.load(open(os.path.join(OUT, "embed-cache.json"), encoding="utf-8"))
def tokenise(t): return [x for x in re.split(r"[^a-z0-9]+", t.lower()) if x]
def matcher(name): return re.compile(r"(?<![a-z0-9])" + re.escape(name) + r"(?![a-z0-9])")
def dot(a, b):
    s = 0.0
    for i in range(len(a)): s += a[i]*b[i]
    return s

docsById={}; entsByCorpus={}; attrByCorpus={}; pairs=[]
for c in CORPORA:
    for d in json.load(open(os.path.join(CORP, DOC_FILE[c]), encoding="utf-8")): docsById[d["id"]]=d
    attr = json.load(open(os.path.join(ARC, f"attribution-{c}.json"), encoding="utf-8"))["paperToEntities"]
    attrByCorpus[c]=attr
    order = json.load(open(os.path.join(ARC, f"ingest-ledger-{c}.json"), encoding="utf-8"))
    pos={id:i for i,id in enumerate(order)}
    e2p={}
    for paper,ents in attr.items():
        for e in ents: e2p.setdefault(e,[]).append(paper)
    for entityId,ps in e2p.items():
        uniq=[p for p in dict.fromkeys(ps) if p in docsById and p in pos]
        if len(uniq)<2: continue
        uniq.sort(key=lambda p: pos[p])
        for docId in uniq[1:]: pairs.append((entityId,docId,c))
    entsByCorpus[c]=json.load(open(os.path.join(SCR, f"ents-{c}.json"), encoding="utf-8"))

def build_bm25(names):
    dt=[tokenise(x) for x in names]; dl=[len(t) for t in dt]; avg=sum(dl)/max(1,len(dl))
    df={}
    for toks in dt:
        for t in set(toks): df[t]=df.get(t,0)+1
    tf=[]
    for toks in dt:
        m={}
        for t in toks: m[t]=m.get(t,0)+1
        tf.append(m)
    return dl,avg,df,tf,len(names)
def bm25_scores(idx,query):
    dl,avg,df,tf,n=idx; out=[0.0]*n
    for q in set(tokenise(query)):
        dfq=df.get(q)
        if not dfq: continue
        idf=math.log(1+(n-dfq+0.5)/(dfq+0.5))
        for d in range(n):
            f=tf[d].get(q)
            if not f: continue
            out[d]+=idf*((f*(BM25_K1+1))/(f+BM25_K1*(1-BM25_B+BM25_B*(dl[d]/avg))))
    return out
def rank_by_score(scores,min_score=-math.inf):
    idx=[i for i in range(len(scores)) if scores[i]>min_score]
    idx.sort(key=lambda i:(-scores[i],i))
    return idx
def rrf_ret(rk,K,U):
    s=[0.0]*U
    for r in rk:
        for i in range(len(r)): s[r[i]]+=1.0/(K+i+1)
    return s
def rrf_full(rk,K,U):
    s=[0.0]*U
    for r in rk:
        ro=[len(r)]*U
        for i in range(len(r)): ro[r[i]]=i
        for u in range(U): s[u]+=1.0/(K+ro[u]+1)
    return s

# relevant sets
relByKey={}; tierA={}; tierB={}
for c in CORPORA:
    ents=entsByCorpus[c]; idxOf={e["id"]:i for i,e in enumerate(ents)}
    matchers=[None if len((e["name"] or "").strip())<3 else (i,matcher((e["name"]).strip().lower())) for i,e in enumerate(ents)]
    for p in [q for q in pairs if q[2]==c]:
        docId=p[1]; key=f"{c}#{docId}"
        if key in relByKey: continue
        d=docsById[docId]; text=f"{d['title']} {d['abstract']}".lower()
        rel=set(); a=set(); b=set()
        for eid in attrByCorpus[c].get(docId,[]):
            i=idxOf.get(eid)
            if i is not None: rel.add(i); a.add(i)
        for m in matchers:
            if m is None: continue
            i,re_=m
            if i in rel: continue
            if re_.search(text): rel.add(i); b.add(i)
        relByKey[key]=rel; tierA[key]=a; tierB[key]=b

# rank arms, keep detail
rows=[]  # per pair dict
for c in CORPORA:
    ents=entsByCorpus[c]; idxOf={e["id"]:i for i,e in enumerate(ents)}
    vName=[cache[e["name"]] for e in ents]
    bmIdx=build_bm25([e["name"] for e in ents]); U=len(ents)
    for p in [q for q in pairs if q[2]==c]:
        entityId,docId,_=p; t=idxOf[entityId]
        d=docsById[docId]; qtext=f"{d['title']} {d['abstract']}"; qv=cache[qtext]
        key=f"{c}#{docId}"; rel=relByKey[key]
        dense=[dot(qv,v) for v in vName]
        rName=rank_by_score(dense)
        bm=bm25_scores(bmIdx,qtext); rBmN=rank_by_score(bm,0)
        h60s=rrf_ret([rName,rBmN],60,U); rH60=rank_by_score(h60s,0)
        hf=rank_by_score(rrf_full([rName,rBmN],60,U))
        h10=rank_by_score(rrf_ret([rName,rBmN],10,U),0)
        def srank(r):
            try: return r.index(t)+1
            except ValueError: return math.inf
        def crank(r):
            try: pT=r.index(t)
            except ValueError: return math.inf
            ab=sum(1 for x in r[:pT] if x!=t and x not in rel)
            return ab+1
        rows.append(dict(c=c,t=t,key=key,rel=rel,tierA=tierA[key],tierB=tierB[key],U=U,
                         rName=rName,rBmN=rBmN,rH60=rH60,rHF=hf,rH10=h10,
                         h60scores=h60s,dense=dense,bm=bm,
                         sName=srank(rName),sBm=srank(rBmN),sH60=srank(rH60),sHF=srank(hf),sH10=srank(h10),
                         cName=crank(rName),cBm=crank(rBmN),cH60=crank(rH60)))

n=len(rows)
def R(field,k): return sum(1 for r in rows if r[field]<=k)/n
print(f"n={n}")

# ---- retrieved-set vs full-ranking per-pair identity ----
diff_hit=sum(1 for r in rows if (r["sH60"]<=10)!=(r["sHF"]<=10))
diff_rank=sum(1 for r in rows if r["sH60"]!=r["sHF"])
print(f"\n[retrieved vs full RRF60] top-10 hit differs on {diff_hit}/{n} pairs; strict-rank differs on {diff_rank}/{n} pairs")

# ---- H retrieved set size == universe? (score>0 cutoff no-op for H) ----
full=sum(1 for r in rows if len([x for x in r["h60scores"] if x>0])==r["U"])
print(f"[score>0 cutoff] H60 retrieves ALL entities (cutoff is a no-op) on {full}/{n} pairs")

# ---- tie-break sensitivity: does target hit depend on index-asc tie-break? ----
def hit_with_tiebreak(scores,t,k,desc=False):
    # rank by score desc; tie-break index asc (desc=False) or index desc (desc=True)
    idx=[i for i in range(len(scores)) if scores[i]>0]
    idx.sort(key=lambda i:(-scores[i], -i if desc else i))
    try: return (idx.index(t)+1)<=k
    except ValueError: return False
tb_flip=0; tb_tie_at_target=0
for r in rows:
    sc=r["h60scores"]; t=r["t"]
    a=hit_with_tiebreak(sc,t,10,desc=False)
    b=hit_with_tiebreak(sc,t,10,desc=True)
    if a!=b: tb_flip+=1
    # tie at target's score
    st=sc[t]
    if sum(1 for x in sc if x==st)>1: tb_tie_at_target+=1
print(f"[H60 tie-break] target top-10 hit flips under index-desc tie-break on {tb_flip}/{n} pairs; exact score-tie at target on {tb_tie_at_target}/{n}")
# dense exact ties at target
dtie=0
for r in rows:
    st=r["dense"][r["t"]]
    if sum(1 for x in r["dense"] if x==st)>1: dtie+=1
print(f"[dense] exact cosine-tie at target on {dtie}/{n} pairs")

# ---- McNemar discordance H10 vs NAME and H60 vs NAME (strict R@10) ----
def mcnemar(field):
    hwin=lwin=0
    for r in rows:
        h=r[field]<=10; nm=r["sName"]<=10
        if h and not nm: hwin+=1
        elif nm and not h: lwin+=1
    return hwin,lwin
for f,lab in (("sH10","H10"),("sH60","H60")):
    hw,lw=mcnemar(f)
    print(f"[McNemar {lab} vs NAME strict10] {lab} rescues {hw}, breaks {lw}, net +{hw-lw} (={ (hw-lw)/n:+.4f})")

# ---- Tier decomposition on strict-missed targets: top-10 slot composition ----
def decomp(field_rank, field_ranking):
    A=B=C=0; misses=0; recov_cond=0
    for r in rows:
        if r[field_rank]<=10: continue  # only strict misses
        misses+=1
        rk=r[field_ranking]; t=r["t"]; rel=r["rel"]; ta=r["tierA"]; tb=r["tierB"]
        for i in rk[:10]:
            if i==t: continue
            if i in ta: A+=1
            elif i in tb: B+=1
            else: C+=1
        # would condensation (ignore rel above) recover it into top-10?
        try: pT=rk.index(t)
        except ValueError: pT=-1
        if pT>=0:
            ab=sum(1 for x in rk[:pT] if x!=t and x not in rel)
            if ab+1<=10: recov_cond+=1
    return misses,A,B,C,recov_cond
for lab,fr,frk in (("BM25n","sBm","rBmN"),("H60","sH60","rH60"),("NAME","sName","rName")):
    m,A,B,C,rc=decomp(fr,frk)
    tot=A+B+C
    print(f"\n[{lab}] strict-misses={m}; top-10 non-target slots over misses: "
          f"TierA-other={A} ({A/tot*100:.0f}%) TierB={B} ({B/tot*100:.0f}%) TierC={C} ({C/tot*100:.0f}%)")
    print(f"       strict-missed targets RECOVERED by condensation (cond<=10): {rc}/{m}")

# ---- condensed R@10 recovery accounting per arm ----
print("\n=== condensed vs strict R@10 (recovery) ===")
for lab,sf,cf in (("NAME","sName","cName"),("BM25n","sBm","cBm"),("H60","sH60","cH60")):
    sh=sum(1 for r in rows if r[sf]<=10); ch=sum(1 for r in rows if r[cf]<=10)
    both=sum(1 for r in rows if r[sf]<=10 and r[cf]<=10)
    rec=sum(1 for r in rows if r[sf]>10 and r[cf]<=10)
    lost=sum(1 for r in rows if r[sf]<=10 and r[cf]>10)
    print(f"  {lab:6s} strict {sh}({sh/n:.4f}) -> cond {ch}({ch/n:.4f}); recovered {rec}, lost {lost}")

# ---- how much of condensed recovery is due to Tier-B specifically (vs Tier-A-other) ----
print("\n=== condensed recovery: driven by Tier-B or Tier-A-other above target? (arm=BM25n, H60, NAME) ===")
for lab,sf,frk in (("BM25n","sBm","rBmN"),("H60","sH60","rH60"),("NAME","sName","rName")):
    only_b=0; only_a=0; mixed=0; total_rec=0
    for r in rows:
        if not (r[sf]>10): continue
        rk=r[frk]; t=r["t"]; rel=r["rel"]; ta=r["tierA"]; tb=r["tierB"]
        try: pT=rk.index(t)
        except ValueError: continue
        ab=sum(1 for x in rk[:pT] if x!=t and x not in rel)
        if ab+1>10: continue
        total_rec+=1
        # among relevant entities above target, count tierA-other vs tierB
        aAbove=sum(1 for x in rk[:pT] if x!=t and x in ta)
        bAbove=sum(1 for x in rk[:pT] if x!=t and x in tb)
        if bAbove>0 and aAbove==0: only_b+=1
        elif aAbove>0 and bAbove==0: only_a+=1
        else: mixed+=1
    print(f"  {lab:6s} recovered={total_rec}: forgiven-above only-TierB={only_b} only-TierA={only_a} mixed/both={mixed}")
