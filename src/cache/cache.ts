/**
 * cache.ts — the distributed cache, presented as one object.
 *
 * Internally it's a set of logical nodes plus a consistent-hash ring. Callers
 * never pick a node themselves: they ask the cache for a prefix and the ring
 * routes it to the owning node. Swapping the in-process nodes for remote ones
 * later would not change this surface.
 */

import type { Suggestion } from "../trie/trie.js";
import { Ring } from "./ring.js";
import { CacheNode, type NodeStats } from "./node.js";

export class DistributedCache {
  private readonly ring: Ring;
  private readonly nodes = new Map<string, CacheNode>();

  /**
   * @param nodeCount     number of logical cache nodes
   * @param virtualNodes  ring positions per node (smooths load distribution)
   * @param ttlMs         entry lifetime before it's treated as stale
   * @param capacity      max entries per node before LRU eviction kicks in
   */
  constructor(nodeCount: number, virtualNodes: number, ttlMs: number, capacity: number) {
    this.ring = new Ring(virtualNodes);
    for (let i = 0; i < nodeCount; i++) {
      const name = `node${i}`;
      this.ring.addNode(name);
      this.nodes.set(name, new CacheNode(name, ttlMs, capacity));
    }
  }

  get(prefix: string): Suggestion[] | null {
    return this.nodeFor(prefix).get(prefix);
  }

  set(prefix: string, suggestions: Suggestion[]): void {
    this.nodeFor(prefix).set(prefix, suggestions);
  }

  /** Which node owns the prefix, and is it currently cached there? (no stat side effects) */
  debug(prefix: string): { node: string; hit: boolean } {
    const node = this.nodeFor(prefix);
    return { node: node.name, hit: node.peek(prefix) };
  }

  allStats(): NodeStats[] {
    return [...this.nodes.values()].map((n) => n.stats());
  }

  private nodeFor(prefix: string): CacheNode {
    return this.nodes.get(this.ring.getNode(prefix))!;
  }
}
