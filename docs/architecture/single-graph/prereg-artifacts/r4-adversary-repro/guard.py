import json, os
ROOT=r"C:\Users\bruce.mckay\dev\nmemo"
ARC=os.path.join(ROOT,"docs/architecture/cross-corpus-audit/multihop-artifacts")
SCR=os.path.dirname(os.path.abspath(__file__))
for c in ["arxiv-nlp","arxiv-cv"]:
    attr=json.load(open(os.path.join(ARC,f"attribution-{c}.json"),encoding="utf-8"))
    f2p=attr["factToPaper"]
    # active fact ids from my DB dump
    dbids=set()
    for line in open(os.path.join(SCR,f"facts-{c}.tsv"),encoding="utf-8"):
        line=line.rstrip("\n")
        if not line: continue
        dbids.add(line.split("\t")[0])
    f2pkeys=set(f2p.keys())
    covered=len(dbids & f2pkeys)
    uncovered=dbids - f2pkeys
    print(f"{c}: active facts(DB)={len(dbids)}  factToPaper keys={len(f2pkeys)}  covered={covered}  uncovered(active,no map)={len(uncovered)}")
    if uncovered: print("   e.g uncovered:", list(uncovered)[:3])
    # do factToPaper values point to real papers? spot count
    papers=set(f2p.values())
    print(f"   distinct papers referenced by factToPaper: {len(papers)}")
    # keys in f2p not in DB active (expired/invalid facts still mapped)
    extra=f2pkeys-dbids
    print(f"   factToPaper keys not among active facts: {len(extra)}")
