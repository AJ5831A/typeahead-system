# Search Typeahead

A search-as-you-type service. As you type, it suggests the most popular queries
that begin with your prefix, ranked by popularity; submitting a search records it
and nudges the rankings. Suggestions are served from a distributed in-process
cache sitting in front of an in-memory trie, with Postgres as the durable source
of truth. A recency-aware "trending" mode boosts recently-searched queries, and
search-count writes are batched so the database never sees a write per keystroke.

Written in **TypeScript** on Node.js (Express + node-postgres). The frontend is a
single static page served by the same process.

## Features

- Prefix suggestions — top 10 by count, case-insensitive, empty/no-match handled
- Search submission with a stub response, recorded into popularity counts
- Distributed cache over logical nodes, routed by consistent hashing (CRC32 ring)
- Trending mode — recency-aware ranking via exponential time decay
- Batched, aggregated writes — submissions are tallied and flushed in bulk
- A live web UI that surfaces cache hit/miss, owning node, latency, and write
  reduction for every request

## Architecture

```mermaid
graph TB
    subgraph Client["FRONTEND (static page)"]
        UI["Search box · Suggestion dropdown · Trending panel · Live stats"]
    end

    subgraph Server["BACKEND (Node + Express)"]
        direction TB
        H["HTTP handlers<br/>/suggest · /search · /cache/* · /stats"]
        RING["Consistent-hash ring<br/>(CRC32, virtual nodes)"]
        TREND["Trending scorer<br/>(exponential decay, one score/query)"]
        H --> RING
    end

    subgraph CacheLayer["DISTRIBUTED CACHE (logical nodes, in-process)"]
        direction LR
        N0["node0<br/>prefix→top-10<br/>TTL + LRU"]
        N1["node1<br/>prefix→top-10<br/>TTL + LRU"]
        N2["node2<br/>prefix→top-10<br/>TTL + LRU"]
    end

    subgraph Serving["IN-MEMORY INDEX"]
        TRIE["Trie<br/>prefix walk + per-node top-10<br/>(volatile, rebuilt from Postgres)"]
    end

    subgraph WriteSide["WRITE PATH"]
        BUF["Write buffer<br/>(tally, aggregates repeats)<br/>flush on time OR size"]
    end

    subgraph Truth["SOURCE OF TRUTH"]
        PG[("Postgres<br/>query→count<br/>durable, survives restart")]
    end

    UI -->|"GET /suggest?q=ip (debounced)"| H
    UI -->|"POST /search"| H

    RING -->|"read: pick owner"| N0
    RING --> N1
    RING --> N2

    N0 -.->|"miss"| TRIE
    N1 -.->|"miss"| TRIE
    N2 -.->|"miss"| TRIE

    TREND -.->|"recency feeds rerank"| TRIE

    H -->|"write: record search"| BUF
    H -->|"bump recency"| TREND
    BUF -->|"bulk flush (aggregated)"| PG
    PG -->|"startup: load + build"| TRIE
```

Four storage layers, each with a distinct job:

- **Postgres** — durable source of truth (`query, count`); survives restarts and
  receives batched writes.
- **Trie** — in-memory prefix index built from Postgres at startup; answers prefix
  queries fast via a precomputed top-10 at each node. Volatile; rebuilt on boot.
- **Distributed cache** — finished suggestion lists for hot prefixes, spread across
  logical nodes and routed by a consistent-hash ring.
- **Write buffer** — tallies submissions in memory and flushes to Postgres in
  batches.

The full reasoning is in [DESIGN.md](DESIGN.md); measured numbers are in
[PERFORMANCE.md](PERFORMANCE.md). The whole design follows from one fact: reads
(every keystroke) vastly outnumber writes (submissions), so reads are made nearly
free and writes are deferred and batched.

## Setup

Requirements: **Node 20+**, **Docker** (for Postgres), and the AOL query dataset.

### 1. Install dependencies

```
npm install
```

### 2. Start Postgres

```
docker compose up -d
```

Postgres listens on host port **5433** (not 5432) to avoid colliding with any
local Postgres. The default connection string in the code already uses 5433; you
can override it with `DATABASE_URL`.

### 3. Get the dataset

This uses the AOL query log (Kaggle: "AOL User Session Collection"). Download and
unzip it; you'll get tab-separated files named `user-ct-test-collection-NN.txt`.

