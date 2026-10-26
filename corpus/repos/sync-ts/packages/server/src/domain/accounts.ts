import { z } from "zod";

/** A person with documents; every query is scoped by the user of the calling device. */
export interface User {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly createdAt: Date;
}

/** One installation of a client, authenticated by its own token. */
export interface Device {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date | null;
}

/** A device with the sync position it last confirmed (null before its first pull). */
export interface DeviceWithCursor extends Device {
  readonly lastPulledSeq: number | null;
}

/** The caller of an authenticated request. */
export interface AuthContext {
  readonly userId: string;
  readonly deviceId: string;
}

const printable = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/\p{Cc}/u.test(value), "must not contain control characters")
    .refine((value) => value.isWellFormed(), "must be well-formed Unicode");

export const deviceNameSchema = printable(100);
export const displayNameSchema = printable(100);

/** Emails are compared and stored lowercased. */
export const emailSchema = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email())
  .transform((email) => email.toLowerCase());

/** Devices whose last request is older than this are touched again on their next request. */
export const LAST_SEEN_RESOLUTION_MS = 60_000;

/** Devices a user may register; also bounds the device list. */
export const MAX_DEVICES_PER_USER = 50;
