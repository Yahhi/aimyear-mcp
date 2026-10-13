#!/bin/sh
# MCP calls from Cloud Logging, one line each, then grouped into sessions:
# same user + client, a new group after 15 minutes of silence. Usage: scripts/mcp-calls.sh [freshness, default 1d]
set -eu
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="aimyear-mcp" AND jsonPayload.evt="mcp_call"' \
  --project aimyear-app --freshness "${1:-1d}" --limit 2000 --format json |
python3 -c '
import json, sys, collections
rows = sorted((e["jsonPayload"] for e in json.load(sys.stdin)), key=lambda r: r.get("ms_epoch", 0))
print(f"{len(rows)} calls")
tools = collections.Counter((r.get("tool") or r.get("method"), r.get("ok")) for r in rows)
for (name, ok), n in tools.most_common(): print(f"  {n:4}  {name}{"" if ok else "  (failed)"}")
print("\nsessions (user + client, 15 min gap):")
groups, last = collections.defaultdict(list), {}
for r in rows:
    k = (r.get("user") or "anonymous", r.get("client", "?"))
    if k in last and r["ms_epoch"] - last[k] > 15 * 60 * 1000: groups[k].append("|")
    last[k] = r["ms_epoch"]
    groups[k].append((r.get("tool") or r.get("method")) + ("" if r.get("ok") else "✖"))
for (user, client), seq in groups.items():
    for part in " ".join(seq).split(" | "): print(f"  {user[:10]} {client[:40]}: {part.replace(" ", " → ")}")
'