The dataset is **not** committed — it's large and, given the AOL log's history, not
ours to redistribute. Ingestion keeps only the query text; every user-identifying
column (user id, timestamps, clicked URLs) is discarded.

### 4. Ingest

```
npm run ingest -- --file=user-ct-test-collection-02.txt
```

This reads the file, normalizes queries (lowercase, trim, drop empty/`-`), tallies
counts in memory, and bulk-loads `(query, count)` into Postgres. One file yields
~1.24M unique queries. (Counting note: every appearance of a query counts toward
its popularity — a popularity proxy, not a strict event count. See DESIGN.md.)

### 5. Run the server

```
npm run server
```

It streams Postgres into the trie at startup (~15s for the full dataset), then
serves on **:8080**. The server runs with a raised Node heap
(`--max-old-space-size=4096`) because a trie over 1.24M queries is millions of
nodes — see DESIGN.md for the memory notes.

### 6. Open the UI

Visit **http://localhost:8080/**. Type a prefix (`goog`, `map`, `ebay`), use the
arrow keys to navigate, Enter or the Search button to submit. The panels show what
each request did: latency, cache hit/miss, owning node, and live write-buffer
stats.

## API

| Method | Path | Purpose | Notes |
|---|---|---|---|
| GET | `/suggest?q=<prefix>` | Top 10 prefix matches by count | Add `&mode=trending` for recency-aware ranking |
| POST | `/search` | Record a search, return stub | JSON body `{"query":"…"}`, returns `{"message":"Searched"}` |
| GET | `/cache/debug?prefix=<p>` | Owning node + hit/miss | For demonstrating consistent hashing |
| GET | `/cache/stats` | Per-node hits/misses/size | |
| GET | `/stats` | Write-buffer stats | searches received, flushes, rows written |

### Examples

```bash
# basic suggestions
curl "http://localhost:8080/suggest?q=goog"

# trending (recency-aware) suggestions
curl "http://localhost:8080/suggest?q=goog&mode=trending"

# submit a search (Content-Type header required — Express parses JSON by type)
curl -X POST http://localhost:8080/search \
  -H "Content-Type: application/json" -d '{"query":"iphone"}'

# which node owns this prefix, and is it cached?
curl "http://localhost:8080/cache/debug?prefix=goog"
```

## Demonstrations

### Consistent hashing

```
npm run ringtest
```

Prints the owner of each sample prefix with 3 nodes, then adds a 4th and reports
how many moved. Only keys in the new node's arcs move; the rest keep their owner —
the consistent-hashing property (a node change remaps ~1/N of keys, not nearly
all).

### Performance

```
./scripts/benchmark.sh
```

Measures p95 latency (cache path vs trie path), cache hit rate, and write
reduction through batching. Requires `hey` (`brew install hey`). Results and
interpretation are in [PERFORMANCE.md](PERFORMANCE.md).

### Trending rise-and-fall

In the UI, switch to trending mode and watch a low-ranked query climb after a
burst of searches, then fall back as its recency score decays. The half-life is
configurable in the server config (`trendingHalfLifeMs`) — set it short for a live
demo.

## Project layout

```
src/
  server.ts        entrypoint: config, wiring, lifecycle
  ingest.ts        one-time AOL loader
  ringtest.ts      consistent-hashing demonstration
  store/store.ts   Postgres source of truth
  trie/trie.ts     in-memory prefix index with per-node top-K
  cache/
    cache.ts       distributed cache facade
    ring.ts        consistent-hash ring (CRC32 + virtual nodes)
    node.ts        one logical cache node (TTL + LRU)
  buffer/buffer.ts write buffer (batching + aggregation)
  trending/trending.ts  recency scorer (exponential decay)
  api/handlers.ts  Express routes
web/
  index.html       frontend
scripts/
  benchmark.sh     performance measurement
```

## Notes and trade-offs

- Cache nodes are logical (objects in one process), simulating distribution. In
  production they'd be separate processes or Redis instances; the consistent-hash
  routing is identical either way.
- Batching means a hard crash loses buffered-but-unflushed searches — acceptable
  for ranking data; the clean-shutdown path flushes to shrink the window.
- The trie's top-K is computed once at startup. Live count changes go to Postgres
  via the buffer; the trie can be rebuilt periodically or tolerate slight
  staleness, which is fine for ranking.
- See [DESIGN.md](DESIGN.md) for the reasoning behind every choice.
