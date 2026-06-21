/**
 * buffer.ts — the write buffer that keeps search submissions off the hot path.
 *
 * Writing to Postgres on every single search would flood it with tiny writes.
 * Instead submissions are tallied in memory and flushed in bulk. The real win
 * is aggregation, not just batching: a thousand searches for "iphone" inside one
 * window collapse to a single `+1000`, so the database sees one write per
 * distinct query per flush rather than one per search.
 *
 * Flush triggers, whichever comes first:
 *   - a timer, so data never sits buffered indefinitely;
 *   - a size cap on the number of distinct queries, so a spike can't grow the
 *     buffer without bound.
 *
 * The cost is durability: a hard crash loses whatever is buffered, because it
 * only ever lived in memory. That's an acceptable trade for ranking counts —
 * losing a handful of increments out of hundreds of thousands changes nothing
 * about which suggestions appear. For money or orders you'd choose the opposite
 * (a write-ahead log, or synchronous writes). A clean shutdown flushes first to
 * shrink the loss window.
 */

/** Anything that can persist an aggregated batch (the Store satisfies this). */
export interface Flusher {
  upsertCounts(increments: Map<string, number>): Promise<void>;
}

export interface BufferStats {
  searchesReceived: number;
  dbFlushes: number;
  rowsWritten: number;
}

export class WriteBuffer {
  private counts = new Map<string, number>();
  private timer: NodeJS.Timeout;

  private searchesReceived = 0;
  private dbFlushes = 0;
  private rowsWritten = 0;

  /** guards against a timer flush overlapping a size-triggered flush */
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    private readonly flusher: Flusher,
    private readonly maxDistinct: number,
    flushIntervalMs: number,
  ) {
    this.timer = setInterval(() => void this.flush(), flushIntervalMs);
    // don't let the flush timer keep the process alive on its own
    this.timer.unref?.();
  }

  /** Record one search. Bumps the in-memory tally and may trigger a flush. */
  add(query: string): void {
    this.counts.set(query, (this.counts.get(query) ?? 0) + 1);
    this.searchesReceived++;

    if (this.counts.size >= this.maxDistinct) {
      void this.flush();
    }
  }

  /**
   * Swap out the current tally and persist it. Swapping first means new
   * searches arriving mid-flush land in a fresh map and aren't lost. Flushes
   * are chained so two can't run concurrently against the store.
   */
  async flush(): Promise<void> {
    if (this.counts.size === 0) return;

    const batch = this.counts;
    this.counts = new Map();

    this.dbFlushes++;
    this.rowsWritten += batch.size;

    this.flushing = this.flushing
      .then(() => this.flusher.upsertCounts(batch))
      .catch((err) => {
        // a failed flush loses this batch; log loudly, keep the server up
        console.error(`buffer flush failed (${batch.size} queries lost):`, err);
      });
    return this.flushing;
  }

  stats(): BufferStats {
    return {
      searchesReceived: this.searchesReceived,
      dbFlushes: this.dbFlushes,
      rowsWritten: this.rowsWritten,
    };
  }

  /** Stop the timer and flush anything still buffered. Call on shutdown. */
  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
    await this.flushing;
  }
}
