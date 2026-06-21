/**
 * node.ts — one logical cache node.
 *
 * Each node owns a private map of {prefix -> finished suggestion list}. Entries
 * leave for two reasons:
 *   - they go stale: every entry carries an expiry, and a read past it is
 *     treated as a miss (lazy TTL — no background sweeper needed);
 *   - the node fills up: an LRU bound caps memory, evicting the
 *     least-recently-used prefix when capacity is exceeded.
 *
 * A note on concurrency: in the Go original each node was a goroutine reading
 * requests off a channel, so its map was touched by exactly one thread and
 * needed no lock. Node.js gives us that property for free — the event loop runs
 * our handlers one at a time — so a plain Map is already race-free here. The
 * "node" abstraction is kept because it's the unit consistent hashing routes to
 * and, in production, the unit you'd promote to a separate process or Redis.
 */

import type { Suggestion } from "../trie/trie.js";

interface Entry {
  suggestions: Suggestion[];
  expiresAt: number; // epoch ms
}

export interface NodeStats {
  name: string;
  size: number;
  hits: number;
  misses: number;
}

export class CacheNode {
  private readonly store = new Map<string, Entry>();
  private hits = 0;
  private misses = 0;

  constructor(
    readonly name: string,
    private readonly ttlMs: number,
    private readonly capacity: number,
  ) {}

  get(prefix: string): Suggestion[] | null {
    const entry = this.store.get(prefix);

    if (!entry) {
      this.misses++;
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      // lazily evict the stale entry and report a miss
      this.store.delete(prefix);
      this.misses++;
      return null;
    }

    // mark as most-recently-used: delete + re-insert moves it to the tail,
    // since Map iterates in insertion order
    this.store.delete(prefix);
    this.store.set(prefix, entry);
    this.hits++;
    return entry.suggestions;
  }

  set(prefix: string, suggestions: Suggestion[]): void {
    this.store.delete(prefix); // refresh recency if it already existed
    this.store.set(prefix, { suggestions, expiresAt: Date.now() + this.ttlMs });

    if (this.store.size > this.capacity) {
      // the first key in iteration order is the least-recently-used
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }

  /** Read membership without affecting hit/miss counters — used by /cache/debug. */
  peek(prefix: string): boolean {
    const entry = this.store.get(prefix);
    return entry !== undefined && Date.now() <= entry.expiresAt;
  }

  stats(): NodeStats {
    return {
      name: this.name,
      size: this.store.size,
      hits: this.hits,
      misses: this.misses,
    };
  }
}
