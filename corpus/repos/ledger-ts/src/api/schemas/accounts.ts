import { z } from "zod";
import { ACCOUNT_KINDS } from "../../domain/account.js";
import { currencySchema, STORABLE_TEXT_MESSAGE, storableText } from "./common.js";

/** Account names: 1 to 200 characters after trimming, storable in Postgres. */
const accountNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(storableText, { error: STORABLE_TEXT_MESSAGE });

export const createAccountBodySchema = z.strictObject({
  name: accountNameSchema,
  currency: currencySchema,
  kind: z.enum(ACCOUNT_KINDS).default("wallet"),
});

export type CreateAccountBody = z.infer<typeof createAccountBodySchema>;
