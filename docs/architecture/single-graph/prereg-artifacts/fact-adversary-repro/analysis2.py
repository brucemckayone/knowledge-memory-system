import json, re, math, os, sys, io
import numpy as np
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = r"C:\Users\bruce.mckay\dev\nmemo"
ARC  = os.path.join(ROOT, "docs/architecture/cross-corpus-audit/multihop-artifacts")
CORP = os.path.join(ROOT, "docs/architecture/cross-corpus-audit/convergence-artifacts")
OUT  = os.path.join(ROOT, "docs/architecture/single-graph/prereg-artifacts")
SCR  = os.path.dirname(os.path.abspath(__file__))
CORPORA = ["dal-nlp", "dal-cv"]
DOC_FILE = {"dal-nlp": "corpus-A.json", "dal-cv": "corpus-B.json"}

cache = json.load(open(os.path.join(OUT,"embed-cache.json"),encoding="utf-8"))
def load_ents(c):
    ents=[]
    for line in open(os.path.join(SCR,f"ents-{c}.tsv"),encoding="utf-8"):
        line=line.rstrip("\n")
        if not line: continue
        p=line.split("\t"); ents.append({"id":p[0],"name":p[1] if len(p)>1 else ""})
    return ents
def load_facts(c):
    ids=[];subj=[];obj=[];vecs=[]
    for line in open(os.path.join(SCR,f"facts-{c}.tsv"),encoding="utf-8"):
        line=line.rstrip("\n")
        if not line: continue
        fid,s,o,emb=line.split("\t")
        vecs.append(np.fromstring(emb.strip().lstrip("[").rstrip("]"),sep=",",dtype=np.float64))
        ids.append(fid);subj.append(s);obj.append(o)
    return ids,subj,obj,vecs
def matcher(name):
    return re.compile(r"(?<![a-z0-9])"+re.escape(name)+r"(?![a-z0-9])")

docsById={}; entsByCorpus={}; attrByCorpus={}; f2pByCorpus={}; pairs=[]
for c in CORPORA:
    for d in json.load(open(os.path.join(CORP,DOC_FILE[c]),encoding="utf-8")): docsById[d["id"]]=d
    af=json.load(open(os.path.join(ARC,f"attribution-{c}.json"),encoding="utf-8"))
    attrByCorpus[c]=af["paperToEntities"]; f2pByCorpus[c]=af["factToPaper"]
    order=json.load(open(os.path.join(ARC,f"ingest-ledger-{c}.json"),encoding="utf-8"))
    pos={id:i for i,id in enumerate(order)}
    e2p={}
    for paper,ents in af["paperToEntities"].items():
        for e in ents: e2p.setdefault(e,[]).append(paper)
    for eid,ps in e2p.items():
        uniq=[p for p in dict.fromkeys(ps) if p in docsById and p in pos]
        if len(uniq)<2: continue
        uniq.sort(key=lambda p:pos[p])
        for docId in uniq[1:]: pairs.append((eid,docId,c))
    entsByCorpus[c]=load_ents(c)

relevantByKey={}
for c in CORPORA:
    ents=entsByCorpus[c]; idxOf={e["id"]:i for i,e in enumerate(ents)}
    matchers=[None if len((e["name"] or "").strip())<3 else (i,matcher(e["name"].strip().lower())) for i,e in enumerate(ents)]
    attr=attrByCorpus[c]
    for p in [q for q in pairs if q[2]==c]:
        docId=p[1]; key=f"{c}#{docId}"
        if key in relevantByKey: continue
        d=docsById[docId]; text=f"{d['title']} {d['abstract']}".lower(); rel=set()
        for eid in attr.get(docId,[]):
            i=idxOf.get(eid)
            if i is not None: rel.add(i)
        for m in matchers:
            if m is None: continue
            i,re_=m
            if i in rel: continue
            if re_.search(text): rel.add(i)
        relevantByKey[key]=rel

def rank_by_score(scores,min_score=-math.inf):
    idx=[i for i in range(len(scores)) if scores[i]>min_score]
    idx.sort(key=lambda i:(-scores[i],i)); return idx
def rrf_retrieved(rankings,K,U):
    s=[0.0]*U
    for r in rankings:
        for i in range(len(r)): s[r[i]]+=1.0/(K+i+1)
    return s
def srank(r,t):
    try: return r.index(t)+1
    except ValueError: return math.inf
def crank(r,t,rel):
    try: posT=r.index(t)
    except ValueError: return math.inf
    return sum(1 for x in range(posT) if r[x]!=t and r[x] not in rel)+1

