import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import type { Knex } from "knex";
import { createDb } from "../db/connection.js";
import { appendAudit } from "../modules/audit/service.js";
import { hashPassword } from "../modules/auth/password.js";
import {
  findUserByEmail,
  loadRoleKeys,
} from "../modules/auth/repository.js";
import { revokeAllUserSessionsInTx } from "../modules/auth/service.js";
import { lockCompany } from "../shared/company-lock.js";

/**
 * `npm run owner:recover -- --email <owner-email> --confirm-deployment <id>`
 * (task 1.4, spec §8: "mất owner dùng CLI recovery trên máy chủ, không
 * public endpoint").
 *
 * Operator-only recovery for a lost owner password — there is deliberately
 * NO HTTP route for this. Runs on the runtime credential (DML only):
 *
 *   1. DATABASE_URL (--url) connects; DEMO_MODE (default "production")
 *      must equal the database's recorded deployment_state.mode — the same
 *      guard the app boot uses, so the CLI refuses a wrong-DB/mode pairing.
 *   2. --confirm-deployment must equal this deployment's company id —
 *      the operator must look it up on the target DB (`SELECT id FROM
 *      company`); it is never printed back, so the flag proves they did.
 *   3. --email must resolve to a user holding the owner role — re-checked
 *      under the company lock inside the write transaction.
 *   4. The new password is read from STDIN (a muted prompt on a TTY; the
 *      first line of piped input otherwise) — NEVER from argv, which would
 *      leak to ps/shell history.
 *   5. One transaction: argon2id hash + status='active' (a pending owner
 *      is activated; an inactive one is re-activated — the API has no
 *      reactivate path and this tool is the last resort) +
 *      auth_version+1 + every session revoked + audit
 *      (credential.owner_recovery, actor NULL — the operator is not a
 *      user; safe_metadata.reason="cli" marks the channel).
 */
const USAGE = `usage: npm run owner:recover -- --email <owner-email> --confirm-deployment <company-id> [--url <postgres-url>]

  --email <email>             Email of the owner account to recover (required)
  --confirm-deployment <id>   This deployment's company id (required) —
                              run "SELECT id FROM company" on the TARGET
                              database and paste the value; a mismatch refuses.
  --url <postgres-url>        DB URL — defaults to DATABASE_URL (runtime
                              credential is sufficient; DML only)

Refuses when DEMO_MODE disagrees with deployment_state.mode, when the
confirmation id does not match, or when the email is not an owner.
The new password is prompted on STDIN — never pass it as an argument.
`;

interface RecoverArgs {
  email: string;
  confirmDeployment: string;
  url?: string;
}

function parseArgs(argv: string[]): RecoverArgs {
  const out: Partial<RecoverArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case "--email":
        out.email = next();
        break;
      case "--confirm-deployment":
        out.confirmDeployment = next();
        break;
      case "--url":
        out.url = next();
        break;
      case "--help":
      case "-h":
        process.stdout.write(USAGE);
        process.exit(0);
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!out.email) throw new Error("--email is required");
  if (!out.confirmDeployment) {
    throw new Error(
      "--confirm-deployment is required — run \"SELECT id FROM company\" on the target DB",
    );
  }
  return out as RecoverArgs;
}

function resolveExpectedMode(raw: string | undefined): "demo" | "production" {
  if (raw === undefined || raw === "") return "production";
  if (raw === "demo" || raw === "production") return raw;
  throw new Error(`DEMO_MODE must be "demo" or "production", got "${raw}"`);
}

/** Prompt on a TTY without echoing typed characters. */
function promptHidden(query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    // readline echoes through _writeToOutput — swallow everything except
    // the trailing newline so the password never hits the scrollback.
    const mutable = rl as unknown as { _writeToOutput: (s: string) => void };
    mutable._writeToOutput = (s: string) => {
      if (s.includes("\n")) process.stdout.write("\n");
    };
    process.stdout.write(query);
    rl.question("", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
    rl.on("SIGINT", () => {
      rl.close();
      reject(new Error("aborted"));
    });
  });
}

/**
 * New password from STDIN only. Piped stdin → first non-empty line; TTY →
 * a muted prompt + confirmation. Never argv (ps/history leak), never env.
 */
async function readNewPassword(): Promise<string> {
  if (process.stdin.isTTY) {
    const first = await promptHidden("New owner password: ");
    const second = await promptHidden("Confirm new owner password: ");
    if (first !== second) {
      throw new Error("passwords do not match");
    }
    return first;
  }
  const raw = readFileSync(0, "utf8");
  const line = raw
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) throw new Error("no password on stdin");
  return line;
}

