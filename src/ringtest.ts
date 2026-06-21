/**
 * ringtest.ts — a standalone demonstration of the consistent-hash ring.
 *
 * Records which node owns each of a set of prefixes, then adds a node and
 * reports how many prefixes changed owner. The point: adding a node remaps only
 * about 1/N of keys, not nearly all of them — which is exactly why we use a
 * hash ring instead of `hash(key) % N`.
 *
 *   npm run ringtest
 */

import { Ring } from "./cache/ring.js";

function main(): void {
  // 3 nodes, 100 virtual positions each
  const ring = new Ring(100);
  ring.addNode("node0");
  ring.addNode("node1");
  ring.addNode("node2");

  const prefixes = [
    "goog", "ip", "java", "map", "ebay", "yahoo",
    "amaz", "face", "twit", "red", "net", "you",
  ];

  console.log("--- with 3 nodes ---");
  const before = new Map<string, string>();
  for (const p of prefixes) {
    const owner = ring.getNode(p);
    before.set(p, owner);
    console.log(`${p.padEnd(6)} -> ${owner}`);
  }

  ring.addNode("node3");
  console.log("\n--- after adding node3 ---");
  let moved = 0;
  for (const p of prefixes) {
    const owner = ring.getNode(p);
    const previous = before.get(p)!;
    if (owner !== previous) {
      moved++;
      console.log(`${p.padEnd(6)} -> ${owner} (MOVED from ${previous})`);
    } else {
      console.log(`${p.padEnd(6)} -> ${owner} (same)`);
    }
  }

  console.log(
    `\n${moved} of ${prefixes.length} prefixes moved when adding a node (~1/N expected)`,
  );
}

main();