# score with a chosen guard: exclude_unmapped True => also drop paper==''
def run(exclude_unmapped):
    tab={a:{"s":[],"c":[]} for a in ["NAME","FACTMAX","FACTNAME"]}
    corpusOf=[]; entityOf=[]; docOf=[]
    # per-pair component-hit bookkeeping for fusion decomposition
    comp=[]
    for c in CORPORA:
        ents=entsByCorpus[c]; idxOf={e["id"]:i for i,e in enumerate(ents)}; U=len(ents)
        vName=np.array([cache[e["name"]] for e in ents])
        ids,subj,obj,vecs=load_facts(c); f2p=f2pByCorpus[c]
        F=[];paper=[];entFacts={}
        for k in range(len(ids)):
            v=vecs[k]
            if v.shape[0]!=768 or not np.all(np.isfinite(v)): continue
            rn=np.sqrt(np.dot(v,v)); nv=v/rn if rn!=0 else v
            fi=len(F); F.append(nv); paper.append(f2p.get(ids[k],""))
            for e in (subj[k],obj[k]):
                ei=idxOf.get(e)
                if ei is not None: entFacts.setdefault(ei,[]).append(fi)
        F=np.array(F)
        for p in [q for q in pairs if q[2]==c]:
            eid,docId,_=p; t=idxOf.get(eid)
            if t is None: continue
            d=docsById[docId]; qv=np.array(cache[f"{d['title']} {d['abstract']}"]); rel=relevantByKey[f"{c}#{docId}"]
            fscore=F@qv; nscore=vName@qv
            entMax=[-math.inf]*U
            for ei,fidxs in entFacts.items():
                for fi in fidxs:
                    if paper[fi]==docId: continue
                    if exclude_unmapped and paper[fi]=="": continue
                    sc=float(fscore[fi])
                    if sc>entMax[ei]: entMax[ei]=sc
            rName=rank_by_score([float(x) for x in nscore])
            rFactMax=rank_by_score(entMax,-math.inf)
            rFactName=rank_by_score(rrf_retrieved([rName,rFactMax],60,U),0)
            tab["NAME"]["s"].append(srank(rName,t)); tab["NAME"]["c"].append(crank(rName,t,rel))
            tab["FACTMAX"]["s"].append(srank(rFactMax,t)); tab["FACTMAX"]["c"].append(crank(rFactMax,t,rel))
            tab["FACTNAME"]["s"].append(srank(rFactName,t)); tab["FACTNAME"]["c"].append(crank(rFactName,t,rel))
            corpusOf.append(c); entityOf.append(eid); docOf.append(docId)
            comp.append((srank(rName,t),srank(rFactMax,t),srank(rFactName,t)))
    return tab,corpusOf,entityOf,docOf,comp

def mean(xs): return sum(xs)/len(xs) if xs else float('nan')
def hit(rlist,k): return [1 if r<=k else 0 for r in rlist]
def mulberry32(seed):
    a=[seed&0xFFFFFFFF]
    def rnd():
        a[0]=(a[0]+0x6d2b79f5)&0xFFFFFFFF
        x=(a[0]^(a[0]>>15))&0xFFFFFFFF; t=(x*((1|a[0])&0xFFFFFFFF))&0xFFFFFFFF
        y=(t^(t>>7))&0xFFFFFFFF; z=(y*((61|t)&0xFFFFFFFF))&0xFFFFFFFF
        t=(((t+z)&0xFFFFFFFF)^t)&0xFFFFFFFF
        return ((t^(t>>14))&0xFFFFFFFF)/4294967296
    return rnd
def boot(a,b,clusterOf,resamples=10000,seed=20260831):
    byc={}
    for i,cc in enumerate(clusterOf): byc.setdefault(cc,[]).append(i)
    clusters=list(byc.values()); nc=len(clusters)
    delta=mean(a)-mean(b); rnd=mulberry32(seed); deltas=[]
    for _ in range(resamples):
        sa=sb=0.0; nn=0
        for _ in range(nc):
            pick=clusters[int(rnd()*nc)]
            for i in pick: sa+=a[i];sb+=b[i];nn+=1
        deltas.append((sa/nn-sb/nn) if nn else 0.0)
    deltas.sort(); return delta,deltas[int(0.025*resamples)],deltas[int(0.975*resamples)-1]
def verdict(lo,hi): return "ABOVE 0" if lo>0 else ("BELOW 0" if hi<0 else "SPANS 0")

