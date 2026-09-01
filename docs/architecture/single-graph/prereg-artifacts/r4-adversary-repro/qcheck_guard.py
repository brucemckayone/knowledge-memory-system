import json, os, math, urllib.request, random
ROOT=r"C:\Users\bruce.mckay\dev\nmemo"
ARC=os.path.join(ROOT,"docs/architecture/cross-corpus-audit/multihop-artifacts")
CORP=os.path.join(ROOT,"docs/architecture/cross-corpus-audit/convergence-artifacts")
OUT=os.path.join(ROOT,"docs/architecture/single-graph/prereg-artifacts")
SCR=os.path.dirname(os.path.abspath(__file__))
nameCache=json.load(open(os.path.join(OUT,"arxiv-embed-cache.json"),encoding="utf-8"))
qcache=json.load(open(os.path.join(OUT,"embed-cache.json"),encoding="utf-8"))
def cos(a,b): return sum(x*y for x,y in zip(a,b))/(math.sqrt(sum(x*x for x in a))*math.sqrt(sum(y*y for y in b)))
def embed(t):
    body=json.dumps({"text":t,"model":"nomic-embed-text"}).encode()
    req=urllib.request.Request("http://localhost:8000/embed",data=body,headers={"Content-Type":"application/json"})
    return json.load(urllib.request.urlopen(req,timeout=120))["vector"]

# the 54 long keys in arxiv cache = freshly-minted query-doc vectors
longkeys=[k for k in nameCache if len(k)>120]
print("query-doc keys in arxiv cache:", len(longkeys))
random.seed(7); samp=random.sample(longkeys,5)
for k in samp:
    c=cos(embed(k),nameCache[k])
    print("  cos=%.6f  overlap-with-frozen-qcache=%s  %r"%(c, k in qcache, k[:60]))

# also spot-check 3 query docs that ARE in the frozen qcache (genuineness of query side)
print("\nfrozen qcache query-doc spot check (are those genuine too?):")
CORPORA=["arxiv-nlp","arxiv-cv"]; DOC_FILE={"arxiv-nlp":"corpus-A.json","arxiv-cv":"corpus-B.json"}
docs=[]
for c in CORPORA: docs+=json.load(open(os.path.join(CORP,DOC_FILE[c]),encoding="utf-8"))
random.seed(11)
tried=0
for d in random.sample(docs,20):
    qt=d["title"]+" "+d["abstract"]
    if qt in qcache and qt not in nameCache:
        c=cos(embed(qt),qcache[qt])
        print("  cos=%.6f  %r"%(c, d["id"]))
        tried+=1
        if tried>=3: break

# ---- guard spot-check ----
print("\n=== held-out guard spot-check ===")
def load_ents(c):
    ents=[]
    for line in open(os.path.join(SCR,"ents-%s.tsv"%c),encoding="utf-8"):
        line=line.rstrip("\n")
        if line: p=line.split("\t"); ents.append({"id":p[0],"name":p[1] if len(p)>1 else ""})
    return ents
c="arxiv-cv"
af=json.load(open(os.path.join(ARC,"attribution-%s.json"%c),encoding="utf-8"))
attr=af["paperToEntities"]; f2p=af["factToPaper"]
order=json.load(open(os.path.join(ARC,"ingest-ledger-%s.json"%c),encoding="utf-8"))
pos={id:i for i,id in enumerate(order)}
docsById={d["id"]:d for d in json.load(open(os.path.join(CORP,DOC_FILE[c]),encoding="utf-8"))}
e2p={}
for paper,ents in attr.items():
    for e in ents: e2p.setdefault(e,[]).append(paper)
# find an entity attributed to >=2 docs; take its 2nd doc as query
for eid,ps in e2p.items():
    uniq=[p for p in dict.fromkeys(ps) if p in docsById and p in pos]
    if len(uniq)<2: continue
    uniq.sort(key=lambda p:pos[p]); docId=uniq[1]
    # facts touching this entity
    ents=load_ents(c);
    # load facts from tsv
    tot=0; from_d=0; other=0
    for line in open(os.path.join(SCR,"facts-%s.tsv"%c),encoding="utf-8"):
        line=line.rstrip("\n")
        if not line: continue
        fid,s,o,emb=line.split("\t")
        if s==eid or o==eid:
            tot+=1
            if f2p.get(fid)==docId: from_d+=1
            else: other+=1
    print("entity %s ('%s') query-doc %s"%(eid[:8], next((e['name'] for e in ents if e['id']==eid),'?'), docId))
    print("  facts touching entity: total=%d  sourced-from-query-doc(excluded)=%d  eligible-after-guard=%d"%(tot,from_d,other))
    print("  -> guard removes the d-sourced facts; target retains eligible facts: %s"%(other>0))
    break