async function recoverOwner(db: Knex, args: RecoverArgs): Promise<void> {
  const expectedMode = resolveExpectedMode(process.env.DEMO_MODE);

  // Pre-flight reads BEFORE the password prompt: refuse wrong DB/mode and
  // non-owner targets without ever touching credentials.
  const state = (await db("deployment_state")
    .where({ singleton_id: 1 })
    .first()) as { mode: string } | undefined;
  if (!state) {
    throw new Error(
      "deployment_state singleton missing — run db:migrate on this database",
    );
  }
  if (state.mode !== expectedMode) {
    throw new Error(
      `MODE_MISMATCH: database mode is "${state.mode}" but DEMO_MODE is "${expectedMode}" — refusing to touch this deployment`,
    );
  }
  const company = (await db("company").select("id").first()) as
    | { id: string }
    | undefined;
  if (!company) {
    throw new Error("no company in this database — nothing to recover");
  }
  if (args.confirmDeployment !== company.id) {
    // Deliberately does NOT echo the expected id — the flag proves the
    // operator read it from the target DB themselves.
    throw new Error(
      "--confirm-deployment does not match this deployment's company id — refusing",
    );
  }

  const user = await findUserByEmail(db, args.email);
  if (!user || user.company_id !== company.id) {
    throw new Error("no user with that email in this deployment — refusing");
  }
  const roles = await loadRoleKeys(db, company.id, user.id);
  if (!roles.includes("owner")) {
    throw new Error(
      `refusing: ${args.email} is not an owner — owner recovery only`,
    );
  }
  if (user.status === "inactive") {
    console.error(
      `note: account "${args.email}" is inactive — recovery will re-activate it`,
    );
  }

  const password = await readNewPassword();
  if (password.length < 12 || password.length > 256) {
    throw new Error("password must be 12–256 characters");
  }
  // Argon2id ~250 ms runs outside the write transaction.
  const passwordHash = await hashPassword(password);
  const requestId = randomUUID(); // operator command — no HTTP request id.

  let revoked = 0;
  await db.transaction(async (tx) => {
    await lockCompany(tx, company.id);
    // Re-verify under the lock: the owner role check pre-prompt is
    // advisory; this one is authoritative.
    const locked = (await tx("app_user")
      .where({ id: user.id, company_id: company.id })
      .forUpdate()
      .first()) as { id: string } | undefined;
    if (!locked) {
      throw new Error("target user vanished — aborting");
    }
    const lockedRoles = await loadRoleKeys(tx, company.id, user.id);
    if (!lockedRoles.includes("owner")) {
      throw new Error(`refusing: ${args.email} is not an owner (re-checked)`);
    }

    await tx("app_user")
      .where({ id: user.id, company_id: company.id })
      .update({
        password_hash: passwordHash,
        status: "active",
        auth_version: tx.raw("auth_version + 1"),
      });
    // Session kill rides the same commit as the credential write.
    revoked = await revokeAllUserSessionsInTx(
      tx,
      () => new Date(),
      user.id,
      requestId,
      "owner_recovery",
    );
    await appendAudit(tx, {
      companyId: company.id,
      // actor NULL: the operator is not an app_user; the "cli" reason
      // marks the non-HTTP channel (audit FK allows NULL actor).
      actorId: undefined,
      action: "credential.owner_recovery",
      targetType: "app_user",
      targetId: user.id,
      outcome: "success",
      requestId,
      metadata: { reason: "cli" },
    });
  });

  // Never print the password, the hash or any session material.
  console.log(
    `owner recovered: ${args.email} — password set, ${revoked} session(s) revoked`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const url = args.url ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "owner:recover requires DATABASE_URL (or --url) — the runtime credential is sufficient",
      );
    }
    let scheme: string;
    try {
      scheme = new URL(url).protocol.replace(/:$/, "");
    } catch {
      throw new Error("owner:recover connection URL is not a valid URL");
    }
    if (scheme !== "postgres" && scheme !== "postgresql") {
      throw new Error(
        `owner:recover connection URL must be a postgres:// URL, got scheme "${scheme}"`,
      );
    }
    const db = createDb(url);
    try {
      await recoverOwner(db, args);
    } finally {
      await db.destroy().catch(() => {});
    }
  })().catch((err: unknown) => {
    console.error(
      "owner:recover failed:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });
}
