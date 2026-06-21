/**
 * server.ts — wires the pieces together and runs the HTTP server.
 *
 * Startup order matters: open Postgres, stream the whole table into the trie
 * and compute its top-K lists, then bring up the cache, write buffer, and
 * trending scorer, and only then start listening.
 */

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Store } from "./store/store.js";
import { Trie } from "./trie/trie.js";
import { DistributedCache } from "./cache/cache.js";
import { WriteBuffer } from "./buffer/buffer.js";
import { TrendingScorer } from "./trending/trending.js";
import { buildRouter } from "./api/handlers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- config (env-overridable, with sane local defaults) ----------------------
const CONFIG = {
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://typeahead:typeahead@localhost:5433/typeahead",
  port: Number(process.env.PORT ?? 8080),
  topK: 10,
  // write buffer: flush at 1000 distinct queries or every 5s, whichever first
  bufferMaxDistinct: 1000,
  bufferFlushMs: 5_000,
  // distributed cache: 3 nodes, 100 vnodes each, 60s TTL, 1000 entries/node
  cacheNodes: 3,
  cacheVirtualNodes: 100,
  cacheTtlMs: 60_000,
  cacheCapacity: 1_000,
  // trending: 30s half-life, recency weight on the final blend
  trendingHalfLifeMs: 30_000,
  trendingWeight: 5_000,
};

async function main(): Promise<void> {
  const store = await Store.connect(CONFIG.connectionString);

  // build the trie from the durable table
  const trie = new Trie(CONFIG.topK);
  const start = Date.now();
  const loaded = await store.loadAll((qc) => trie.insert(qc.query, qc.count));
  trie.build();
  console.log(`loaded ${loaded} queries, built trie in ${Date.now() - start}ms`);

  const buffer = new WriteBuffer(store, CONFIG.bufferMaxDistinct, CONFIG.bufferFlushMs);
  const cache = new DistributedCache(
    CONFIG.cacheNodes,
    CONFIG.cacheVirtualNodes,
    CONFIG.cacheTtlMs,
    CONFIG.cacheCapacity,
  );
  const trending = new TrendingScorer(CONFIG.trendingHalfLifeMs);

  const app = express();
  app.use(express.json());
  app.use(buildRouter({ trie, cache, buffer, trending, weight: CONFIG.trendingWeight }));
  // the single-page frontend, served by the same process
  app.use(express.static(path.join(__dirname, "..", "web")));

  const server = app.listen(CONFIG.port, () => {
    console.log(`listening on :${CONFIG.port}`);
  });

  // graceful shutdown: stop accepting connections, flush the buffer, close PG
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down...`);
    server.close();
    await buffer.close();
    await store.close();
    console.log("bye");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
