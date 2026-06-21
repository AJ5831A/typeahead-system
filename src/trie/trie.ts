/**
 * trie.ts — in-memory prefix index.
 *
 * This is the structure that actually answers "give me everything that starts
 * with `ip`, ranked by popularity". It is built once from Postgres at startup
 * and lives entirely in memory; if the process restarts we just rebuild it.
 *
 * The trick that keeps reads cheap is the per-node top-K list: each node
 * remembers its own most-popular descendants, so a lookup is "walk to the node,
 * hand back the precomputed list" with no scanning or sorting at read time.
 *
 * Memory note: a full dataset is ~1.24M queries, which means several million
 * character nodes. JS objects are far heavier than Go structs, so the build is
 * written to keep allocations down without changing the design:
 *   - exactly one Suggestion object exists per query; every top-K list that
 *     includes it stores a reference, not a copy;
 *   - a non-word node with a single child reuses that child's top-K array by
 *     reference (long non-branching tails cost one array, not one per node).
 */

export interface Suggestion {
  query: string;
  count: number;
}

/** A single character node in the tree. */
class TrieNode {
  readonly children = new Map<string, TrieNode>();
  /** the query that ends exactly here, or undefined if this isn't a word */
  self?: Suggestion;
  /** the topK most popular completions under this node (shared references) */
  top: Suggestion[] = [];
}

export class Trie {
  private readonly root = new TrieNode();

  constructor(private readonly topK: number) {}

  /**
   * Add a query with its popularity count. Walks/creates the character path and
   * attaches a single Suggestion to the terminal node.
   */
  insert(query: string, count: number): void {
    let node = this.root;
    for (const ch of query) {
      let next = node.children.get(ch);
      if (!next) {
        next = new TrieNode();
        node.children.set(ch, next);
      }
      node = next;
    }
    node.self = { query, count };
  }

  /**
   * Compute the top-K list for every node in a single post-order pass. Run once,
   * after all inserts.
   */
  build(): void {
    this.computeTop(this.root);
  }

  private computeTop(node: TrieNode): Suggestion[] {
    // Fast path: a non-word node with one child has exactly its child's top-K.
    // Reuse the array reference instead of allocating a fresh one.
    if (!node.self && node.children.size === 1) {
      const only = node.children.values().next().value!;
      node.top = this.computeTop(only);
      return node.top;
    }

    const candidates: Suggestion[] = [];
    for (const child of node.children.values()) {
      // child lists are already trimmed to K, so this stays bounded
      candidates.push(...this.computeTop(child));
    }
    if (node.self) candidates.push(node.self);

    candidates.sort(compareSuggestions);
    node.top = candidates.length > this.topK ? candidates.slice(0, this.topK) : candidates;
    return node.top;
  }

  /**
   * Return the precomputed top-K for a prefix. Walks the prefix path; a missing
   * path means the prefix matches nothing, so we return []. A defensive copy is
   * returned so callers (e.g. the trending reranker) can mutate freely without
   * corrupting the shared index.
   */
  search(prefix: string): Suggestion[] {
    let node = this.root;
    for (const ch of prefix) {
      const next = node.children.get(ch);
      if (!next) return [];
      node = next;
    }
    return node.top.map((s) => ({ ...s }));
  }
}

/** Higher count first; ties broken alphabetically so order is deterministic. */
export function compareSuggestions(a: Suggestion, b: Suggestion): number {
  if (a.count !== b.count) return b.count - a.count;
  return a.query < b.query ? -1 : a.query > b.query ? 1 : 0;
}
