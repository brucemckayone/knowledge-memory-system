import json, re, math, os
import numpy as np

ROOT = r"C:\Users\bruce.mckay\dev\nmemo"
ARC  = os.path.join(ROOT, "docs/architecture/cross-corpus-audit/multihop-artifacts")
CORP = os.path.join(ROOT, "docs/architecture/cross-corpus-audit/convergence-artifacts")
OUT  = os.path.join(ROOT, "docs/architecture/single-graph/prereg-artifacts")
SCR  = os.path.dirname(os.path.abspath(__file__))
CORPORA = ["arxiv-nlp", "arxiv-cv"]
DOC_FILE = {"arxiv-nlp": "corpus-A.json", "arxiv-cv": "corpus-B.json"}

print("loading caches...", flush=True)
qcache = json.load(open(os.path.join(OUT, "embed-cache.json"), encoding="utf-8"))
nameCache = json.load(open(os.path.join(OUT, "arxiv-embed-cache.json"), encoding="utf-8"))
print("query cache:", len(qcache), " arxiv name cache:", len(nameCache), flush=True)

def matcher(name):
    esc = re.escape(name)
    return re.compile(r"(?<![a-z0-9])" + esc + r"(?![a-z0-9])")

def load_ents(c):
    ents=[]
    for line in open(os.path.join(SCR, "ents-%s.tsv" % c), encoding="utf-8"):
        line=line.rstrip("\n")
        if not line: continue
        parts=line.split("\t")
        eid=parts[0]; name=parts[1] if len(parts)>1 else ""; desc=parts[2] if len(parts)>2 else ""
        ents.append({"id":eid,"name":name,"description":desc})
    return ents

def load_facts(c):
    ids=[];subj=[];obj=[];vecs=[]
    for line in open(os.path.join(SCR, "facts-%s.tsv" % c), encoding="utf-8"):
        line=line.rstrip("\n")
        if not line: continue
        fid,s,o,emb=line.split("\t")
        inner=emb.strip().lstrip("[").rstrip("]")
        v=np.fromstring(inner, sep=",", dtype=np.float64)
        ids.append(fid);subj.append(s);obj.append(o);vecs.append(v)
    return ids,subj,obj,vecs

def emb_text(name, desc):
    return name  # mode 'name' + all arxiv desc NULL

docsById={}; entsByCorpus={}; attrByCorpus={}; f2pByCorpus={}; pairs=[]
for c in CORPORA:
    docs=json.load(open(os.path.join(CORP, DOC_FILE[c]), encoding="utf-8"))
    for d in docs: docsById[d["id"]]=d
    attrFull=json.load(open(os.path.join(ARC, "attribution-%s.json" % c), encoding="utf-8"))
    attr=attrFull["paperToEntities"]; attrByCorpus[c]=attr; f2pByCorpus[c]=attrFull["factToPaper"]
    order=json.load(open(os.path.join(ARC, "ingest-ledger-%s.json" % c), encoding="utf-8"))
    pos={id:i for i,id in enumerate(order)}
    e2p={}
    for paper,ents in attr.items():
        for e in ents: e2p.setdefault(e,[]).append(paper)
    for entityId,ps in e2p.items():
        uniq=[p for p in dict.fromkeys(ps) if p in docsById and p in pos]
        if len(uniq)<2: continue
        uniq.sort(key=lambda p: pos[p])
        for docId in uniq[1:]: pairs.append((entityId,docId,c))
    entsByCorpus[c]=load_ents(c)
print("query pairs:", len(pairs), flush=True)

miss_name=0; miss_q=0; badlen=0
for c in CORPORA:
    for e in entsByCorpus[c]:
        v=nameCache.get(emb_text(e["name"],e["description"]))
        if v is None: miss_name+=1
        elif len(v)!=768: badlen+=1
for (eid,docId,c) in pairs:
    d=docsById[docId]; qt=d["title"]+" "+d["abstract"]
    if qcache.get(qt) is None and nameCache.get(qt) is None: miss_q+=1
print("cache coverage: missing name-vecs=%d missing query-vecs=%d wrong-len=%d" % (miss_name,miss_q,badlen), flush=True)

relevantByKey={}
for c in CORPORA:
    ents=entsByCorpus[c]; idxOf={e["id"]:i for i,e in enumerate(ents)}
    matchers=[]
    for i,e in enumerate(ents):
        nm=(e["name"] or "").strip()
        matchers.append(None if len(nm)<3 else (i, matcher(nm.lower())))
    attr=attrByCorpus[c]
    for p in [q for q in pairs if q[2]==c]:
        docId=p[1]; key=c+"#"+docId
        if key in relevantByKey: continue
        d=docsById[docId]; text=(d["title"]+" "+d["abstract"]).lower()
        rel=set()
        for eid in attr.get(docId,[]):
            i=idxOf.get(eid)
            if i is not None: rel.add(i)
        for m in matchers:
            if m is None: continue
            i,re_=m
            if i in rel: continue
            if re_.search(text): rel.add(i)
        relevantByKey[key]=rel

