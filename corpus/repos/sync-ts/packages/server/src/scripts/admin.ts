import { systemClock } from "@sync/shared";
import type { Pool } from "../db/pool.js";
import type { User } from "../domain/accounts.js";
import { AccountService } from "../services/accountService.js";
import { ConsistencyService } from "../services/consistencyService.js";
import { StatsService } from "../services/statsService.js";
import { parseOptions, requireOption, runScript, UsageError } from "./cli.js";

const USAGE = `usage:
  npm run admin -- create-user --email <email> --name <display name> [--device <device name>]
  npm run admin -- add-device --email <email> --device <device name>
  npm run admin -- list-devices --email <email>
  npm run admin -- stats --email <email>
  npm run admin -- verify --email <email>      exits 1 when the documents disagree with the events`;

const [command, ...args] = process.argv.slice(2);

async function userByEmail(accounts: AccountService, options: Map<string, string>): Promise<User> {
  const email = requireOption(options, "email");
  const user = await accounts.findUserByEmail(email);
  if (!user) throw new Error(`no user with email ${email}`);
  return user;
}

async function printStats(pool: Pool, user: User): Promise<void> {
  const stats = await new StatsService({ pool }).userStats(user.id);
  process.stdout.write(`user ${user.id} (${user.email})\n`);
  process.stdout.write(`events ${stats.events}, latest seq ${stats.latestSeq}\n`);
  for (const [collection, count] of stats.documentsByCollection) {
    process.stdout.write(`${collection} ${count}\n`);
  }
  for (const device of stats.devices) {
    const behind = device.behind === null ? "never pulled" : `${device.behind} behind`;
    process.stdout.write(`device ${device.id}\t${device.name}\t${behind}\n`);
  }
}

await runScript(USAGE, async ({ pool }) => {
  const accounts = new AccountService({ pool, clock: systemClock });
  switch (command) {
    case "create-user": {
      const options = parseOptions(args, ["email", "name", "device"]);
      const created = await accounts.createUser({
        email: requireOption(options, "email"),
        displayName: requireOption(options, "name"),
        deviceName: options.get("device") ?? "first device",
      });
      process.stdout.write(
        `user ${created.user.id} (${created.user.email})\n` +
          `device ${created.device.id} (${created.device.name})\n` +
          `token ${created.token}\n`,
      );
      return;
    }
    case "add-device": {
      const options = parseOptions(args, ["email", "device"]);
      const user = await userByEmail(accounts, options);
      const registered = await accounts.registerDevice(user.id, requireOption(options, "device"));
      process.stdout.write(`device ${registered.device.id} (${registered.device.name})\ntoken ${registered.token}\n`);
      return;
    }
    case "list-devices": {
      const user = await userByEmail(accounts, parseOptions(args, ["email"]));
      for (const device of await accounts.listDevices(user.id)) {
        const seen = device.lastSeenAt?.toISOString() ?? "never";
        const cursor = device.lastPulledSeq ?? "-";
        process.stdout.write(`${device.id}\t${device.name}\tlast seen ${seen}\tcursor ${cursor}\n`);
      }
      return;
    }
    case "stats": {
      await printStats(pool, await userByEmail(accounts, parseOptions(args, ["email"])));
      return;
    }
    case "verify": {
      const user = await userByEmail(accounts, parseOptions(args, ["email"]));
      const report = await new ConsistencyService({ pool }).verifyUser(user.id);
      process.stdout.write(`checked ${report.events} events and ${report.documents} documents\n`);
      for (const problem of report.problems) process.stdout.write(`${JSON.stringify(problem)}\n`);
      if (report.truncated) process.stdout.write("more problems were found than shown\n");
      if (report.problems.length > 0) process.exitCode = 1;
      return;
    }
    default:
      throw new UsageError(command === undefined ? "a command is required" : `unknown command ${command}`);
  }
});
