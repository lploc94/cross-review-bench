import { parseArgs } from "node:util";
import { SCOPES } from "../domain/scopes.js";
import { systemClock } from "../infra/clock.js";
import { ApiKeyService } from "../services/apiKeyService.js";
import { TenantService } from "../services/tenantService.js";
import { UsageError, runScript } from "./cli.js";

const USAGE = `usage: npm run create-tenant -- --name <tenant name> [--key-name <name>] [--scopes <a,b,…>]

Creates a tenant and its first API key and prints both as JSON. The key's token is shown only
once. --scopes defaults to every scope: ${SCOPES.join(", ")}.`;

await runScript(USAGE, async ({ pool }) => {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        name: { type: "string" },
        "key-name": { type: "string", default: "default" },
        scopes: { type: "string" },
      },
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  if (!values.name) throw new UsageError("--name is required");
  const scopes = values.scopes
    ? values.scopes.split(",").map((scope) => scope.trim()).filter(Boolean)
    : [...SCOPES];

  const tenant = await new TenantService({ pool, clock: systemClock }).createTenant(values.name);
  const issued = await new ApiKeyService({ pool, clock: systemClock }).issueKey(
    tenant.id,
    values["key-name"],
    scopes,
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        tenant: { id: tenant.id, name: tenant.name },
        api_key: { id: issued.key.id, name: issued.key.name, scopes: issued.key.scopes, token: issued.token },
      },
      null,
      2,
    )}\n`,
  );
});
