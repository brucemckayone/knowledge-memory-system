import json, re, math, os
import numpy as np
ROOT=r"C:\Users\bruce.mckay\dev\nmemo"
ARC=os.path.join(ROOT,"docs/architecture/cross-corpus-audit/multihop-artifacts")
CORP=os.path.join(ROOT,"docs/architecture/cross-corpus-audit/convergence-artifacts")
OUT=os.path.join(ROOT,"docs/architecture/single-graph/prereg-artifacts")
SCR=os.path.dirname(os.path.abspath(__file__))
CORPORA=["arxiv-nlp","arxiv-cv"]; DOC_FILE={"arxiv-nlp":"corpus-A.json","arxiv-cv":"corpus-B.json"}
qcache=json.load(open(os.path.join(OUT,"embed-cache.json"),encoding="utf-8"))
nameCache=json.load(open(os.path.join(OUT,"arxiv-embed-cache.json"),encoding="utf-8"))
def load_ents(c):
    ents=[]
    for line in open(os.path.join(SCR,"ents-%s.tsv"%c),encoding="utf-8"):
        line=line.rstrip("\n")
        if not line: continue
        p=line.split("\t"); ents.append({"id":p[0],"name":p[1] if len(p)>1 else ""})
    return ents
def load_facts(c):
    ids=[];subj=[];obj=[];vecs=[]
    for line in open(os.path.join(SCR,"facts-%s.tsv"%c),encoding="utf-8"):
        line=line.rstrip("\n")
        if not line: continue
        fid,s,o,emb=line.split("\t"); inner=emb.strip().lstrip("[").rstrip("]")
        ids.append(fid);subj.append(s);obj.append(o);vecs.append(np.fromstring(inner,sep=",",dtype=np.float64))
    return ids,subj,obj,vecs
docsById={};entsByCorpus={};attrByCorpus={};f2pByCorpus={};pairs=[]
for c in CORPORA:
    docs=json.load(open(os.path.join(CORP,DOC_FILE[c]),encoding="utf-8"))
    for d in docs: docsById[d["id"]]=d
    af=json.load(open(os.path.join(ARC,"attribution-%s.json"%c),encoding="utf-8"))
    attrByCorpus[c]=af["paperToEntities"]; f2pByCorpus[c]=af["factToPaper"]
    order=json.load(open(os.path.join(ARC,"ingest-ledger-%s.json"%c),encoding="utf-8"))
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
factState={}
for c in CORPORA:
    ents=entsByCorpus[c]; idxOf={e["id"]:i for i,e in enumerate(ents)}
    ids,subj,obj,vecs=load_facts(c); paper=[];keptvecs=[];entFacts={};f2p=f2pByCorpus[c]
    for k in range(len(ids)):
        v=vecs[k]
        if v.shape[0]!=768: continue
        rn=float(np.sqrt(np.dot(v,v))); nv=v/rn if rn else v.copy()
        fi=len(keptvecs);keptvecs.append(nv);paper.append(f2p.get(ids[k],""))
        for eid in (subj[k],obj[k]):
            ei=idxOf.get(eid)
            if ei is not None: entFacts.setdefault(ei,[]).append(fi)
    factState[c]=dict(F=np.array(keptvecs),paper=paper,entFacts=entFacts)
def rbs(scores,ms=-math.inf):
    idx=[i for i in range(len(scores)) if scores[i]>ms]; idx.sort(key=lambda i:(-scores[i],i)); return idx
def rrf(rk,K,U):
    s=[0.0]*U
    for r in rk:
        for i in range(len(r)): s[r[i]]+=1.0/(K+i+1)
    return s
def srk(rk,t):
    try: return rk.index(t)+1
    except ValueError: return math.inf
hN=[];hF=[];hFN=[];entityOf=[];corpusOf=[]
for c in CORPORA:
    ents=entsByCorpus[c]; idxOf={e["id"]:i for i,e in enumerate(ents)}; U=len(ents)
    vName=np.array([nameCache[e["name"]] for e in ents]); fs=factState[c];F=fs["F"];paper=fs["paper"];entFacts=fs["entFacts"]
    for p in [q for q in pairs if q[2]==c]:
        eid,docId,_=p; t=idxOf.get(eid)
        if t is None: continue
        d=docsById[docId]; qt=d["title"]+" "+d["abstract"]; qv=qcache.get(qt) or nameCache.get(qt); qv=np.array(qv)
        fsc=F@qv; nsc=vName@qv; entMax=[-math.inf]*U
        for ei,fidxs in entFacts.items():
            for fi in fidxs:
                if paper[fi]==docId: continue
                if fsc[fi]>entMax[ei]: entMax[ei]=fsc[fi]
        rN=rbs([float(x) for x in nsc]); rF=rbs(entMax,-math.inf); rFN=rbs(rrf([rN,rF],60,U),0)
        hN.append(1 if srk(rN,t)<=10 else 0); hF.append(1 if srk(rF,t)<=10 else 0); hFN.append(1 if srk(rFN,t)<=10 else 0)
        entityOf.append(eid); corpusOf.append(c)
n=len(hN)
# set decomposition
def S(h): return set(i for i in range(n) if h[i])
sN,sF,sFN=S(hN),S(hF),S(hFN)
print("hits: NAME %d  FACTMAX %d  FACTNAME %d  (n=%d)"%(len(sN),len(sF),len(sFN),n))
print("\n--- FACTNAME vs components (is fusion riding FACTMAX?) ---")
print("FACTNAME rescues NAME-misses that FACTMAX found:      %d"%len(sFN & sF - sN))
print("FACTNAME keeps NAME hits that FACTMAX MISSED:          %d  (if 0, FACTNAME rides FACTMAX)"%len((sFN & sN)-sF))
print("FACTNAME hits neither NAME nor FACTMAX had (pure RRF): %d"%len(sFN-sN-sF))
print("FACTNAME LOSES a NAME hit:                             %d"%len(sN-sFN))
print("FACTNAME LOSES a FACTMAX hit:                          %d"%len(sF-sFN))
print("NAME-only hits (not FACTMAX):     %d"%len(sN-sF))
print("FACTMAX-only hits (not NAME):     %d"%len(sF-sN))
print("both NAME & FACTMAX:              %d"%len(sN & sF))
print("FACTNAME superset of FACTMAX? %s ; superset of NAME? %s"%(sF<=sFN, sN<=sFN))
print("FACTNAME == FACTMAX? %s ; == NAME? %s"%(sFN==sF,sFN==sN))
# cluster counts (fragility of entity bootstrap)
from collections import Counter
ec=Counter(entityOf); dc=Counter(corpusOf)
print("\n--- bootstrap cluster counts ---")
print("byPair clusters: %d"%n)
print("byEntity clusters (distinct entities): %d  (mean pairs/entity %.2f, max %d)"%(len(ec),n/len(ec),max(ec.values())))
print("byDocument clusters: computed in main repro")
