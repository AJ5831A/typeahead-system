/**
 * trending.ts — recency-aware ranking via exponential time decay.
 *
 * Basic ranking is by all-time count. The upgrade is recency: something
 * searched a lot in the last few minutes should be allowed to climb over an
 * all-time giant. The catch the assignment calls out is that a brief spike must
 * not rank highly *forever* — so a flat `count + recentCount` won't do, because
 * that bonus would be permanent. The recency signal has to fade.
 *
 * So each query keeps a single decaying score and the time it was last touched.
 * On a new search the stored score is first decayed forward to "now", then the
 * new boost is added:
 *
 *     dt    = now - lastSeen
 *     score = score * exp(-lambda * dt) + boost
 *
 * Why exponential decay specifically? Because it's composable: decaying once
 * across a two-minute gap gives exactly the same result as decaying minute by
 * minute. That's the whole reason we can store one number per query instead of
 * a list of every search event. A different fade curve would break that and
 * force us to keep history.
 *
 * Final ranking blends the two signals:
 *
 *     finalScore = allTimeCount + weight * recencyScore
 *
 * The per-search boost is fixed at 1; its absolute size doesn't matter because
 * `weight` rescales the whole recency term. Real tuning lives in `weight` (how
 * far a hot trend can climb) and the half-life (how fast trends fade).
 */

interface RecencyScore {
  score: number;
  lastSeen: number; // epoch ms
}

export interface Scored {
  query: string;
  count: number;
}

export class TrendingScorer {
  private readonly scores = new Map<string, RecencyScore>();
  private readonly lambda: number; // decay rate, derived from the half-life
  private readonly boost = 1;

  constructor(halfLifeMs: number) {
    // half-life H means decayFactor(H) === 0.5, i.e. lambda = ln2 / H
    this.lambda = Math.LN2 / (halfLifeMs / 1000);
  }

  /** Register a search: decay the existing score to now, then add the boost. */
  record(query: string): void {
    const now = Date.now();
    const existing = this.scores.get(query);

    if (!existing) {
      this.scores.set(query, { score: this.boost, lastSeen: now });
      return;
    }
    existing.score = existing.score * this.decayFactor(now - existing.lastSeen) + this.boost;
    existing.lastSeen = now;
  }

  /** Current recency score, decayed forward to now (no boost added). */
  scoreOf(query: string): number {
    const rs = this.scores.get(query);
    if (!rs) return 0;
    return rs.score * this.decayFactor(Date.now() - rs.lastSeen);
  }

  /**
   * Re-rank suggestions by the blended score. Pure with respect to the input
   * list (it sorts a copy); ties fall back to alphabetical for determinism.
   */
  rerank(items: Scored[], weight: number): Scored[] {
    const withScore = items.map((item) => ({
      item,
      final: item.count + weight * this.scoreOf(item.query),
    }));

    withScore.sort((a, b) => {
      if (a.final !== b.final) return b.final - a.final;
      return a.item.query < b.item.query ? -1 : a.item.query > b.item.query ? 1 : 0;
    });

    return withScore.map((w) => w.item);
  }

  private decayFactor(dtMs: number): number {
    return Math.exp(-this.lambda * (dtMs / 1000));
  }
}
