import { z } from "zod";
import {
  amountSchema,
  createdRangeSchema,
  currencySchema,
  idSchema,
  metadataSchema,
  paginationQuerySchema,
} from "./common.js";

export const createTransferBodySchema = z
  .strictObject({
    from_account_id: idSchema,
    to_account_id: idSchema,
    amount: amountSchema,
    currency: currencySchema,
    description: z.string().trim().min(1).max(500).optional(),
    metadata: metadataSchema.optional(),
  })
  .refine((body) => body.from_account_id !== body.to_account_id, {
    error: "from_account_id and to_account_id must differ",
    path: ["to_account_id"],
  });

export type CreateTransferBody = z.infer<typeof createTransferBodySchema>;

export const listTransfersQuerySchema = z.intersection(
  paginationQuerySchema.extend({ account_id: idSchema.optional() }),
  createdRangeSchema,
);
