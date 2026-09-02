"""prereg-29 (nmemo-u8j.8): export the FROZEN Louvain community assignment entityId -> communityId per
corpus (seed 20260831), consumed by community-fusion.ts. Archived so the frozen assignment is reproducible
(the adversary's owed item 1 — the assignment must not be git-untracked).

Edge list (entity-entity via active facts) is produced by this SQL, saved as a TSV `corpus\tsubj\tobj`:

  docker exec nmemo-postgres-1 psql -U cognitive -d cognitive_test -tAc \
    "SELECT corpus_id||E'\t'||subject_entity_id||E'\t'||object_entity_id FROM facts \
     WHERE subject_entity_id IS NOT NULL AND object_entity_id IS NOT NULL \
       AND subject_entity_id<>object_entity_id AND expired_at IS NULL AND invalid_at IS NULL \
       AND corpus_id IN ('arxiv-nlp','arxiv-cv','qbio')" > entity-edges.tsv

Then: python export_communities.py entity-edges.tsv <out_dir>
Writes communities-<corpus>.json = {entityId: "corpus#N"} for edge-connected entities; community-fusion.ts
treats any entity absent from the map as its own singleton community. Requires networkx.
Edge-connected community counts (frozen): arxiv-cv 66, arxiv-nlp 80, qbio 396.
"""
import collections
import json
import sys
import networkx as nx

SEED = 20260831


def main() -> None:
    tsv = sys.argv[1] if len(sys.argv) > 1 else "entity-edges.tsv"
    out_dir = sys.argv[2] if len(sys.argv) > 2 else "."
    edges = collections.defaultdict(list)
    with open(tsv, encoding="utf-8") as f:
        for line in f:
            p = line.rstrip("\n").split("\t")
            if len(p) == 3:
                edges[p[0]].append((p[1], p[2]))
    for corpus in sorted(edges):
        g = nx.Graph()
        g.add_edges_from(edges[corpus])
        comms = nx.community.louvain_communities(g, seed=SEED)
        assign = {}
        for i, c in enumerate(comms):
            for e in c:
                assign[e] = f"{corpus}#{i}"
        path = f"{out_dir}/communities-{corpus}.json"
        with open(path, "w", encoding="utf-8") as f:
            json.dump(assign, f)
        print(f"{corpus}: {len(assign)} entities in {len(comms)} communities -> {path}")


if __name__ == "__main__":
    main()
