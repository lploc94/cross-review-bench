import type { Pool } from "../db/pool.js";
import type { CurrencyCode } from "../domain/currency.js";
import { NotFoundError } from "../domain/errors.js";
import { IDENTITY_RATE_SCALED, convert, type FxRate } from "../domain/fx.js";
import type { Clock } from "../infra/clock.js";
import * as fxRates from "../repositories/fxRates.js";

export interface FxQuote {
  readonly from: CurrencyCode;
  readonly to: CurrencyCode;
  readonly amountMinor: bigint;
  readonly convertedMinor: bigint;
  readonly rate: FxRate;
}

export class FxService {
  private readonly pool: Pool;
  private readonly clock: Clock;

  constructor(deps: { pool: Pool; clock: Clock }) {
    this.pool = deps.pool;
    this.clock = deps.clock;
  }

  /**
   * The rate in effect now for base → quote. Only the direct pair is used: a rate for
   * quote → base is a different market price, not something to invert here.
   */
  async getRate(tenantId: string, base: CurrencyCode, quote: CurrencyCode): Promise<FxRate> {
    const now = this.clock.now();
    if (base === quote) {
      return { base, quote, rateScaled: IDENTITY_RATE_SCALED, effectiveAt: now };
    }
    const rate = await fxRates.findEffectiveRate(this.pool, tenantId, base, quote, now);
    if (!rate) {
      throw new NotFoundError(`no ${base}/${quote} rate is in effect`, { base, quote });
    }
    return rate;
  }

  /** What `amountMinor` of `from` is worth in `to` at the current rate, rounded half to even. */
  async quote(
    tenantId: string,
    from: CurrencyCode,
    to: CurrencyCode,
    amountMinor: bigint,
  ): Promise<FxQuote> {
    const rate = await this.getRate(tenantId, from, to);
    return {
      from,
      to,
      amountMinor,
      convertedMinor: convert(amountMinor, from, to, rate.rateScaled),
      rate,
    };
  }
}
