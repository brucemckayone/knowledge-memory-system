"""prereg-29 leak-sizing (nmemo-u8j.8, adversary owed item 2): build HELD-OUT Louvain community assignments
— for each query doc D, rebuild communities EXCLUDING D's own fact-edges (seed 20260831), so the community
graph has NOT seen the query paper. community-fusion.ts --heldout re-scores with these to size the
un-held-out-edge leak's contribution to the +0.0439 condensed win.

Inputs: edges-with-factid.tsv (corpus\tfactId\tsubj\tobj) + attribution-<corpus>.json (factToPaper).
Output: prereg-artifacts/heldout-communities-<corpus>.json = {docId: {entityId: "corpus#N"}}.

Run: python heldout_communities.py <edges-with-factid.tsv> <attribution_dir> <out_dir>
"""
import collections
import json
import sys
import networkx as nx

SEED = 20260831


def main() -> None:
    tsv, attr_dir, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    by_corpus = collections.defaultdict(list)  # corpus -> [(factId, subj, obj)]
    with open(tsv, encoding="utf-8") as f:
        for line in f:
            p = line.rstrip("\n").split("\t")
            if len(p) == 4:
                by_corpus[p[0]].append((p[1], p[2], p[3]))

    for corpus, edges in sorted(by_corpus.items()):
        f2p = json.load(open(f"{attr_dir}/attribution-{corpus}.json", encoding="utf-8"))["factToPaper"]
        edge_doc = [f2p.get(fid) for (fid, _, _) in edges]  # doc per edge (None if unattributed)
        docs = sorted({d for d in edge_doc if d})
        out = {}
        for D in docs:
            g = nx.Graph()
            for (fid, s, o), d in zip(edges, edge_doc):
                if d == D:
                    continue  # hold out this query doc's edges
                g.add_edge(s, o)
            comms = nx.community.louvain_communities(g, seed=SEED)
            assign = {}
            for i, c in enumerate(comms):
                for e in c:
                    assign[e] = f"{corpus}#{i}"
            out[D] = assign
        path = f"{out_dir}/heldout-communities-{corpus}.json"
        json.dump(out, open(path, "w", encoding="utf-8"))
        print(f"{corpus}: {len(docs)} held-out assignments (each excludes that doc's edges) -> {path}")


if __name__ == "__main__":
    main()
