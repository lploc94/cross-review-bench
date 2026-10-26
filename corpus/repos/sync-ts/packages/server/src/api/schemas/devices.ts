import { z } from "zod";
import { deviceNameSchema } from "../../domain/accounts.js";

export const registerDeviceBodySchema = z.strictObject({
  name: deviceNameSchema,
});
