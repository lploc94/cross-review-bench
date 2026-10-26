import { z } from "zod";

export const createWebhookBodySchema = z.strictObject({
  url: z
    .url({ protocol: /^https?$/, error: "must be an http(s) URL" })
    .max(2_000),
});
