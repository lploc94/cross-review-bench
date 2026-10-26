/**
 * Permissions an API key can carry. A route names the one scope it needs and the key must hold
 * exactly that scope: there are no wildcards and no scope implies another.
 */
export const SCOPES = [
  "files:read",
  "files:write",
  "files:delete",
  "uploads:write",
  "tenant:read",
  "tenant:admin",
] as const;

export type Scope = (typeof SCOPES)[number];

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

export function hasScope(granted: readonly string[], required: Scope): boolean {
  return granted.includes(required);
}

/** Split a list into known scopes (deduplicated) and the names that are not scopes. */
export function partitionScopes(values: readonly string[]): { valid: Scope[]; unknown: string[] } {
  const valid: Scope[] = [];
  const unknown: string[] = [];
  for (const value of values) {
    if (isScope(value)) {
      if (!valid.includes(value)) valid.push(value);
    } else {
      unknown.push(value);
    }
  }
  return { valid, unknown };
}
