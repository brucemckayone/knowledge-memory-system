"""Plot Mnemo extraction times from the platform dev-server log.

Parses every `[ingest:...] extracted entities=N facts=M +Tms` line out of the
platform log and plots per-extraction wall time as a sequence + a histogram.

CAVEAT: the log spans every ingest on this platform instance, not just one
benchmark run — contaminated/failed runs and the current clean run are
interleaved. So read the sequence as "extraction cost over time on this box,"
not a clean per-chunk curve for a single question.

Usage (from benchmarks/):
    uv run python plot_extraction_times.py [path-to-log]
"""

from __future__ import annotations

import re
import statistics
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

DEFAULT_LOG = Path("C:/Users/bruce.mckay/dev/nmemo/platform/.tmp-devserver.log")
LINE_RE = re.compile(r"extracted entities=(\d+) facts=(\d+) \+(\d+)ms")


def main() -> int:
    log_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_LOG
    if not log_path.exists():
        print(f"log not found: {log_path}", file=sys.stderr)
        return 1

    text = log_path.read_text(encoding="utf-8", errors="replace")
    rows = [
        (int(m.group(1)), int(m.group(2)), int(m.group(3)) / 1000.0)
        for m in LINE_RE.finditer(text)
    ]
    if not rows:
        print("no extraction lines found", file=sys.stderr)
        return 1

    times = [r[2] for r in rows]
    idx = list(range(1, len(times) + 1))
    med = statistics.median(times)
    mean = statistics.mean(times)

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 5))

    ax1.plot(idx, times, marker=".", linewidth=0.7, markersize=4)
    ax1.axhline(med, color="tab:orange", linestyle="--", linewidth=1, label=f"median {med:.0f}s")
    ax1.set_xlabel("extraction # (sequence across all ingests on this platform instance)")
    ax1.set_ylabel("extraction wall time (s)")
    ax1.set_title(f"Per-extraction time (n={len(times)})")
    ax1.grid(True, alpha=0.3)
    ax1.legend()

    ax2.hist(times, bins=30, color="tab:blue", edgecolor="white")
    ax2.axvline(med, color="tab:orange", linestyle="--", linewidth=1, label=f"median {med:.0f}s")
    ax2.set_xlabel("extraction wall time (s)")
    ax2.set_ylabel("count")
    ax2.set_title("Distribution")
    ax2.legend()

    fig.suptitle(
        f"Mnemo extraction times — median {med:.0f}s, mean {mean:.0f}s, "
        f"min {min(times):.0f}s, max {max(times):.0f}s",
        fontsize=13,
    )
    fig.tight_layout()

    out = Path("results/extraction-times.png")
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=110)

    recent = times[-10:]
    print(f"saved: {out.resolve()}")
    print(f"n={len(times)}  median={med:.0f}s  mean={mean:.0f}s  min={min(times):.0f}s  max={max(times):.0f}s")
    print(f"last 10 extractions (s): {[round(t) for t in recent]}")
    print(f"recent median: {statistics.median(recent):.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
