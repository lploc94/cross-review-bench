import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { isCurrencyCode } from "../domain/currency.js";
import { parseRate } from "../domain/fx.js";
import * as fxRates from "../repositories/fxRates.js";
import * as tenants from "../repositories/tenants.js";
import { UsageError, runScript } from "./cli.js";

const USAGE = `usage: npm run seed-fx-rates -- --tenant <tenant id> --file <rates.json>

rates.json holds an array of rates, each effective from its effective_at on:
  [{ "base": "EUR", "quote": "USD", "rate": "1.0850", "effective_at": "2026-01-01T00:00:00Z" }]
Loading a file again replaces the rates it already loaded.`;

const currency = z.string().refine(isCurrencyCode, { error: "unsupported currency" });

const rateFileSchema = z.array(
  z
    .strictObject({
      base: currency,
      quote: currency,
      rate: z.string(),
      effective_at: z.iso.datetime({ offset: true }),
    })
    .refine((entry) => entry.base !== entry.quote, { error: "base and quote must differ" }),
);

await runScript(USAGE, async ({ pool, logger }) => {
  let values;
  try {
    ({ values } = parseArgs({
      options: { tenant: { type: "string" }, file: { type: "string" } },
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  if (!values.tenant || !values.file) throw new UsageError("--tenant and --file are required");

  const tenant = await tenants.findTenant(pool, values.tenant);
  if (!tenant) throw new UsageError(`tenant ${values.tenant} does not exist`);

  const parsed = rateFileSchema.safeParse(JSON.parse(await readFile(values.file, "utf8")));
  if (!parsed.success) {
    throw new UsageError(`${values.file}: ${z.prettifyError(parsed.error)}`);
  }
  for (const entry of parsed.data) {
    await fxRates.upsertRate(pool, {
      tenantId: tenant.id,
      base: entry.base,
      quote: entry.quote,
      rateScaled: parseRate(entry.rate),
      effectiveAt: new Date(entry.effective_at),
    });
  }
  logger.info({ tenant: tenant.id, rates: parsed.data.length }, "fx rates loaded");
});
