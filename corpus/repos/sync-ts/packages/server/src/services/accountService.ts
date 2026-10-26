import { randomUUID } from "node:crypto";
import type { PhysicalClock } from "@sync/shared";
import type { z } from "zod";
import type { Pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import {
  MAX_DEVICES_PER_USER,
  deviceNameSchema,
  displayNameSchema,
  emailSchema,
  type AuthContext,
  type Device,
  type DeviceWithCursor,
  type User,
} from "../domain/accounts.js";
import { DeviceLimitError, EmailTakenError, NotFoundError, ValidationError } from "../domain/errors.js";
import { issueToken } from "../domain/tokens.js";
import { countDevices, findDevice, insertDevice, listDevicesWithCursors } from "../repositories/devices.js";
import { pgErrorCode, UNIQUE_VIOLATION } from "../repositories/mapping.js";
import { findUserByEmail, findUserById, insertUser, lockUser } from "../repositories/users.js";

export interface RegisteredDevice {
  readonly device: Device;
  /** The device's bearer token; it is not stored and cannot be shown again. */
  readonly token: string;
}

export interface CreatedUser extends RegisteredDevice {
  readonly user: User;
}

function parseInput<S extends z.ZodType>(schema: S, value: unknown, name: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(`invalid ${name}`, result.error.issues.map((issue) => ({
      path: [name, ...issue.path.map(String)].join("."),
      message: issue.message,
    })));
  }
  return result.data;
}

/** Users and their devices: created by operators, extended by the users' own devices. */
export class AccountService {
  private readonly pool: Pool;
  private readonly clock: PhysicalClock;
  private readonly maxDevicesPerUser: number;

  constructor(deps: { pool: Pool; clock: PhysicalClock; maxDevicesPerUser?: number }) {
    this.pool = deps.pool;
    this.clock = deps.clock;
    this.maxDevicesPerUser = deps.maxDevicesPerUser ?? MAX_DEVICES_PER_USER;
  }

  /** Create a user with a first device and return that device's token. */
  async createUser(input: { email: string; displayName: string; deviceName: string }): Promise<CreatedUser> {
    const email = parseInput(emailSchema, input.email, "email");
    const displayName = parseInput(displayNameSchema, input.displayName, "displayName");
    const deviceName = parseInput(deviceNameSchema, input.deviceName, "deviceName");
    const now = new Date(this.clock.now());
    const user: User = { id: randomUUID(), email, displayName, createdAt: now };
    const device: Device = { id: randomUUID(), userId: user.id, name: deviceName, createdAt: now, lastSeenAt: null };
    const issued = issueToken(device.id);
    try {
      await withTransaction(this.pool, async (client) => {
        await insertUser(client, user);
        await insertDevice(client, { ...device, tokenHash: issued.tokenHash });
      });
    } catch (err) {
      if (pgErrorCode(err) === UNIQUE_VIOLATION) throw new EmailTakenError(email);
      throw err;
    }
    return { user, device, token: issued.token };
  }

  /** Register another device of an existing user. */
  async registerDevice(userId: string, name: string): Promise<RegisteredDevice> {
    const deviceName = parseInput(deviceNameSchema, name, "name");
    const now = new Date(this.clock.now());
    const device: Device = { id: randomUUID(), userId, name: deviceName, createdAt: now, lastSeenAt: null };
    const issued = issueToken(device.id);
    await withTransaction(this.pool, async (client) => {
      // Serializes registrations of one user, so two at once cannot both pass the limit.
      if (!(await lockUser(client, userId))) throw NotFoundError.resource("user", userId);
      if ((await countDevices(client, userId)) >= this.maxDevicesPerUser) {
        throw new DeviceLimitError(this.maxDevicesPerUser);
      }
      await insertDevice(client, { ...device, tokenHash: issued.tokenHash });
    });
    return { device, token: issued.token };
  }

  async listDevices(userId: string): Promise<DeviceWithCursor[]> {
    return listDevicesWithCursors(this.pool, userId, this.maxDevicesPerUser);
  }

  /** The calling device and its user. */
  async whoAmI(auth: AuthContext): Promise<{ user: User; device: Device }> {
    const [user, device] = await Promise.all([findUserById(this.pool, auth.userId), findDevice(this.pool, auth.deviceId)]);
    if (!user || !device || device.userId !== user.id) {
      throw new NotFoundError("the calling device or its user no longer exists");
    }
    return { user, device };
  }

  async findUserByEmail(email: string): Promise<User | null> {
    return findUserByEmail(this.pool, parseInput(emailSchema, email, "email"));
  }

  async findUser(userId: string): Promise<User | null> {
    return findUserById(this.pool, userId);
  }
}
