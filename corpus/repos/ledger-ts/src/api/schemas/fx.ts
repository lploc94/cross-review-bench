import { z } from "zod";
import { amountSchema, currencySchema } from "./common.js";

export const rateParamsSchema = z.object({
  base: currencySchema,
  quote: currencySchema,
});

export const quoteQuerySchema = z.object({
  from: currencySchema,
  to: currencySchema,
  amount: amountSchema,
});