# ---------- EXACT byEntity strict CI for FACTNAME (lenient guard) ----------
tab,corpusOf,entityOf,docOf,comp=run(exclude_unmapped=False)
n=len(tab["NAME"]["s"])
fn=hit(tab["FACTNAME"]["s"],10); nm=hit(tab["NAME"]["s"],10)
for lab,cl in (("byPair",[str(i) for i in range(n)]),("byEntity",entityOf),("byDocument",docOf)):
    d,lo,hi=boot(fn,nm,cl)
    print(f"FACTNAME-NAME strict {lab:10s} delta={d:+.8f} lo={lo:+.8f} hi={hi:+.8f} {verdict(lo,hi)}")
print()
# ---------- fusion decomposition ----------
print("=== FUSION DECOMPOSITION (lenient guard, strict R@10) ===")
nHit=sum(1 for (rn,rf,rfn) in comp if rn<=10)
fHit=sum(1 for (rn,rf,rfn) in comp if rf<=10)
fnHit=sum(1 for (rn,rf,rfn) in comp if rfn<=10)
both=sum(1 for (rn,rf,rfn) in comp if rn<=10 and rf<=10)
nonly=sum(1 for (rn,rf,rfn) in comp if rn<=10 and rf>10)
fonly=sum(1 for (rn,rf,rfn) in comp if rf<=10 and rn>10)
print(f"  NAME@10 hits={nHit}  FACTMAX@10 hits={fHit}  FACTNAME@10 hits={fnHit}  (n={n})")
print(f"  target in both top10={both}  NAME-only={nonly}  FACTMAX-only={fonly}")
# FACTNAME wins = pairs FACTNAME hits that NAME missed
fn_gain=[(rn,rf,rfn) for (rn,rf,rfn) in comp if rfn<=10 and rn>10]
fn_lost=[(rn,rf,rfn) for (rn,rf,rfn) in comp if rfn>10 and rn<=10]
print(f"  FACTNAME rescues (FN<=10, NAME>10)={len(fn_gain)}   FACTNAME loses (FN>10, NAME<=10)={len(fn_lost)}   net={len(fn_gain)-len(fn_lost)}")
# of the rescues, how many did FACTMAX have in top10 (so RRF pulled a real FACTMAX signal in)
resc_fmax_top10=sum(1 for (rn,rf,rfn) in fn_gain if rf<=10)
resc_fmax_top20=sum(1 for (rn,rf,rfn) in fn_gain if rf<=20)
print(f"  of {len(fn_gain)} rescues: FACTMAX had target@<=10 in {resc_fmax_top10}, @<=20 in {resc_fmax_top20}")
# of the losses, where did NAME have it and FACTMAX
print(f"  losses detail (NAME rank, FACTMAX rank): {[(rn,rf) for (rn,rf,rfn) in fn_lost]}")
print()

# ---------- STRICT GUARD (drop unmapped) robustness ----------
print("=== STRICT-GUARD ROBUSTNESS (also exclude unmapped paper=='' facts) ===")
tab2,corpusOf2,entityOf2,docOf2,comp2=run(exclude_unmapped=True)
n2=len(tab2["NAME"]["s"])
print(f"  n={n2}")
for a in ["NAME","FACTMAX","FACTNAME"]:
    print(f"  {a:9s} strict R@10 {mean(hit(tab2[a]['s'],10)):.6f}  cond R@10 {mean(hit(tab2[a]['c'],10)):.6f}")
pk=[str(i) for i in range(n2)]
for lab,a,tbl in (("FACTMAX-NAME strict","FACTMAX","s"),("FACTNAME-NAME strict","FACTNAME","s"),("FACTNAME-NAME cond","FACTNAME","c")):
    d,lo,hi=boot(hit(tab2[a][tbl],10),hit(tab2["NAME"][tbl],10),pk)
    print(f"  {lab:22s} {d:+.6f} [{lo:+.6f},{hi:+.6f}] {verdict(lo,hi)}")
# entity/doc cluster for FACTNAME strict under strict guard
for lab,cl in (("byEntity",entityOf2),("byDocument",docOf2)):
    d,lo,hi=boot(hit(tab2["FACTNAME"]["s"],10),hit(tab2["NAME"]["s"],10),cl)
    print(f"  FACTNAME-NAME strict {lab:10s} {d:+.6f} [{lo:+.6f},{hi:+.6f}] {verdict(lo,hi)}")

# how many pairs changed FACTNAME@10 status between lenient and strict guard?
fn_lenient=hit(tab["FACTNAME"]["s"],10); fn_strict=hit(tab2["FACTNAME"]["s"],10)
changed=sum(1 for i in range(n) if fn_lenient[i]!=fn_strict[i])
print(f"  FACTNAME@10 status changed by dropping unmapped facts: {changed}/{n} pairs")
