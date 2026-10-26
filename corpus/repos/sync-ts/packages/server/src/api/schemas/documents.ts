import { docIdSchema } from "@sync/shared";
import { z } from "zod";

export const documentParamsSchema = z.object({
  collection: z.string().min(1).max(64),
  id: docIdSchema,
});
