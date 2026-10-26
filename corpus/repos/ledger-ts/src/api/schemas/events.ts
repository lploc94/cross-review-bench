import { z } from "zod";
import { EVENT_TYPES } from "../../domain/events.js";
import { createdRangeSchema, idSchema, paginationQuerySchema } from "./common.js";

/** Event ids are the outbox's bigserial ids, sent as decimal strings. */
export const eventParamsSchema = z.object({
  id: z.string().regex(/^[1-9]\d{0,18}$/, { error: "must be an event id" }),
});

export const listEventsQuerySchema = z.intersection(
  paginationQuerySchema.extend({
    type: z.enum(EVENT_TYPES).optional(),
    aggregate_id: idSchema.optional(),
  }),
  createdRangeSchema,
);
