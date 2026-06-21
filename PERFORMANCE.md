# Performance Report

Every number here comes from `scripts/benchmark.sh`, run against the server on
`localhost:8080` with the full AOL dataset loaded (~1.24M unique queries). The
script is reproducible: start the server, run it, get these figures.

Setup: 5000 requests per latency test at concurrency 50, via `hey`. Latency is
measured end-to-end from the client, so it includes HTTP and JSON serialization,
not just internal compute — deliberately the number a real client would see.

## Summary

| Metric | Result |
|---|---|
| p95 latency, cache-hit path | ~2.6 ms |
| p95 latency, trie path (cache bypassed) | ~2.7 ms |
| Cache hit rate (repeated-prefix traffic) | 99.9% |
| Write reduction through batching | 200× (1000 searches → 5 DB rows) |

## 1. Latency

Two paths were measured. The **cache-hit path** hammers one hot prefix, so after
the first request every response is served from the cache. The **trie path** uses
trending mode, which bypasses the cache and computes live from the trie, isolating
the trie walk + rerank cost.

```
cache-hit path:   p50 1.6ms   p95 2.6ms   p99 13.9ms
trie path:        p50 1.3ms   p95 2.7ms   p99  3.8ms
```

The headline finding: **the two paths are essentially equal at p95.** The cache
buys no latency here. That's expected once you look at what a trie read actually
does — walk down a handful of `Map` lookups and hand back a precomputed 10-element
list. That's already microsecond-scale work, so there is nothing for the cache to
speed up; both layers are simply fast.

This does **not** make the cache pointless — its value is architectural, not local.
It's the layer that distributes across nodes via consistent hashing and that would
absorb load if the underlying store were slow or remote (a real database over the
network rather than an in-memory trie). On one machine with an in-memory index, the
cache and trie just measure the same. The honest reading: at this scale the cache
earns its place as a distribution/scaling mechanism, not as a local speedup.

Worth noting is the cache path's heavier tail (p99 13.9ms vs the trie's 3.8ms).
The cache path mutates its `Map` on every single hit — the LRU bookkeeping
deletes and re-inserts the entry to mark it most-recently-used — whereas the trie
path only reads a fixed-size list and reranks it, retaining nothing. That extra
per-request allocation churn gives the garbage collector more to do, and GC pauses
show up in the tail. It's a real, if small, cost of LRU recency tracking; if the
tail mattered you'd track recency more cheaply (e.g. a coarse clock/second-chance
scheme instead of move-to-front on every read).

(These are Node/Express figures — somewhat above what a compiled server would post,
which is the expected cost of the runtime. Sub-3ms p95 with the full dataset loaded
is comfortably within "low latency" for a typeahead.)

## 2. Cache hit rate

Driving repeated popular prefixes (`goog`, `map`, `ebay`, `yaho`, 200 requests
each):

```
node0:  398 hits /  2 misses   (size 2)
node1: 5200 hits /  1 miss     (size 1)
node2:  199 hits /  1 miss     (size 1)
aggregate: 99.9% (5797 / 5801)
```

The rate is very high, but by construction: the test repeats a small set of
prefixes, so after the first miss each one is cached and every later request hits.
That's realistic for head queries (a few prefixes carry most traffic) but
optimistic for the long tail, where diverse, rarely-repeated prefixes miss more
often. The takeaway is that the cache works and serves repeated prefixes from
memory; the exact percentage is a property of the access pattern.

The per-node split also shows the ring routing at work: `node1` happened to own the
hottest prefixes and so did most of the work. Load is lumpy across only four
distinct keys — exactly the small-sample unevenness that virtual nodes smooth out
as the number of distinct keys grows.

## 3. Write reduction through batching

Submitting 1000 searches across only 5 distinct queries, then letting the buffer
flush:

```
searches received: 1000
db flushes:           1
rows written:         5
reduction:          200×
```

1000 submissions became 5 database rows — a 200× reduction. The mechanism is
aggregation: repeated queries are tallied in memory and collapsed into one
increment per query per flush, so the database sees one write per *distinct* query
rather than one per search.

In this run all 1000 submissions fit inside a single flush window, so it was 5 rows
(200×). Had the 5-second timer fired partway through, each of the 5 queries would
be written once per flush — e.g. two flushes → 10 rows (100×). Either way the point
holds: write volume to the durable store is decoupled from search volume; it scales
with *distinct queries per flush interval*, not with raw traffic.

## Trade-offs reflected in these numbers

- **Cache:** trades memory and a small tail-latency cost (LRU bookkeeping → GC
  churn) for a distribution layer that doesn't pay off locally but is the right
  shape at scale. Reported honestly — no local speedup, clear architectural role.
- **Batching:** trades durability for write reduction. The 100–200× fewer writes
  cost you whatever sits in the buffer if the process is hard-killed between
  flushes. Acceptable for ranking data; clean shutdown flushes to shrink the window.
- **Per-node top-K in the trie:** trades build-time work (computing the lists once)
  for near-zero read cost — which is why read latency is so low. The right trade
  for a workload where reads vastly outnumber writes.
