import { z } from "zod";
import { MAX_QUOTA_BYTES } from "../../domain/tenant.js";

export const patchTenantBodySchema = z.object({
  quotaBytes: z.number().int().min(0).max(MAX_QUOTA_BYTES),
});
