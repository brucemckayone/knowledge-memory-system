import json, re, math, os
import numpy as np

ROOT = r"C:\Users\bruce.mckay\dev\nmemo"
ARC  = os.path.join(ROOT, "docs/architecture/cross-corpus-audit/multihop-artifacts")
CORP = os.path.join(ROOT, "docs/architecture/cross-corpus-audit/convergence-artifacts")
OUT  = os.path.join(ROOT, "docs/architecture/single-graph/prereg-artifacts")
SCR  = os.path.dirname(os.path.abspath(__file__))
CORPORA = ["dal-nlp", "dal-cv"]
DOC_FILE = {"dal-nlp": "corpus-A.json", "dal-cv": "corpus-B.json"}

cache = json.load(open(os.path.join(OUT, "embed-cache.json"), encoding="utf-8"))

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
        v=np.fromstring(emb.strip().lstrip("[").rstrip("]"),sep=",",dtype=np.float64)
        ids.append(fid);subj.append(s);obj.append(o);vecs.append(v)
    return ids,subj,obj,vecs

docsById={}; attrByCorpus={}; f2pByCorpus={}; pairs=[]; posByCorpus={}
for c in CORPORA:
    docs=json.load(open(os.path.join(CORP,DOC_FILE[c]),encoding="utf-8"))
    for d in docs: docsById[d["id"]]=d
    af=json.load(open(os.path.join(ARC,f"attribution-{c}.json"),encoding="utf-8"))
    attrByCorpus[c]=af["paperToEntities"]; f2pByCorpus[c]=af["factToPaper"]
    order=json.load(open(os.path.join(ARC,f"ingest-ledger-{c}.json"),encoding="utf-8"))
    pos={id:i for i,id in enumerate(order)}; posByCorpus[c]=pos
    e2p={}
    for paper,ents in af["paperToEntities"].items():
        for e in ents: e2p.setdefault(e,[]).append(paper)
    for eid,ps in e2p.items():
        uniq=[p for p in dict.fromkeys(ps) if p in docsById and p in pos]
        if len(uniq)<2: continue
        uniq.sort(key=lambda p:pos[p])
        for docId in uniq[1:]: pairs.append((eid,docId,c))

print("=== TASK 2: GUARD / TAUTOLOGY ANALYSIS ===\n")
# query docs actually used
qdocs_by_c = {c:set(d for (e,d,cc) in pairs if cc==c) for c in CORPORA}
for c in CORPORA:
    ids,subj,obj,vecs=load_facts(c)
    active=set(ids)
    mapped=set(f2pByCorpus[c].keys())
    unmapped = active - mapped
    mapped_not_active = mapped - active
    f2p=f2pByCorpus[c]
    papers_all = set(posByCorpus[c].keys())
    papers_attr = set(attrByCorpus[c].keys())
    lost_docs = papers_all - papers_attr
    print(f"[{c}] active facts={len(active)}  factToPaper keys={len(mapped)}  "
          f"unmapped(active not in f2p)={len(unmapped)}  mapped-not-active={len(mapped_not_active)}")
    print(f"     coverage of active facts = {(len(active)-len(unmapped))/len(active)*100:.1f}%")
    print(f"     papers in ledger={len(papers_all)}  papers w/ entities={len(papers_attr)}  attribution-lost docs={len(lost_docs)}")
    print(f"     query docs used = {len(qdocs_by_c[c])}")
    # are any query docs among lost docs?
    qd_lost = qdocs_by_c[c] & lost_docs
    print(f"     query docs that are attribution-lost = {len(qd_lost)}  (must be 0)")
    # are lost docs ever referenced as factToPaper VALUES?
    f2p_values = set(f2p.values())
    lost_as_val = lost_docs & f2p_values
    print(f"     lost docs referenced as factToPaper values = {len(lost_as_val)} (expect 0 if lost=>no facts)")
    # do any factToPaper VALUES point to a query doc? (these facts ARE excluded)
    facts_to_qdoc = [fid for fid,pap in f2p.items() if pap in qdocs_by_c[c] and fid in active]
    print(f"     active facts mapped to a query doc (excluded by guard) = {len(facts_to_qdoc)}")
    # LEAK VECTOR: unmapped active facts — which entities own them, are those entities query targets?
    ent_ids = set(e["id"] for e in load_ents(c))
    target_ids = set(e for (e,d,cc) in pairs if cc==c)
    unmapped_touch_target=0; unmapped_touch_any_ent=0
    for k in range(len(ids)):
        if ids[k] in unmapped:
            eps=[subj[k],obj[k]]
            if any(x in ent_ids for x in eps): unmapped_touch_any_ent+=1
            if any(x in target_ids for x in eps): unmapped_touch_target+=1
    print(f"     unmapped facts touching an in-corpus entity = {unmapped_touch_any_ent}/{len(unmapped)}")
    print(f"     unmapped facts touching a TARGET entity     = {unmapped_touch_target}/{len(unmapped)}")
    print()

# Spot-check a pair: show excluded vs included facts for the target
print("=== SPOT CHECK: pair-level guard ===")
c="dal-nlp"
ids,subj,obj,vecs=load_facts(c)
f2p=f2pByCorpus[c]
byent={}
for k in range(len(ids)):
    for e in (subj[k],obj[k]): byent.setdefault(e,[]).append(k)
# pick a pair whose target has facts mapped to d
for (eid,docId,cc) in [p for p in pairs if p[2]==c][:200]:
    ks=byent.get(eid,[])
    mapped_to_d=[k for k in ks if f2p.get(ids[k])==docId]
    if mapped_to_d:
        mapped_other=[k for k in ks if ids[k] in f2p and f2p[ids[k]]!=docId]
        unmapped_k=[k for k in ks if ids[k] not in f2p]
        print(f" pair target={eid[:8]} d={docId}  target facts={len(ks)}: "
              f"excluded(→d)={len(mapped_to_d)}  included-mapped-other={len(mapped_other)}  included-unmapped={len(unmapped_k)}")
        # show the papers the mapped-other facts came from (should all != docId)
        others=set(f2p[ids[k]] for k in mapped_other)
        print(f"   included-mapped-other source papers (all must != {docId}): {docId in others=}")
        break
