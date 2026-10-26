/** Command-line arguments: a command, its positional arguments, and `--name value` options. */
export interface ParsedArgs {
  readonly command: string | null;
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, string>;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const GLOBAL_OPTIONS = ["db", "server", "token"] as const;

/**
 * Parse `argv` (without the node and script paths). Options may appear anywhere, take one value
 * (`--db file` or `--db=file`) and may be given once; `--` ends the options.
 */
export function parseArgs(argv: readonly string[], allowed: readonly string[] = GLOBAL_OPTIONS): ParsedArgs {
  const options = new Map<string, string>();
  const positionals: string[] = [];
  let onlyPositionals = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (onlyPositionals || !arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      onlyPositionals = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (!allowed.includes(name)) throw new UsageError(`unknown option --${name}`);
    let value: string | undefined;
    if (eq >= 0) {
      value = arg.slice(eq + 1);
    } else {
      value = argv[i + 1];
      // `--db --token x` is a missing value, not a file named "--token".
      if (value?.startsWith("--")) value = undefined;
      else i += 1;
    }
    if (value === undefined || value === "") throw new UsageError(`--${name} needs a value`);
    if (options.has(name)) throw new UsageError(`--${name} given twice`);
    options.set(name, value);
  }
  const [command, ...rest] = positionals;
  return { command: command ?? null, positionals: rest, options };
}
