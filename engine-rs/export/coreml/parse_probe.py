"""Summarise an ep_probe.py log (first GetCapability pass = the real partitioning of the main graph)."""
import sys, re, collections
for f in sys.argv[1:]:
    L = open(f, errors="replace").read().splitlines()
    first = next((i for i, l in enumerate(L) if "GetCapability, number of partitions" in l), len(L))
    summ = re.sub(r".*GetCapability, ", "", L[first]).replace("\x1b[m", "") if first < len(L) else "no GetCapability line"
    start = next((i for i, l in enumerate(L) if "GetSupportedNodes] Operator type" in l), first)
    unsup = collections.Counter(); sup = collections.Counter(); reasons = collections.defaultdict(collections.Counter)
    buf = []
    for l in L[start - 5:first]:
        m = re.search(r"Operator type: \[(\w+)\] index: \[\d+\] name: \[[^\]]*\] supported: \[(\d)\]", l)
        if m:
            if m.group(2) == "0":
                unsup[m.group(1)] += 1
                det = [b for b in buf if "IsOpSupported] Operator [" not in b]
                why = re.sub(r"^.*?\.(cc|h):\d+ \w+\] ", "", det[0]) if det else "(no reason logged)"
                why = re.sub(r"\[[^\]]*(val_|node_|_)[^\]]*\]", "[..]", why)
                why = re.sub(r"'[^']*'", "'..'", why)
                why = re.sub(r"\d+", "#", why)[:120]
                reasons[m.group(1)][why] += 1
            else:
                sup[m.group(1)] += 1
            buf = []
        elif "[V:" in l or "[W:" in l:
            buf.append(l.replace("\x1b[m", ""))
    ok = [l for l in L if l.startswith("SESSION_OK")]
    err = [l[-300:] for l in L if "Exception" in l or "Error" in l][:2]
    m = re.search(r"partitions supported by CoreML: (\d+) number of nodes in the graph: (\d+) number of nodes supported by CoreML: (\d+)", summ)
    head = f"partitions {m.group(1)}, nodes {m.group(3)}/{m.group(2)} ({100*int(m.group(3))/int(m.group(2)):.1f}%)" if m else summ
    print("=====", f.split("/")[-1], "|", head, "|", ok[0].split()[-1] if ok else "SESSION FAILED: " + " | ".join(err))
    for op, c in unsup.most_common():
        print(f"   {op}: {c} unsupported ({sup[op]} supported) -", "; ".join(f"{w} (x{k})" for w, k in reasons[op].most_common(3)))
