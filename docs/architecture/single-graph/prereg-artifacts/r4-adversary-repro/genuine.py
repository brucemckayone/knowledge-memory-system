import json, os, random, urllib.request, math
SCR = os.path.dirname(os.path.abspath(__file__))
CACHE = r"C:\Users\bruce.mckay\dev\nmemo\docs\architecture\single-graph\prereg-artifacts\arxiv-embed-cache.json"
cache = json.load(open(CACHE, encoding="utf-8"))
print("cache keys:", len(cache))

# load names from my fresh DB dumps
names = []
for c in ["arxiv-nlp","arxiv-cv"]:
    for line in open(os.path.join(SCR, f"ents-{c}.tsv"), encoding="utf-8"):
        line=line.rstrip("\n")
        if not line: continue
        p=line.split("\t"); nm = p[1] if len(p)>1 else ""
        if nm: names.append(nm)
print("names loaded:", len(names), "unique:", len(set(names)))

# check every name is a cache key
missing = [n for n in set(names) if n not in cache]
print("names missing from cache:", len(missing))
if missing[:5]: print("  e.g.", missing[:5])

def norm(v): 
    m=math.sqrt(sum(x*x for x in v)); return [x/m for x in v] if m else v
def cos(a,b):
    return sum(x*y for x,y in zip(a,b))/ (math.sqrt(sum(x*x for x in a))*math.sqrt(sum(y*y for y in b)))

# cache norms: are they normalised (unit)?
import statistics
cnorms = [math.sqrt(sum(x*x for x in cache[n])) for n in list(set(names))[:200] if n in cache]
print(f"cached-vector L2 norms (sample 200): min {min(cnorms):.5f} max {max(cnorms):.5f} mean {statistics.mean(cnorms):.5f}")

def embed(text):
    body=json.dumps({"text":text,"model":"nomic-embed-text"}).encode()
    req=urllib.request.Request("http://localhost:8000/embed", data=body, headers={"Content-Type":"application/json"})
    return json.load(urllib.request.urlopen(req, timeout=120))["vector"]

random.seed(4242)
sample = random.sample(sorted(set(names)), 30)
cosines=[]
worst=None
for nm in sample:
    if nm not in cache:
        print("  SKIP (not cached):", repr(nm)); continue
    fresh = embed(nm)
    c = cos(fresh, cache[nm])
    cosines.append(c)
    tag = "OK" if c>0.9999 else ("~" if c>0.99 else "!!")
    print(f"  {tag} cos={c:.6f}  {repr(nm[:55])}")
    if worst is None or c<worst[0]: worst=(c,nm)
print(f"\n30-sample cosine: min {min(cosines):.6f} mean {statistics.mean(cosines):.6f} max {max(cosines):.6f}")
print("worst:", worst)

# distinctness: are the 30 cached vectors mutually distinct (not one repeated vector)?
vs=[cache[n] for n in sample if n in cache]
import itertools
offdiag=[cos(vs[i],vs[j]) for i in range(len(vs)) for j in range(i+1,len(vs))]
print(f"pairwise cos among 30 distinct names: min {min(offdiag):.4f} max {max(offdiag):.4f} mean {statistics.mean(offdiag):.4f}")
