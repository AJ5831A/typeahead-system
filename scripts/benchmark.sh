#!/usr/bin/env bash
#
# benchmark.sh — reproducible performance measurement for the typeahead system.
#
# Produces the three numbers the performance report needs:
#   1. p95 latency on /suggest — cache-hit path vs trie (cache-bypassed) path
#   2. cache hit rate
#   3. write reduction through batching
#
# Prerequisites:
#   - server running on :8080            (npm run server)
#   - `hey` HTTP load generator          (brew install hey)
#
# Usage:  ./scripts/benchmark.sh
#
set -euo pipefail

BASE="http://localhost:8080"
N=5000   # requests per latency test
C=50     # concurrency

rule() { printf '%s\n' "------------------------------------------------------------"; }

echo
echo "TYPEAHEAD PERFORMANCE BENCHMARK"
echo "requests/test: $N   concurrency: $C"
rule

# ---------------------------------------------------------------------------
# 1. LATENCY — CACHE-HIT PATH
# Hammer one hot prefix. After the first request it stays cached, so nearly
# every response is a cache hit: best-case served-from-cache latency.
# ---------------------------------------------------------------------------
echo
echo "[1/4] Latency — cache HIT path (hot prefix 'goog')"
echo
curl -s "$BASE/suggest?q=goog" > /dev/null   # warm it once
hey -n "$N" -c "$C" "$BASE/suggest?q=goog" | grep -A 8 "Latency distribution"
rule

# ---------------------------------------------------------------------------
# 2. LATENCY — TRIE PATH (cache bypassed)
# Trending mode computes live from the trie, so this isolates the trie lookup
# plus rerank cost with no cache help.
# ---------------------------------------------------------------------------
echo
echo "[2/4] Latency — trie path, cache bypassed (trending mode)"
echo
hey -n "$N" -c "$C" "$BASE/suggest?q=goog&mode=trending" | grep -A 8 "Latency distribution"
rule

# ---------------------------------------------------------------------------
# 3. CACHE HIT RATE
# Drive a few popular prefixes repeatedly, then read /cache/stats.
# ---------------------------------------------------------------------------
echo
echo "[3/4] Cache hit rate (repeated popular prefixes)"
echo
for p in goog map ebay yaho; do
  for _ in $(seq 1 200); do curl -s "$BASE/suggest?q=$p" > /dev/null; done
done

echo "per-node cache stats:"
curl -s "$BASE/cache/stats"
echo
echo
curl -s "$BASE/cache/stats" | tr ',' '\n' | grep -o '"hits":[0-9]*\|"misses":[0-9]*' \
  | awk -F: '/hits/{h+=$2} /misses/{m+=$2} END{
      if (h+m>0) printf "aggregate hit rate: %.1f%% (%d hits / %d total)\n", 100*h/(h+m), h, h+m;
      else print "no cache traffic recorded";
    }'
rule

# ---------------------------------------------------------------------------
# 4. WRITE REDUCTION THROUGH BATCHING
# Fire many submissions across a few repeated queries. The buffer aggregates
# repeats, so DB rows written << searches received.
# ---------------------------------------------------------------------------
echo
echo "[4/4] Write reduction through batching"
echo
SEARCHES=1000
echo "submitting $SEARCHES searches across 5 repeated queries..."
for i in $(seq 1 "$SEARCHES"); do
  case $((i % 5)) in
    0) Q="iphone";;
    1) Q="ipad";;
    2) Q="macbook";;
    3) Q="airpods";;
    *) Q="ipod";;
  esac
  curl -s -X POST "$BASE/search" -H "Content-Type: application/json" -d "{\"query\":\"$Q\"}" > /dev/null
done

echo "waiting 6s for the buffer to flush..."
sleep 6

echo "write-buffer stats:"
curl -s "$BASE/stats"
echo
echo
curl -s "$BASE/stats" | tr ',' '\n' | grep -o '"searches_received":[0-9]*\|"rows_written":[0-9]*' \
  | awk -F: '/searches_received/{s=$2} /rows_written/{r=$2} END{
      if (r>0) printf "write reduction: %d searches -> %d db rows  (%.1fx fewer writes)\n", s, r, s/r;
    }'
rule
echo
echo "done."
echo
