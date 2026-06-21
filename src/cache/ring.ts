/**
 * ring.ts — the consistent-hash ring that decides which cache node owns a key.
 *
 * Why not just `hash(key) % N`? Because the moment N changes (a node is added
 * or removed) the divisor changes and almost every key remaps at once — the
 * whole cache goes cold and every request stampedes the trie. Consistent
 * hashing fixes that: nodes and keys both land on a ring of hash values, and a
 * key is owned by the first node clockwise from it. Add or drop a node and only
 * the keys in that node's arc move; the rest keep their owner.
 *
 * Virtual nodes: each physical node is placed at many ring positions, not one.
 * With a single position per node the arcs come out wildly uneven; spreading
 * each node across many positions evens out the load and, when a node leaves,
 * scatters its keys across the survivors instead of dumping them on one
 * neighbour.
 */

/** CRC32 (IEEE) — small, fast, well-distributed; built once as a lookup table. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(input: string): number {
  let crc = 0xffffffff;
  for (let i = 0; i < input.length; i++) {
    crc = CRC_TABLE[(crc ^ input.charCodeAt(i)) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export class Ring {
  /** sorted ring positions */
  private positions: number[] = [];
  /** ring position -> physical node name */
  private owners = new Map<number, string>();

  constructor(private readonly virtualNodes: number) {}

  /** Place a node at `virtualNodes` positions around the ring. */
  addNode(name: string): void {
    for (let i = 0; i < this.virtualNodes; i++) {
      const pos = crc32(`${name}#${i}`);
      this.positions.push(pos);
      this.owners.set(pos, name);
    }
    this.positions.sort((a, b) => a - b);
  }

  /** Remove every virtual position belonging to a node. */
  removeNode(name: string): void {
    this.positions = this.positions.filter((pos) => {
      if (this.owners.get(pos) === name) {
        this.owners.delete(pos);
        return false;
      }
      return true;
    });
  }

  /**
   * Return the node that owns `key`: the first ring position at or clockwise
   * from hash(key), wrapping back to the start past the end. Binary search
   * keeps this O(log V) in the number of virtual positions.
   */
  getNode(key: string): string {
    if (this.positions.length === 0) return "";
    const h = crc32(key);

    let lo = 0;
    let hi = this.positions.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.positions[mid] < h) lo = mid + 1;
      else hi = mid;
    }
    // past the last position -> wrap around to the first
    const idx = lo === this.positions.length ? 0 : lo;
    return this.owners.get(this.positions[idx])!;
  }
}
