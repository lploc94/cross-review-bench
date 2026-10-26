/** A tenant and its storage usage. Byte counts are safe integers (see repositories/mapping.ts). */
export interface Tenant {
  readonly id: string;
  readonly name: string;
  readonly quotaBytes: number;
  readonly usedBytes: number;
  readonly createdAt: Date;
}

/** The largest quota the API accepts: byte counts must stay exact as JavaScript numbers. */
export const MAX_QUOTA_BYTES = Number.MAX_SAFE_INTEGER;

export function availableBytes(tenant: Tenant): number {
  return Math.max(tenant.quotaBytes - tenant.usedBytes, 0);
}