factState={}; rawNormSum=0.0; rawNormCount=0; dimViol=0; selfDotViol=0
for c in CORPORA:
    ents=entsByCorpus[c]; idxOf={e["id"]:i for i,e in enumerate(ents)}
    ids,subj,obj,vecs=load_facts(c)
    paper=[]; keptvecs=[]; entFacts={}; f2p=f2pByCorpus[c]
    for k in range(len(ids)):
        v=vecs[k]
        if v.shape[0]!=768 or not np.all(np.isfinite(v)): dimViol+=1; continue
        rn=float(np.sqrt(np.dot(v,v))); rawNormSum+=rn; rawNormCount+=1
        nv=v/rn if rn!=0 else v.copy()
        if abs(float(np.dot(nv,nv))-1.0)>1e-6: selfDotViol+=1
        fi=len(keptvecs); keptvecs.append(nv); paper.append(f2p.get(ids[k],""))
        for eid in (subj[k],obj[k]):
            ei=idxOf.get(eid)
            if ei is not None: entFacts.setdefault(ei,[]).append(fi)
    F=np.array(keptvecs,dtype=np.float64)
    factState[c]=dict(F=F,paper=paper,entFacts=entFacts)
    print("%s: %d active embedded facts, %d/%d entities with >=1 fact" % (c,len(ids),len(entFacts),len(ents)), flush=True)
print("\nintegrity: dimViol %d; mean RAW norm %.3f; selfDotViol %d" % (dimViol, rawNormSum/max(1,rawNormCount), selfDotViol))

def rank_by_score(scores, min_score=-math.inf):
    idx=[i for i in range(len(scores)) if scores[i]>min_score]
    idx.sort(key=lambda i:(-scores[i], i))
    return idx
def rrf_retrieved(rankings,K,universe):
    s=[0.0]*universe
    for r in rankings:
        for i in range(len(r)): s[r[i]]+=1.0/(K+i+1)
    return s
def strict_rank_of(ranking,t):
    try: return ranking.index(t)+1
    except ValueError: return math.inf
def condensed_rank_of(ranking,t,relevant):
    try: posT=ranking.index(t)
    except ValueError: return math.inf
    above=0
    for r in range(posT):
        i=ranking[r]
        if i==t: continue
        if i in relevant: continue
        above+=1
    return above+1

ARMS=["NAME","FACTMAX","FACTNAME"]
strictRank={a:[] for a in ARMS}; condRank={a:[] for a in ARMS}
corpusOf=[];entityOf=[];docOf=[];factmaxEqName=[];noEligible=0;pairsWithExclusion=0
targetFactMaxHit=[]; targetDegree=[]

for c in CORPORA:
    ents=entsByCorpus[c]; idxOf={e["id"]:i for i,e in enumerate(ents)}; U=len(ents)
    vName=np.array([nameCache[emb_text(e["name"],e["description"])] for e in ents], dtype=np.float64)
    fs=factState[c]; F=fs["F"]; paper=fs["paper"]; entFacts=fs["entFacts"]
    for p in [q for q in pairs if q[2]==c]:
        entityId,docId,_=p
        t=idxOf.get(entityId)
        if t is None: continue
        d=docsById[docId]; qt=d["title"]+" "+d["abstract"]
        qv=qcache.get(qt)
        if qv is None: qv=nameCache.get(qt)
        qv=np.array(qv, dtype=np.float64)
        rel=relevantByKey[c+"#"+docId]
        factScore=F@qv; nameScore=vName@qv
        entMax=[-math.inf]*U; entCnt=[0]*U; excl=0
        for ei,fidxs in entFacts.items():
            for fi in fidxs:
                if paper[fi]==docId: excl+=1; continue
                sc=float(factScore[fi])
                if sc>entMax[ei]: entMax[ei]=sc
                entCnt[ei]+=1
        if excl>0: pairsWithExclusion+=1
        rName=rank_by_score([float(x) for x in nameScore])
        rFactMax=rank_by_score(entMax,-math.inf)
        rFactName=rank_by_score(rrf_retrieved([rName,rFactMax],60,U),0)
        strictRank["NAME"].append(strict_rank_of(rName,t)); condRank["NAME"].append(condensed_rank_of(rName,t,rel))
        strictRank["FACTMAX"].append(strict_rank_of(rFactMax,t)); condRank["FACTMAX"].append(condensed_rank_of(rFactMax,t,rel))
        strictRank["FACTNAME"].append(strict_rank_of(rFactName,t)); condRank["FACTNAME"].append(condensed_rank_of(rFactName,t,rel))
        if entMax[t]==-math.inf: noEligible+=1
        targetDegree.append(len(entFacts.get(t,[])))
        targetFactMaxHit.append(1 if strict_rank_of(rFactMax,t)<=10 else 0)
        fTop=set(rFactMax[:10]); nTop=set(rName[:10]); factmaxEqName.append(1 if fTop==nTop else 0)
        corpusOf.append(c); entityOf.append(entityId); docOf.append(docId)

n=len(strictRank["NAME"])
def hit(arm,k,tbl): return [1 if r<=k else 0 for r in tbl[arm]]
def hitS(arm,k): return hit(arm,k,strictRank)
def hitC(arm,k): return hit(arm,k,condRank)
def mean(xs): return sum(xs)/len(xs) if xs else float('nan')

