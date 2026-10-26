import { randomUUID } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { expect } from "vitest";
import type { CurrencyCode } from "../../src/domain/currency.js";
import { SCOPES, type Scope } from "../../src/domain/scopes.js";
import type { Pool } from "../../src/db/pool.js";
import type { Clock } from "../../src/infra/clock.js";
import { ApiKeyService } from "../../src/services/apiKeyService.js";
import { TenantService } from "../../src/services/tenantService.js";

export interface TestTenant {
  readonly tenantId: string;
  readonly apiKeyId: string;
  readonly token: string;
  readonly headers: { authorization: string };
}

export interface AccountBody {
  id: string;
  name: string;
  currency: string;
  kind: string;
  status: string;
  balance: string;
  held: string;
  available: string;
  created_at: string;
  updated_at: string;
}

export interface TransferBody {
  id: string;
  from_account_id: string;
  to_account_id: string;
  amount: string;
  currency: string;
  description: string | null;
  metadata: Record<string, string>;
  status: string;
  created_at: string;
  entries?: EntryBody[];
}

export interface EntryBody {
  id: string;
  transfer_id: string;
  account_id: string;
  amount: string;
  currency: string;
  balance_after: string;
  created_at: string;
}

export interface HoldBody {
  id: string;
  account_id: string;
  amount: string;
  currency: string;
  status: string;
  expires_at: string;
  captured_transfer_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ErrorResponse {
  error: { code: string; message: string; details?: unknown };
}

/** A tenant with one API key holding `scopes` (every scope by default). */
export async function createTenant(
  pool: Pool,
  clock: Clock,
  options: { name?: string; scopes?: readonly Scope[] } = {},
): Promise<TestTenant> {
  const tenant = await new TenantService({ pool, clock }).createTenant(options.name ?? "Test tenant");
  const issued = await new ApiKeyService({ pool, clock }).issueKey(
    tenant.id,
    "test key",
    options.scopes ?? SCOPES,
  );
  return {
    tenantId: tenant.id,
    apiKeyId: issued.key.id,
    token: issued.token,
    headers: { authorization: `Bearer ${issued.token}` },
  };
}

/** Another API key for an existing tenant. */
export async function issueKey(
  pool: Pool,
  clock: Clock,
  tenantId: string,
  scopes: readonly Scope[],
): Promise<TestTenant> {
  const issued = await new ApiKeyService({ pool, clock }).issueKey(tenantId, "extra key", scopes);
  return {
    tenantId,
    apiKeyId: issued.key.id,
    token: issued.token,
    headers: { authorization: `Bearer ${issued.token}` },
  };
}

function expectStatus(response: LightMyRequestResponse, status: number): void {
  if (response.statusCode !== status) {
    throw new Error(`expected HTTP ${status}, got ${response.statusCode}: ${response.body}`);
  }
}

export async function openAccount(
  app: FastifyInstance,
  tenant: TestTenant,
  options: { currency?: CurrencyCode; kind?: "wallet" | "system"; name?: string } = {},
): Promise<AccountBody> {
  const response = await app.inject({
    method: "POST",
    url: "/accounts",
    headers: tenant.headers,
    payload: {
      name: options.name ?? `${options.kind ?? "wallet"} account`,
      currency: options.currency ?? "USD",
      kind: options.kind ?? "wallet",
    },
  });
  expectStatus(response, 201);
  return response.json<AccountBody>();
}

export async function getAccount(
  app: FastifyInstance,
  tenant: TestTenant,
  id: string,
): Promise<AccountBody> {
  const response = await app.inject({ method: "GET", url: `/accounts/${id}`, headers: tenant.headers });
  expectStatus(response, 200);
  return response.json<AccountBody>();
}

export function transferRequest(
  app: FastifyInstance,
  tenant: TestTenant,
  body: Record<string, unknown>,
  idempotencyKey: string = randomUUID(),
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: "/transfers",
    headers: { ...tenant.headers, "idempotency-key": idempotencyKey },
    payload: body,
  });
}

export async function transfer(
  app: FastifyInstance,
  tenant: TestTenant,
  from: string,
  to: string,
  amount: string,
  currency: CurrencyCode = "USD",
): Promise<TransferBody> {
  const response = await transferRequest(app, tenant, {
    from_account_id: from,
    to_account_id: to,
    amount,
    currency,
  });
  expectStatus(response, 201);
  return response.json<TransferBody>();
}

/** A wallet holding `amount`, funded from a fresh system account of the same currency. */
export async function fundedWallet(
  app: FastifyInstance,
  tenant: TestTenant,
  amount: string,
  currency: CurrencyCode = "USD",
): Promise<AccountBody> {
  const funding = await openAccount(app, tenant, { currency, kind: "system", name: "funding" });
  const wallet = await openAccount(app, tenant, { currency });
  await transfer(app, tenant, funding.id, wallet.id, amount, currency);
  const funded = await getAccount(app, tenant, wallet.id);
  expect(funded.balance).toBe(amount);
  return funded;
}

export async function createHold(
  app: FastifyInstance,
  tenant: TestTenant,
  body: { account_id: string; amount: string; currency?: CurrencyCode; expires_in_seconds?: number },
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: "/holds",
    headers: tenant.headers,
    payload: { currency: "USD", expires_in_seconds: 3600, ...body },
  });
}
