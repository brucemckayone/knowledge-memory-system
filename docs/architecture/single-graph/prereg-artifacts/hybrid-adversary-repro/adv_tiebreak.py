import json, re, math, os
ROOT = r"C:\Users\bruce.mckay\dev\nmemo"
ARC  = os.path.join(ROOT, "docs/architecture/cross-corpus-audit/multihop-artifacts")
CORP = os.path.join(ROOT, "docs/architecture/cross-corpus-audit/convergence-artifacts")
OUT  = os.path.join(ROOT, "docs/architecture/single-graph/prereg-artifacts")
SCR  = r"C:\Users\bruce.mckay\AppData\Local\Temp\claude\C--Users-bruce-mckay-dev-nmemo\fac01e71-246c-4396-9db4-90ccdc6915e8\scratchpad"
CORPORA=["dal-nlp","dal-cv"]; DOC_FILE={"dal-nlp":"corpus-A.json","dal-cv":"corpus-B.json"}
BM25_K1,BM25_B=1.2,0.75
cache=json.load(open(os.path.join(OUT,"embed-cache.json"),encoding="utf-8"))
def tok(t): return [x for x in re.split(r"[^a-z0-9]+",t.lower()) if x]
def dot(a,b):
    s=0.0
    for i in range(len(a)): s+=a[i]*b[i]
    return s
docsById={};entsByCorpus={};attrByCorpus={};pairs=[]
for c in CORPORA:
    for d in json.load(open(os.path.join(CORP,DOC_FILE[c]),encoding="utf-8")): docsById[d["id"]]=d
    attr=json.load(open(os.path.join(ARC,f"attribution-{c}.json"),encoding="utf-8"))["paperToEntities"];attrByCorpus[c]=attr
    order=json.load(open(os.path.join(ARC,f"ingest-ledger-{c}.json"),encoding="utf-8"));pos={id:i for i,id in enumerate(order)}
    e2p={}
    for paper,ents in attr.items():
        for e in ents: e2p.setdefault(e,[]).append(paper)
    for eid,ps in e2p.items():
        uniq=[p for p in dict.fromkeys(ps) if p in docsById and p in pos]
        if len(uniq)<2: continue
        uniq.sort(key=lambda p:pos[p])
        for docId in uniq[1:]: pairs.append((eid,docId,c))
    entsByCorpus[c]=json.load(open(os.path.join(SCR,f"ents-{c}.json"),encoding="utf-8"))

def build(names):
    dt=[tok(x) for x in names];dl=[len(t) for t in dt];avg=sum(dl)/max(1,len(dl));df={}
    for toks in dt:
        for t in set(toks): df[t]=df.get(t,0)+1
    tf=[]
    for toks in dt:
        m={}
        for t in toks: m[t]=m.get(t,0)+1
        tf.append(m)
    return dl,avg,df,tf,len(names)
def bmsc(idx,q):
    dl,avg,df,tf,n=idx;out=[0.0]*n
    for w in set(tok(q)):
        dfq=df.get(w)
        if not dfq: continue
        idf=math.log(1+(n-dfq+0.5)/(dfq+0.5))
        for d in range(n):
            f=tf[d].get(w)
            if not f: continue
            out[d]+=idf*((f*(BM25_K1+1))/(f+BM25_K1*(1-BM25_B+BM25_B*(dl[d]/avg))))
    return out

# rank with configurable tie-break: 'asc' index, 'desc' index, 'name-desc' longer text first (arbitrary alt)
def rank(scores, tie, mins=-math.inf):
    idx=[i for i in range(len(scores)) if scores[i]>mins]
    if tie=='asc': idx.sort(key=lambda i:(-scores[i], i))
    elif tie=='desc': idx.sort(key=lambda i:(-scores[i], -i))
    return idx
def rrf_ret(rk,K,U):
    s=[0.0]*U
    for r in rk:
        for i in range(len(r)): s[r[i]]+=1.0/(K+i+1)
    return s

# build per-pair hits for NAME and H under asc/desc tie-break
def run(tie):
    hitsN=[];hitsBm=[];hitsH10=[];hitsH60=[]
    for c in CORPORA:
        ents=entsByCorpus[c];idxOf={e["id"]:i for i,e in enumerate(ents)}
        vName=[cache[e["name"]] for e in ents];bmIdx=build([e["name"] for e in ents]);U=len(ents)
        for p in [q for q in pairs if q[2]==c]:
            eid,docId,_=p;t=idxOf[eid];d=docsById[docId];qv=cache[f"{d['title']} {d['abstract']}"]
            dense=[dot(qv,v) for v in vName]
            rN=rank(dense,tie)
            rB=rank(bmsc(bmIdx,f"{d['title']} {d['abstract']}"),tie,0)
            def hit(r,k):
                try: return 1 if r.index(t)+1<=k else 0
                except ValueError: return 0
            hitsN.append(hit(rN,10)); hitsBm.append(hit(rB,10))
            hitsH10.append(hit(rank(rrf_ret([rN,rB],10,U),tie,0),10))
            hitsH60.append(hit(rank(rrf_ret([rN,rB],60,U),tie,0),10))
    return hitsN,hitsBm,hitsH10,hitsH60

for tie in ('asc','desc'):
    hN,hB,h10,h60=run(tie)
    n=len(hN)
    def m(x): return sum(x)/len(x)
    print(f"[tie={tie}] NAME R@10={m(hN):.6f} BM25n R@10={m(hB):.6f} H10 R@10={m(h10):.6f} H60 R@10={m(h60):.6f}")
    print(f"          H10-NAME net={sum(h10[i]-hN[i] for i in range(n))} (+{ (sum(h10)-sum(hN))/n:.4f})  H60-NAME net={sum(h60)-sum(hN)} (+{(sum(h60)-sum(hN))/n:.4f})")
