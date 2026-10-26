import { z } from "zod";
import { HOLD_STATUSES, MAX_HOLD_SECONDS, MIN_HOLD_SECONDS } from "../../domain/hold.js";
import {
  amountSchema,
  createdRangeSchema,
  currencySchema,
  idSchema,
  paginationQuerySchema,
} from "./common.js";

export const createHoldBodySchema = z.strictObject({
  account_id: idSchema,
  amount: amountSchema,
  currency: currencySchema,
  expires_in_seconds: z.number().int().min(MIN_HOLD_SECONDS).max(MAX_HOLD_SECONDS),
});

export const captureHoldBodySchema = z.strictObject({
  to_account_id: idSchema,
});

export const listHoldsQuerySchema = z.intersection(
  paginationQuerySchema.extend({
    account_id: idSchema.optional(),
    status: z.enum(HOLD_STATUSES).optional(),
  }),
  createdRangeSchema,
);
