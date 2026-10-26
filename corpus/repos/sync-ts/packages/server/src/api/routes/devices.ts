import type { FastifyInstance } from "fastify";
import { authOf } from "../plugins/auth.js";
import { registerDeviceBodySchema } from "../schemas/devices.js";
import { serializeDevice, serializeDeviceWithCursor } from "../serializers.js";
import { parse } from "../validation.js";
import type { RouteOptions } from "./types.js";

/** `/v1/me` and `/v1/devices`: the caller, its user's devices; any device may register another one. */
export async function deviceRoutes(app: FastifyInstance, options: RouteOptions): Promise<void> {
  const { accounts } = options.services;

  app.get("/me", async (request) => {
    const { user, device } = await accounts.whoAmI(authOf(request));
    return {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      device: serializeDevice(device),
    };
  });

  app.get("/devices", async (request) => {
    const auth = authOf(request);
    const devices = await accounts.listDevices(auth.userId);
    return { data: devices.map((device) => serializeDeviceWithCursor(device, auth.deviceId)) };
  });

  app.post("/devices", async (request, reply) => {
    const auth = authOf(request);
    const body = parse(registerDeviceBodySchema, request.body, "body");
    const registered = await accounts.registerDevice(auth.userId, body.name);
    reply.header("cache-control", "no-store");
    return reply.code(201).send({ device: serializeDevice(registered.device), token: registered.token });
  });
}
