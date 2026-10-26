import type { PhysicalClock } from "@sync/shared";
import type { Pool } from "../db/pool.js";
import { LAST_SEEN_RESOLUTION_MS, type AuthContext } from "../domain/accounts.js";
import { parseToken, secretMatches } from "../domain/tokens.js";
import { findDeviceCredentials, touchDevice } from "../repositories/devices.js";

/** Device token authentication. */
export class AuthService {
  private readonly pool: Pool;
  private readonly clock: PhysicalClock;

  constructor(deps: { pool: Pool; clock: PhysicalClock }) {
    this.pool = deps.pool;
    this.clock = deps.clock;
  }

  /**
   * The device and user a token belongs to, or null for a malformed token, an unknown device or
   * a wrong secret (callers answer all three alike). Records the device as seen.
   */
  async authenticate(token: string): Promise<AuthContext | null> {
    const parsed = parseToken(token);
    if (!parsed) return null;
    const credentials = await findDeviceCredentials(this.pool, parsed.deviceId);
    if (!credentials || !secretMatches(parsed.secret, credentials.tokenHash)) return null;
    await touchDevice(this.pool, credentials.id, new Date(this.clock.now()), LAST_SEEN_RESOLUTION_MS);
    return { userId: credentials.userId, deviceId: credentials.id };
  }
}
