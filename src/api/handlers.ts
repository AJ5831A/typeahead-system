/**
 * handlers.ts — the HTTP surface.
 *
 *   GET  /suggest?q=<prefix>[&mode=trending]   the hot read path
 *   POST /search                               the cold write path
 *   GET  /cache/debug?prefix=<p>               which node owns a prefix, hit/miss
 *   GET  /cache/stats                          per-node hit/miss/size
 *   GET  /stats                                write-buffer counters
 *
 * /suggest reads cache-first and falls back to the trie on a miss. /search
 * returns the stub immediately and records the submission asynchronously, so
 * the client never waits on database work.
 */

import { Router, type Request, type Response } from "express";
import type { Trie, Suggestion } from "../trie/trie.js";
import type { DistributedCache } from "../cache/cache.js";
import type { WriteBuffer } from "../buffer/buffer.js";
import type { TrendingScorer } from "../trending/trending.js";

export interface Deps {
  trie: Trie;
  cache: DistributedCache;
  buffer: WriteBuffer;
  trending: TrendingScorer;
  /** weight on the recency term in the trending blend */
  weight: number;
}

/** Normalize user input the same way ingestion did: lowercase, trimmed. */
function normalize(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

export function buildRouter(deps: Deps): Router {
  const router = Router();

  router.get("/suggest", (req: Request, res: Response) => {
    const prefix = normalize(req.query.q);
    const mode = req.query.mode;

    // empty/missing prefix is valid input — just nothing to suggest
    if (prefix === "") {
      res.json([]);
      return;
    }

    // trending path: bypass the cache and rerank live, because a continuously
    // decaying order would be stale the moment it's cached
    if (mode === "trending") {
      const base = deps.trie.search(prefix);
      const reranked = deps.trending.rerank(base, deps.weight);
      res.json(reranked.map(({ query, count }) => ({ query, count })));
      return;
    }

    // basic path: cache first, trie on miss, then populate the cache
    const cached = deps.cache.get(prefix);
    if (cached) {
      res.json(cached);
      return;
    }
    const suggestions: Suggestion[] = deps.trie.search(prefix);
    deps.cache.set(prefix, suggestions);
    res.json(suggestions);
  });

  router.post("/search", (req: Request, res: Response) => {
    const query = normalize(req.body?.query);
    if (query === "") {
      res.status(400).json({ error: "empty query" });
      return;
    }

    // record without blocking the response: tally for batched persistence and
    // bump the recency score so trending reflects it
    deps.buffer.add(query);
    deps.trending.record(query);

    res.json({ message: "Searched" });
  });

  router.get("/cache/debug", (req: Request, res: Response) => {
    const prefix = normalize(req.query.prefix);
    const { node, hit } = deps.cache.debug(prefix);
    res.json({ prefix, node, hit });
  });

  router.get("/cache/stats", (_req: Request, res: Response) => {
    res.json(deps.cache.allStats());
  });

  router.get("/stats", (_req: Request, res: Response) => {
    const s = deps.buffer.stats();
    res.json({
      searches_received: s.searchesReceived,
      db_flushes: s.dbFlushes,
      rows_written: s.rowsWritten,
    });
  });

  return router;
}
