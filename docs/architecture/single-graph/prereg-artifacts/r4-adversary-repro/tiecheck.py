# Confirm the R@5 1-hit discrepancy is a float summation-order tie at rank 5/6,
# by recomputing NAME ranks two ways (numpy matmul vs JS-style sequential dot).
import json, math, os
import numpy as np
ROOT=r"C:\Users\bruce.mckay\dev\nmemo"
ARC=os.path.join(ROOT,"docs/architecture/cross-corpus-audit/multihop-artifacts")
CORP=os.path.join(ROOT,"docs/architecture/cross-corpus-audit/convergence-artifacts")
OUT=os.path.join(ROOT,"docs/architecture/single-graph/prereg-artifacts")
SCR=os.path.dirname(os.path.abspath(__file__))
qcache=json.load(open(os.path.join(OUT,"embed-cache.json"),encoding="utf-8"))
nameCache=json.load(open(os.path.join(OUT,"arxiv-embed-cache.json"),encoding="utf-8"))
CORPORA=["arxiv-nlp","arxiv-cv"];DOC_FILE={"arxiv-nlp":"corpus-A.json","arxiv-cv":"corpus-B.json"}
def load_ents(c):
    r=[]
    for l in open(os.path.join(SCR,"ents-%s.tsv"%c),encoding="utf-8"):
        l=l.rstrip("\n")
        if l: p=l.split("\t"); r.append({"id":p[0],"name":p[1] if len(p)>1 else ""})
    return r
docsById={};entsByCorpus={};attrByCorpus={};pairs=[]
for c in CORPORA:
    docs=json.load(open(os.path.join(CORP,DOC_FILE[c]),encoding="utf-8"))
    for d in docs: docsById[d["id"]]=d
    af=json.load(open(os.path.join(ARC,"attribution-%s.json"%c),encoding="utf-8"));attrByCorpus[c]=af["paperToEntities"]
    order=json.load(open(os.path.join(ARC,"ingest-ledger-%s.json"%c),encoding="utf-8"));pos={i:k for k,i in enumerate(order)}
    e2p={}
    for paper,ents in af["paperToEntities"].items():
        for e in ents: e2p.setdefault(e,[]).append(paper)
    for eid,ps in e2p.items():
        uniq=[p for p in dict.fromkeys(ps) if p in docsById and p in pos]
        if len(uniq)<2: continue
        uniq.sort(key=lambda p:pos[p])
        for docId in uniq[1:]: pairs.append((eid,docId,c))
    entsByCorpus[c]=load_ents(c)
def rbs(scores):
    idx=list(range(len(scores))); idx.sort(key=lambda i:(-scores[i],i)); return idx
npc=0; seqc=0; diffpairs=0
for c in CORPORA:
    ents=entsByCorpus[c];idxOf={e["id"]:i for i,e in enumerate(ents)}
    vName=np.array([nameCache[e["name"]] for e in ents])
    for p in [q for q in pairs if q[2]==c]:
        eid,docId,_=p;t=idxOf.get(eid)
        if t is None: continue
        d=docsById[docId];qt=d["title"]+" "+d["abstract"];qv=np.array(qcache.get(qt) or nameCache.get(qt))
        s_np=[float(x) for x in (vName@qv)]
        s_seq=[float(np.dot(vName[i],qv)) for i in range(len(ents))]  # per-row dot (diff summation order)
        rnp=rbs(s_np).index(t)+1; rseq=rbs(s_seq).index(t)+1
        if rnp<=5: npc+=1
        if rseq<=5: seqc+=1
        if (rnp<=5)!=(rseq<=5):
            diffpairs+=1
            print("  pair flips @5: numpy rank=%d seq rank=%d  gap check"%(rnp,rseq))
print("R@5 NAME strict: numpy-matmul=%d/387  perrow-dot=%d/387  boundary-flip pairs=%d"%(npc,seqc,diffpairs))
print("(author harness JS sequential dot => 48; numpy matmul => 49; difference is one rank-5/6 float tie)")
