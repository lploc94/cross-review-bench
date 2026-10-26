import { parseArgs } from "node:util";
import { isUuid } from "../domain/paths.js";
import { partitionScopes, SCOPES, type Scope } from "../domain/scopes.js";
import { systemClock } from "../infra/clock.js";
import { ApiKeyService } from "../services/apiKeyService.js";
import { TenantService } from "../services/tenantService.js";
import { runScript, UsageError } from "./cli.js";

const USAGE = `usage:
  npm run admin -- create-tenant --name <name> --quota-bytes <n> [--scopes a,b,…]
  npm run admin -- issue-key --tenant <id> [--name <name>] [--scopes a,b,…]
  npm run admin -- list-keys --tenant <id>
  npm run admin -- revoke-key --tenant <id> --key <id>

Scopes: ${SCOPES.join(", ")} (all by default).`;

function scopesOption(value: string | undefined): string[] {
  if (value === undefined) return [...SCOPES];
  return value
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");
}

function knownScopes(scopes: string[]): Scope[] {
  const { valid, unknown } = partitionScopes(scopes);
  if (unknown.length > 0) throw new UsageError(`unknown scopes: ${unknown.join(", ")}`);
  if (valid.length === 0) throw new UsageError("--scopes needs at least one scope");
  return valid;
}

function requireOption(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") throw new UsageError(`--${name} is required`);
  return value;
}

function tenantOption(value: string | undefined): string {
  const id = requireOption(value, "tenant").toLowerCase();
  if (!isUuid(id)) throw new UsageError("--tenant must be a tenant id");
  return id;
}

await runScript(USAGE, async ({ pool }) => {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        name: { type: "string" },
        "quota-bytes": { type: "string" },
        scopes: { type: "string" },
        tenant: { type: "string" },
        key: { type: "string" },
      },
    });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (rest.length > 0) throw new UsageError(`unexpected arguments: ${rest.join(" ")}`);
  const tenants = new TenantService({ pool, clock: systemClock });
  const apiKeys = new ApiKeyService({ pool, clock: systemClock });

  switch (command) {
    case "create-tenant": {
      const quota = requireOption(values["quota-bytes"], "quota-bytes");
      if (!/^\d{1,16}$/.test(quota)) throw new UsageError("--quota-bytes must be a whole number");
      // Checked before anything is written, so bad scopes never leave a tenant without a key.
      const scopes = knownScopes(scopesOption(values.scopes));
      const tenant = await tenants.createTenant(requireOption(values.name, "name"), Number(quota));
      const issued = await apiKeys.issueKey(tenant.id, "initial key", scopes);
      process.stdout.write(`tenant  ${tenant.id}\napi key ${issued.token}\n`);
      return;
    }
    case "issue-key": {
      const tenantId = tenantOption(values.tenant);
      const issued = await apiKeys.issueKey(
        tenantId,
        values.name ?? "api key",
        scopesOption(values.scopes),
      );
      process.stdout.write(`key     ${issued.key.id}\napi key ${issued.token}\n`);
      return;
    }
    case "list-keys": {
      const keys = await apiKeys.listKeys(tenantOption(values.tenant));
      for (const key of keys) {
        const state = key.revokedAt ? `revoked ${key.revokedAt.toISOString()}` : "active";
        process.stdout.write(`${key.id}  up_${key.prefix}_…  ${state}  ${key.scopes.join(",")}  ${key.name}\n`);
      }
      return;
    }
    case "revoke-key": {
      const keyId = requireOption(values.key, "key").toLowerCase();
      if (!isUuid(keyId)) throw new UsageError("--key must be a key id");
      const key = await apiKeys.revokeKey(tenantOption(values.tenant), keyId);
      process.stdout.write(`revoked ${key.id}\n`);
      return;
    }
    default:
      throw new UsageError(command === undefined ? "a command is required" : `unknown command ${command}`);
  }
});
