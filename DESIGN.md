# Design Document — Search Typeahead

## The one idea everything follows from

A typeahead is a read machine. Every keystroke is a read. A submitted search —
the only write — happens maybe once per dozens of keystrokes, and even then the
user does not care whether the count lands a few seconds late. So the entire
system is shaped around one asymmetry: **reads are constant and must be cheap;
writes are rare and can be deferred, aggregated, and made approximate.** Almost
every decision below is a direct consequence of that sentence. If a choice ever
seems over-engineered, ask "is this making reads cheaper or writes lazier?" and
it usually is.

## Dataset

I used the AOL query log (the "AOL User Session Collection" on Kaggle —
https://www.kaggle.com/datasets/dineshydv/aol-user-session-collection-500k):
roughly 20 million real search events from ~650k users over three months in
2006. It is the largest public corpus of genuine, messy, human-typed search
queries, which is exactly what a typeahead needs to look real.

The raw log is one row per *event* — user id, query text, timestamp, clicked
URL. The assignment wants a `(query, count)` table, but the log has events, not
counts, so the count is derived by aggregation: normalize each query, group, and
count rows. Normalization is lowercase + trim, and I drop the `-` token the log
uses for an empty query (left in, it would dominate the rankings as pure noise).
One file of ~3.6M events collapses to ~1.24M distinct queries — comfortably past
the 100k minimum.

On the AOL log's history: it was pulled in 2006 because the *user-level* data
could be de-anonymized. That does not touch this project, because ingestion
keeps only the query string and throws away every user-identifying column before
anything is written. The query text itself is not the sensitive part.

## Two paths, four stores

The system has exactly two code paths — a read path and a write path — and four
places data lives. The four stores are not redundant; each does a job the others
can't.

| Store | Lives in | Durable? | Job |
|---|---|---|---|
| Postgres | disk | yes | canonical `(query, count)` — the truth |
| Trie | RAM | no | fast prefix lookups, rebuilt from Postgres at boot |
| Distributed cache | RAM | no | finished answers for hot prefixes |
| Write buffer | RAM | no | tally recent submissions, flush in bulk |

The split worth being able to defend in one breath is **Postgres vs the trie**:
Postgres is the durable truth, the trie is a fast volatile *index built from it*.
Durability and read speed are different problems, so they get different
structures. The honest cost: between a write and the next flush+rebuild, the trie
and Postgres disagree slightly. That is fine — this is ranking data, and a count
that is stale by a few seconds never changes which ten suggestions show up.

## The read path

Runs on every keystroke, so it has to be close to free.

### Why a trie

The question is "everything starting with `ip`, top 10 by count, fast." A flat
list re-scans the whole dataset per keystroke. A sorted array lets you binary
-search to the matching block but is painful to keep sorted and does nothing for
ranking. A trie — a tree of characters where shared prefixes share a path — gets
you to the `ip` subtree in two steps regardless of dataset size. The walk cost is
the length of the prefix, not the number of queries.

I'll be straight about scale: at 100k–1.24M rows on one machine, a sorted array
would also be fast enough. The trie earns its place because inserts are clean (a
new query adds a few nodes, nothing shifts) and because it sets up the ranking
trick below. It's the right structure at real scale, not a crutch the demo needs.

### Per-node top-K — pushing the cost to write time

Finding matches is only half the job; the other half is returning the *ten best*,
sorted. Scanning and sorting all matches on every read is the lazy version — for
a broad prefix like `i` that's thousands of entries per keystroke.

So every trie node stores its own top-10 list, computed once. A read becomes
"walk to the node, return its stored list" — no scan, no sort, no matter how many
queries sit beneath it. The work moves to build/write time, where it belongs in a
read-heavy system. I keep the full list materialized at each node rather than
recomputing on read because here the scarce resource is read latency, not memory.
If memory ever became the bottleneck, the fix is to materialize only the shallow,
high-traffic nodes and recompute the deep, rarely-touched ones live.

(A JS-specific note, since this is a port: a trie over 1.24M queries is millions
of nodes, and JS objects are heavier than Go structs. Two tricks keep it inside a
normal heap without changing the design — there is exactly one suggestion object
per query that every list references rather than copies, and a non-branching
chain of nodes shares one top-K array by reference. Same algorithm, fewer
allocations.)

### Cache in front of the trie

Even a fast trie shouldn't be walked on literally every request. A cache sits in
front, mapping a prefix straight to its finished top-10 list:

1. Hash the prefix and pick its owning cache node (next section).
2. Hit → return the stored list, never touch the trie.
3. Miss → walk the trie, store the result with a TTL, return it.

Entries leave for two reasons. **Staleness** is handled by a per-entry TTL: an
entry past its expiry is treated as a miss and recomputed lazily — no background
sweeper. **Capacity** is handled by LRU: when a node is full, the least-recently
-used prefix is evicted. I lean on TTL rather than active invalidation on purpose:
suggestions tolerate being seconds out of date, TTL needs zero bookkeeping, and
the precision of explicit invalidation isn't worth its complexity for ranking.

## Distributing the cache with consistent hashing

The assignment requires the cache spread across nodes, with consistent hashing
choosing the owner of each prefix.

Honest framing first: at this scale one in-memory cache would be plenty. You
distribute a real cache for capacity (data outgrows one box's RAM), throughput
(one box can't serve the rate), and fault isolation (one box dying shouldn't wipe
everything). None of those bite a local demo. I build it distributed to show the
pattern on something small enough to actually watch. The nodes are *logical*:
each is an object owning its own `Map`. In Go this needed a goroutine-per-node so
the map had a single owner; in Node the event loop already runs handlers one at a
time, so a plain `Map` is race-free for free and the "node" is just the unit
consistent hashing routes to — and the unit you'd later promote to a separate
process or a Redis instance.

Why not `hash(prefix) % N`? It works until N changes. Add or remove a node and the
divisor changes, so nearly every key remaps at once: the whole cache goes cold and
every request stampedes the trie. That stampede is the exact failure consistent
hashing prevents.

Consistent hashing puts nodes *and* keys on a ring of hash values; a key belongs
to the first node clockwise from it. Add or drop a node and only the keys in that
node's arc move — about 1/N of them — while everyone else keeps their owner. One
refinement matters: **virtual nodes.** A single ring position per node produces
wildly uneven arcs and an overloaded node. Placing each physical node at many
positions evens the load and, when a node dies, scatters its keys across many
survivors instead of dumping them all on one neighbour. I use a CRC32 hash and 100
virtual positions per node.

`GET /cache/debug?prefix=` makes this observable — it reports the owning node and
whether the prefix is currently cached — and the `ringtest` utility demonstrates
the remap directly: list owners with 3 nodes, add a 4th, show that only a handful
moved.

## Batched, aggregated writes

Writing to Postgres on every submission would bury it under tiny writes and make
it the bottleneck — exactly the thing the read-heavy design is trying to avoid. So
submissions don't write through.

They land in an in-memory buffer that *tallies* them. The real win is aggregation,
not just batching: three searches for `iphone` don't become three writes, they
become one `+3`; a query searched a thousand times in one window becomes a single
`+1000`. The database ends up seeing one write per distinct query per flush
instead of one per search.

The buffer flushes on whichever comes first — a timer (so nothing sits forever) or
a size cap on distinct queries (so a spike can't grow it without bound). Both
triggers swap the tally for a fresh empty map *before* persisting, so searches
arriving mid-flush aren't lost.

The cost is durability: a hard crash drops whatever is buffered, because it only
ever lived in RAM. I accept that, because losing a few increments out of hundreds
of thousands doesn't change any ranking. If this were money or orders I'd choose
the opposite — a write-ahead log, or synchronous writes — and that context
-dependence is the whole point. To shrink the loss window without changing the
model, the clean-shutdown path flushes first; to shrink it further you'd add a WAL
(append to disk before buffering, replay on restart) or shorten the flush
interval, trading back some batching. Durability and write-reduction sit on one
dial.

## Trending — recency without permanent over-ranking

Basic ranking is by all-time count (the bulk of the marks). The upgrade is
recency: a query blowing up *today* should be allowed to climb over an all-time
giant like `iphone`, even with a far smaller lifetime count. The trap the
assignment names explicitly is that a brief spike must not rank highly *forever* —
which kills the naive `score = count + recentCount`, because that bonus never
fades. The recency signal has to decay.

I use **exponential time decay**. Each query keeps two numbers: a decaying score
and the timestamp it was last touched. On a new search the stored score is first
decayed forward to now, *then* the boost is added:

```
dt    = now - lastSeen
score = score · e^(−λ·dt) + boost
```

When ranking, the score is decayed forward to now and read without adding a boost.
The final order blends both signals:

```
final = allTimeCount + weight · recencyScore
```

Two things to defend here. First, the per-search boost is just `1`; its absolute
value is irrelevant because `weight` rescales the entire recency term — the real
tuning lives in `weight`. Second, *why exponential decay specifically* and not some
other fade: exponential decay is **composable** — decaying once across a two-minute
gap gives precisely the same result as decaying minute-by-minute. That property is
the only reason I can store one number per query instead of a full event history.
A different curve would break the shortcut and force me to keep a list of every
search. The math was chosen to enable the data structure, not for its own sake.

That leaves two knobs:
- **half-life (λ):** how fast trends fade — short is twitchy, long is sluggish;
- **weight:** how far a hot trend can climb over an all-time favourite — too high
  and noise wins, too low and recency never shows.

Because trending order changes with the clock and not just with new searches,
cached lists would go stale almost immediately. Rather than fight that, the
trending path **bypasses the cache** and reranks live from the trie:
`/suggest?q=…&mode=trending` computes per request, while the default `/suggest`
stays cached and count-ranked. This keeps the basic path fast and cached, confines
the recompute cost to requests that actually ask for recency, and demonstrates the
two ranking modes side by side. The trade-off is explicit and deliberate: the
trending path does more work and is uncached, because caching a continuously
decaying order would just serve stale rankings — that's the freshness-vs-latency
choice, made by separating the paths rather than forcing recency through the cache.

The five things the assignment asks me to explain map straight onto this:
1. **Recent searches are tracked** as one decaying score + timestamp per query.
2. **Recent activity affects ranking** through the weighted recency term.
3. **Brief spikes don't over-rank permanently** because the term decays to zero
   once searches stop.
4. **The cache stays correct** because the trending path doesn't touch it; the
   cached basic path is unaffected by recency.
5. **The trade-offs** are freshness vs latency (live recompute vs a stale cache)
   and freshness vs complexity (a flat count is trivial; decay is more moving
   parts), plus the decay-vs-sliding-window choice — I picked decay for its smooth
   fade and the single-number storage trick.

## APIs

```
GET  /suggest?q=<prefix>[&mode=trending]   up to 10 matches, by count or recency-blended
POST /search                               records a submission, returns {"message":"Searched"}
GET  /cache/debug?prefix=<p>               owning node + hit/miss, for demonstrating hashing
GET  /cache/stats                          per-node hits / misses / size
GET  /stats                                write-buffer counters (received, flushes, rows)
```

`/suggest` is the hot read path (cache first, trie on miss). `/search` is the cold
write path: it returns the stub *immediately*, then records into the buffer and
bumps the recency score without blocking on any DB work. `/cache/debug` exists
purely to make the hashing observable for the demo and the report.

## End to end

**Read — user types `ip`:**
1. Frontend debounces, calls `GET /suggest?q=ip`.
2. Server hashes `ip` on the ring, picks the owning cache node.
3. Hit → return the stored top 10 instantly.
4. Miss → walk the trie (`i`→`p`, read the precomputed list), store it with a TTL,
   return it.

**Write — user submits `iphone`:**
1. Frontend calls `POST /search`.
2. Server returns `{"message":"Searched"}` right away — the user never waits on PG.
3. Server tallies `iphone +1` in the buffer and bumps its recency score.
4. On the next flush trigger, the buffer aggregates and bulk-writes to Postgres.
5. Affected cache entries expire by TTL and are recomputed on the next miss.

## Packaging

The whole system is containerized so a marker can run it with one command. The
app (Node + the server) and Postgres are separate services in `docker-compose`,
connected over the compose network; the app reads `DATABASE_URL` from its
environment rather than hard-coding a host, which is what lets the same code run
against `localhost:5433` on a dev machine and `postgres:5432` inside the network
with no change. Dataset loading is a third, one-off service (`ingest`) behind a
compose profile so it doesn't run on every boot — it mounts the dataset file,
loads it, and exits. The app creates its table on startup, so the stack comes up
cleanly even before any data is loaded. This mirrors the logical layering of the
design: a stateless app process, a stateful database, and a batch loader, each in
its own container.

## What changes at real scale

Most of the distribution here is pedagogical, and I'd rather say so than pretend a
single-box demo needs a cluster. At real scale the cache nodes become separate
processes or Redis instances, the trie gets sharded or replaced by a purpose-built
suggestion service, and the write buffer becomes a durable queue or log. The
*shapes* above are correct for those; the demo just simulates them in one process.
The value of the exercise is understanding why each pattern exists and what it
costs — which is exactly what the viva checks.
