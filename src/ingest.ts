/**
 * ingest.ts — one-time loader for the AOL query log into Postgres.
 *
 * The raw log is one row per search event (user id, query, timestamp, clicked
 * url). We only keep the query text. Counts are derived by aggregation: group
 * by the normalized query and count occurrences, which turns ~3.6M raw events
 * in one file into ~1.24M unique (query, count) rows.
 *
 * Normalization (lowercase + trim, drop empty and the "-" placeholder the log
 * uses for blank queries) matches what the /search endpoint does, so submitted
 * queries line up with ingested ones. Every user-identifying column is
 * discarded here and never touches the database.
 *
 *   npm run ingest -- --file=user-ct-test-collection-02.txt
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

import { Store } from "./store/store.js";

const CHUNK_SIZE = 5_000;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: "string" },
      db: {
        type: "string",
        // env override lets the same command run on the host or inside a container
        default:
          process.env.DATABASE_URL ??
          "postgres://typeahead:typeahead@localhost:5433/typeahead",
      },
    },
  });

  if (!values.file) {
    console.error("need --file=path/to/aol.txt");
    process.exit(1);
  }

  const store = await Store.connect(values.db!);
  await store.initSchema();

  // ---- pass 1: read the file, aggregate counts in memory ----
  const counts = new Map<string, number>();
  const rl = createInterface({
    input: createReadStream(values.file),
    crlfDelay: Infinity,
  });

  const start = Date.now();
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (lineNo === 1) continue; // header row

    const fields = line.split("\t");
    if (fields.length < 2) continue;

    const query = fields[1].trim().toLowerCase();
    if (query === "" || query === "-") continue;

    counts.set(query, (counts.get(query) ?? 0) + 1);
  }
  console.log(
    `read ${lineNo - 1} lines, ${counts.size} unique queries in ${Date.now() - start}ms`,
  );

  // ---- pass 2: upsert into Postgres in chunks ----
  let chunk = new Map<string, number>();
  let written = 0;
  const flush = async () => {
    if (chunk.size === 0) return;
    await store.upsertCounts(chunk);
    written += chunk.size;
    chunk = new Map();
  };

  for (const [query, count] of counts) {
    chunk.set(query, count);
    if (chunk.size >= CHUNK_SIZE) await flush();
  }
  await flush();

  console.log(`wrote ${written} unique queries to postgres in ${Date.now() - start}ms`);
  await store.close();
}

main().catch((err) => {
  console.error("ingest failed:", err);
  process.exit(1);
});