print("\nn=%d  pairsWithExclusion=%d  noEligible=%d  factmaxEqName=%.1f%%  retrievability=%.1f%%" % (n,pairsWithExclusion,noEligible,mean(factmaxEqName)*100,(n-noEligible)/n*100))
print("\n=== arms strict/cond R@10 ===")
for a in ARMS: print("  %-9s strict %.10f  cond %.10f" % (a, mean(hitS(a,10)), mean(hitC(a,10))))

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
        deltas.append((sa/nn-sb/nn) if nn else 0.0)
    deltas.sort()
    return delta, deltas[int(0.025*resamples)], deltas[int(0.975*resamples)-1]
def verdict(lo,hi): return "ABOVE 0" if lo>0 else ("BELOW 0" if hi<0 else "SPANS 0")

pairKeys=[str(i) for i in range(n)]
def tri(a,b):
    out={}
    for lab,cl in (("byPair",pairKeys),("byEntity",entityOf),("byDocument",docOf)):
        d,lo,hi=clustered_bootstrap(a,b,cl); out[lab]=(d,lo,hi)
    return out

print("\n=== PRIMARY strict FACTNAME-NAME ===")
ps=tri(hitS("FACTNAME",10),hitS("NAME",10))
allpos=True
for lab in ("byPair","byEntity","byDocument"):
    d,lo,hi=ps[lab]; print("  %-10s %+.6f [%+.6f,%+.6f] %s" % (lab,d,lo,hi,verdict(lo,hi))); allpos = allpos and lo>0
print("  => ALL-THREE-ABOVE-0: %s" % ("YES (DEMONSTRATED)" if allpos else "NO"))

print("\n=== CO-PRIMARY condensed FACTNAME-NAME ===")
pc=tri(hitC("FACTNAME",10),hitC("NAME",10))
allpos=True
for lab in ("byPair","byEntity","byDocument"):
    d,lo,hi=pc[lab]; print("  %-10s %+.6f [%+.6f,%+.6f] %s" % (lab,d,lo,hi,verdict(lo,hi))); allpos=allpos and lo>0
print("  => ALL-THREE-ABOVE-0: %s" % ("YES" if allpos else "NO"))

print("\n=== secondary FACTMAX-NAME strict ===")
for lab in ("byPair","byEntity","byDocument"):
    d,lo,hi=tri(hitS("FACTMAX",10),hitS("NAME",10))[lab]
    print("  %-10s %+.6f [%+.6f,%+.6f] %s" % (lab,d,lo,hi,verdict(lo,hi)))

nameH=sum(hitS("NAME",10)); factH=sum(hitS("FACTMAX",10)); fuseH=sum(hitS("FACTNAME",10))
print("\ncomplementarity (strict hits): NAME %d  FACTMAX %d  FACTNAME %d  fusion>max? %s" % (nameH,factH,fuseH,fuseH>max(nameH,factH)))

print("\n=== per corpus FACTNAME-NAME strict ===")
for c in CORPORA:
    idx=[i for i in range(n) if corpusOf[i]==c]
    fh=[hitS("FACTNAME",10)[i] for i in idx]; nh=[hitS("NAME",10)[i] for i in idx]
    d,lo,hi=clustered_bootstrap(fh,nh,[str(i) for i in idx])
    print("  %s: n=%d NAME %.3f FACTNAME %.3f %+.4f[%+.4f,%+.4f]%s" % (c,len(idx),mean(nh),mean(fh),d,lo,hi,verdict(lo,hi)))

print("\n=== k-ladder strict/cond ===")
for k in [1,5,10,20]:
    print("  R@%-2d NAME %.3f/%.3f  FACTMAX %.3f/%.3f  FACTNAME %.3f/%.3f" % (k, mean(hitS("NAME",k)),mean(hitC("NAME",k)),mean(hitS("FACTMAX",k)),mean(hitC("FACTMAX",k)),mean(hitS("FACTNAME",k)),mean(hitC("FACTNAME",k))))

print("\n=== FACTNAME-NAME strict/cond at k-ladder (byPair) ===")
for orc,tbl in (("strict",hitS),("cond",hitC)):
    for k in [1,5,10,20]:
        d,lo,hi=clustered_bootstrap(tbl("FACTNAME",k),tbl("NAME",k),pairKeys)
        print("  %-6s R@%-2d %+.5f [%+.5f,%+.5f] %s" % (orc,k,d,lo,hi,verdict(lo,hi)))

hitCounts=[targetDegree[i] for i in range(n) if targetFactMaxHit[i]==1]
missCounts=[targetDegree[i] for i in range(n) if targetFactMaxHit[i]==0]
import statistics
print("\ndegree diagnostic: FACTMAX target-hit mean fact-degree %.2f (n=%d) vs miss %.2f (n=%d)" % (mean(hitCounts),len(hitCounts),mean(missCounts),len(missCounts)))
print("target fact-degree overall: min %d median %s mean %.2f max %d" % (min(targetDegree),statistics.median(targetDegree),mean(targetDegree),max(targetDegree)))
