/**
 * store.ts — Postgres, the durable source of truth.
 *
 * Holds the canonical `(query, count)` table. Everything else (the trie, the
 * cache) is a volatile, rebuildable derivative of what lives here. Batched
 * search increments land here; on startup the whole table is streamed back out
 * to rebuild the trie.
 */

import pg from "pg";

const { Pool } = pg;

export interface QueryCount {
  query: string;
  count: number;
}

export class Store {
  private constructor(private readonly pool: pg.Pool) {}

  /** Open a pool and verify the connection before handing the store back. */
  static async connect(connectionString: string): Promise<Store> {
    const pool = new Pool({ connectionString });
    // fail fast if Postgres isn't reachable, instead of on first query
    const client = await pool.connect();
    client.release();
    return new Store(pool);
  }

  /** Create the table if it isn't there yet. Run by the ingest tool. */
  async initSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS queries (
        query TEXT PRIMARY KEY,
        count BIGINT NOT NULL
      )
    `);
  }

  /**
   * Apply a map of {query -> increment} in one round trip. Existing queries get
   * their count bumped; new ones are inserted. This is the only write path to
   * Postgres, and it is always called with an already-aggregated batch, never
   * per individual search.
   *
   * A single multi-row INSERT ... ON CONFLICT is used rather than one statement
   * per row: fewer round trips, and the upsert handles the "exists vs new"
   * branch in the database.
   */
  async upsertCounts(increments: Map<string, number>): Promise<void> {
    if (increments.size === 0) return;

    const values: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    for (const [query, inc] of increments) {
      values.push(`($${i++}, $${i++})`);
      params.push(query, inc);
    }

    await this.pool.query(
      `INSERT INTO queries (query, count)
       VALUES ${values.join(", ")}
       ON CONFLICT (query) DO UPDATE
         SET count = queries.count + EXCLUDED.count`,
      params,
    );
  }

  /**
   * Stream every row to the callback. Used at startup to populate the trie.
   * A cursor-style stream would scale further, but the whole table fits in
   * memory comfortably at this size, so a single query is simpler and fine.
   */
  async loadAll(onRow: (qc: QueryCount) => void): Promise<number> {
    const res = await this.pool.query<{ query: string; count: string }>(
      "SELECT query, count FROM queries",
    );
    for (const row of res.rows) {
      // BIGINT comes back as a string in node-postgres; parse to number
      onRow({ query: row.query, count: Number(row.count) });
    }
    return res.rowCount ?? 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
