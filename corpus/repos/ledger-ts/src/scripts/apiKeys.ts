import { parseArgs } from "node:util";
import { SCOPES } from "../domain/scopes.js";
import { systemClock } from "../infra/clock.js";
import * as apiKeys from "../repositories/apiKeys.js";
import { ApiKeyService } from "../services/apiKeyService.js";
import { UsageError, runScript } from "./cli.js";

const USAGE = `usage:
  npm run api-keys -- issue  --tenant <tenant id> --name <key name> [--scopes <a,b,…>]
  npm run api-keys -- list   --tenant <tenant id>
  npm run api-keys -- revoke --tenant <tenant id> --id <key id>

Scopes: ${SCOPES.join(", ")} (issue defaults to all of them). An issued token is printed once.`;

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

await runScript(USAGE, async ({ pool }) => {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        tenant: { type: "string" },
        name: { type: "string" },
        scopes: { type: "string" },
        id: { type: "string" },
      },
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const { values, positionals } = parsed;
  const [command] = positionals;
  if (!values.tenant) throw new UsageError("--tenant is required");
  const service = new ApiKeyService({ pool, clock: systemClock });

  switch (command) {
    case "issue": {
      if (!values.name) throw new UsageError("--name is required");
      const scopes = values.scopes
        ? values.scopes.split(",").map((scope) => scope.trim()).filter(Boolean)
        : [...SCOPES];
      const issued = await service.issueKey(values.tenant, values.name, scopes);
      print({ id: issued.key.id, name: issued.key.name, scopes: issued.key.scopes, token: issued.token });
      return;
    }
    case "list": {
      const keys = await apiKeys.listApiKeys(pool, values.tenant);
      print(
        keys.map((key) => ({
          id: key.id,
          name: key.name,
          prefix: key.prefix,
          scopes: key.scopes,
          created_at: key.createdAt.toISOString(),
          revoked_at: key.revokedAt?.toISOString() ?? null,
        })),
      );
      return;
    }
    case "revoke": {
      if (!values.id) throw new UsageError("--id is required");
      const key = await service.revokeKey(values.tenant, values.id);
      print({ id: key.id, revoked_at: key.revokedAt?.toISOString() ?? null });
      return;
    }
    default:
      throw new UsageError(command ? `unknown command ${command}` : "a command is required");
  }
});
