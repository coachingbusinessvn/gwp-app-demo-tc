# Phase 0 — Foundation (Backend + Real Auth) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a Node/TypeScript API + SQLite behind the existing static frontend, with real email/password login (JWT) replacing the fake role-picker, and the demo people seeded into the database.

**Architecture:** A single Express (TypeScript) server exposes a versioned REST API under `/api/v1` and serves the existing HTML/CSS/JS as static files. All business logic lives in a `services/` layer beneath the routes so future clients (MCP, mobile) reuse it. Auth uses JWT access tokens + rotating refresh tokens stored (hashed) in the DB. Data access goes through Knex so the same code runs on SQLite (default) or Postgres (optional).

**Tech Stack:** Node.js, TypeScript, Express, Knex (better-sqlite3 / pg), jsonwebtoken, bcryptjs, zod, dotenv; Vitest + Supertest for tests; tsx for running TS.

**Spec:** `docs/superpowers/specs/2026-09-19-gwp-app-real-design.md` (this plan implements Phase 0 from §4; see §2 API-first, §5 data model, §6 roles, §8 auth/config).

## Global Constraints

- **Self-hostable, data stays on the customer's server; nothing leaves except calls to the admin-configured AI endpoint** (no AI in Phase 0). Never add a foreign managed data service.
- **API-first:** all business logic in `server/src/services/`; routes are thin; the frontend is just a client. Never put business logic in frontend JS.
- **Auth is JWT/token-based (not cookie-only), with CORS and `/api/v1` versioning from the start** (so mobile/MCP are future clients, not retrofits).
- **Dual database via Knex:** SQLite default (a single file), Postgres optional; the same query code must run on both. Store document columns as JSON text.
- **No secrets in code:** read `DEMO_MODE`, `DB`, `JWT_SECRET`, `APP_KEY` from environment (`.env` for dev, never committed).
- **Seed identity ids must equal the legacy `assets/data.js` `PEOPLE` keys** (`l1`, `p7`, `thn`, `td`, `hr`, `s1`–`s5`) so the existing frontend's `PEOPLE[me.id]` lookups keep working.
- **Backend lives in `server/`; the static site stays at repo root** (keeps the GitHub Pages demo working). The server serves the repo root as static with `dotfiles: 'deny'`.

---

## File Structure

```
server/
  package.json               # backend deps + scripts
  tsconfig.json
  vitest.config.ts
  .env.example               # documents env vars (committed); real .env is gitignored
  knexfile.ts                # Knex config derived from env (sqlite | postgres)
  src/
    config.ts                # typed env loader
    app.ts                   # express app factory (no listen) — used by tests
    index.ts                 # entry: builds app + app.listen
    db/
      knex.ts                # singleton Knex instance
      migrations/
        20260919_0001_init.ts   # companies, roles, users, user_roles, refresh_tokens
      seed.ts                # idempotent seed from legacy data.js content
    types/
      index.ts               # shared TS types (Role, UserRow, UserPublic, AccessClaims, TokenPair)
    services/
      password.service.ts    # hashPassword / verifyPassword
      token.service.ts       # access-token sign/verify + refresh-token create/rotate/revoke
      user.service.ts        # findByEmail / getUserPublic
    middleware/
      auth.middleware.ts     # requireAuth (Bearer -> req.user)
      error.middleware.ts    # central error handler
    api/v1/
      index.ts               # mounts v1 sub-routers
      auth.routes.ts         # /login /refresh /logout /me
  tests/
    password.service.test.ts
    token.service.test.ts
    auth.routes.test.ts
    seed.test.ts

assets/
  auth.js                    # NEW: pure session/token helpers (window.GWPAuth), storage-injectable

# modified static files:
index.html                   # role-picker -> real email/password login form
assets/app.js                # session()/requireSession()/signOut() use GWPAuth + JWT
dashboard.html employee.html canvas.html   # add <script src="assets/auth.js"> before app.js
```

---

## Task 1: Backend scaffold + health endpoint

**Files:**
- Create: `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`, `server/.env.example`
- Create: `server/src/config.ts`, `server/src/app.ts`, `server/src/index.ts`
- Create: `server/src/middleware/error.middleware.ts`
- Test: `server/tests/health.test.ts`

**Interfaces:**
- Produces: `createApp(): express.Express` (from `src/app.ts`); `config` object `{ demoMode: boolean; db: string; jwtSecret: string; appKey: string; accessTtl: string; refreshTtlDays: number; port: number }` (from `src/config.ts`).

- [ ] **Step 1: Create `server/package.json`**

```json
{
  "name": "gwp-app-server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "migrate": "tsx node_modules/knex/bin/cli.js --knexfile knexfile.ts migrate:latest",
    "seed": "tsx src/db/seed.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "better-sqlite3": "^11.3.0",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "jsonwebtoken": "^9.0.2",
    "knex": "^3.1.0",
    "pg": "^8.12.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/bcryptjs": "^2.4.6",
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/jsonwebtoken": "^9.0.6",
    "@types/node": "^22.5.0",
    "@types/supertest": "^6.0.2",
    "supertest": "^7.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 2: Create `server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src", "knexfile.ts"]
}
```

- [ ] **Step 3: Create `server/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
  },
});
```

- [ ] **Step 4: Create `server/.env.example`**

```bash
# Copy to server/.env for local dev. Never commit the real .env.
DEMO_MODE=on
# sqlite: a file path. postgres: a postgres:// URL.
DB=./data/app.db
JWT_SECRET=dev-only-change-me
# Encryption key for BYOK secrets (used from Phase 3). 32+ chars.
APP_KEY=dev-only-change-me-32-characters-min
PORT=8787
```

- [ ] **Step 5: Create `server/src/config.ts`**

```ts
import "dotenv/config";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing env var: ${name}`);
  return v;
}

export const config = {
  demoMode: (process.env.DEMO_MODE ?? "off").toLowerCase() === "on",
  db: required("DB", "./data/app.db"),
  jwtSecret: required("JWT_SECRET", "dev-only-change-me"),
  appKey: required("APP_KEY", "dev-only-change-me-32-characters-min"),
  accessTtl: process.env.ACCESS_TTL ?? "15m",
  refreshTtlDays: Number(process.env.REFRESH_TTL_DAYS ?? "30"),
  port: Number(process.env.PORT ?? "8787"),
};

export type Config = typeof config;
```

- [ ] **Step 6: Create `server/src/middleware/error.middleware.ts`**

```ts
import type { NextFunction, Request, Response } from "express";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(err);
  return res.status(500).json({ error: "Internal Server Error" });
}
```

- [ ] **Step 7: Create `server/src/app.ts`**

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { errorHandler } from "./middleware/error.middleware.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// repo root = two levels up from server/src
const STATIC_ROOT = process.env.STATIC_DIR ?? path.resolve(__dirname, "../..");

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/api/v1/health", (_req, res) => res.json({ ok: true }));

  // static frontend (existing site at repo root). deny dotfiles so .env is never served.
  app.use(express.static(STATIC_ROOT, { dotfiles: "deny", index: "index.html" }));

  app.use(errorHandler);
  return app;
}
```

- [ ] **Step 8: Create `server/src/index.ts`**

```ts
import { createApp } from "./app.js";
import { config } from "./config.js";

const app = createApp();
app.listen(config.port, () => {
  console.log(`GWP server on http://localhost:${config.port} (demo=${config.demoMode})`);
});
```

- [ ] **Step 9: Write the failing test `server/tests/health.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";

describe("health", () => {
  it("returns ok", async () => {
    const res = await request(createApp()).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
```

- [ ] **Step 10: Install deps and run the test**

Run: `cd server && npm install && npm test`
Expected: PASS (1 test).

- [ ] **Step 11: Add root `.gitignore` entries and commit**

Append to repo-root `.gitignore`:
```
server/node_modules
server/dist
server/.env
server/data
```

```bash
git add server/package.json server/package-lock.json server/tsconfig.json server/vitest.config.ts server/.env.example server/src/config.ts server/src/app.ts server/src/index.ts server/src/middleware/error.middleware.ts server/tests/health.test.ts .gitignore
git commit -m "feat(server): scaffold express+ts server with health endpoint and static serving"
```

---

## Task 2: Database schema (Knex migration)

**Files:**
- Create: `server/knexfile.ts`, `server/src/db/knex.ts`, `server/src/db/migrations/20260919_0001_init.ts`
- Create: `server/src/types/index.ts`
- Test: `server/tests/migration.test.ts`

**Interfaces:**
- Produces: `db` (Knex instance, from `src/db/knex.ts`); tables `companies`, `roles`, `users`, `user_roles`, `refresh_tokens`.
- Produces types (from `src/types/index.ts`):
  ```ts
  export type RoleKey = "owner" | "admin" | "manager" | "member";
  export interface UserRow {
    id: string; company_id: string; name: string; email: string;
    password_hash: string; title: string | null;
    department_id: string | null; team_id: string | null; manager_id: string | null;
    created_at: string;
  }
  export interface UserPublic {
    id: string; company_id: string; name: string; email: string;
    title: string | null; department_id: string | null; team_id: string | null;
    manager_id: string | null; roles: RoleKey[];
  }
  export interface AccessClaims { sub: string; company_id: string; roles: RoleKey[]; }
  export interface TokenPair { accessToken: string; refreshToken: string; }
  ```

- [ ] **Step 1: Create `server/src/types/index.ts`** with the exact types listed in the Interfaces block above.

- [ ] **Step 2: Create `server/knexfile.ts`**

```ts
import type { Knex } from "knex";
import { config as appConfig } from "./src/config.js";

function knexConfig(): Knex.Config {
  const db = appConfig.db;
  if (db.startsWith("postgres://") || db.startsWith("postgresql://")) {
    return {
      client: "pg",
      connection: db,
      migrations: { directory: "./src/db/migrations", extension: "ts" },
    };
  }
  return {
    client: "better-sqlite3",
    connection: { filename: db },
    useNullAsDefault: true,
    migrations: { directory: "./src/db/migrations", extension: "ts" },
  };
}

export default knexConfig();
```

- [ ] **Step 3: Create `server/src/db/knex.ts`**

```ts
import knexLib from "knex";
import knexConfig from "../../knexfile.js";

export const db = knexLib(knexConfig);
```

- [ ] **Step 4: Create the migration `server/src/db/migrations/20260919_0001_init.ts`**

```ts
import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("companies", (t) => {
    t.string("id").primary();
    t.string("name").notNullable();
    t.text("settings").notNullable().defaultTo("{}"); // JSON text
    t.timestamp("created_at").defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("roles", (t) => {
    t.string("id").primary();
    t.string("key").notNullable().unique(); // owner|admin|manager|member
    t.string("label").notNullable();
  });

  await knex.schema.createTable("users", (t) => {
    t.string("id").primary();
    t.string("company_id").notNullable().references("id").inTable("companies");
    t.string("name").notNullable();
    t.string("email").notNullable();
    t.string("password_hash").notNullable();
    t.string("title");
    t.string("department_id"); // FK added in Phase 1
    t.string("team_id"); // FK added in Phase 1
    t.string("manager_id").references("id").inTable("users");
    t.timestamp("created_at").defaultTo(knex.fn.now());
    t.unique(["company_id", "email"]);
  });

  await knex.schema.createTable("user_roles", (t) => {
    t.string("user_id").notNullable().references("id").inTable("users").onDelete("CASCADE");
    t.string("role_id").notNullable().references("id").inTable("roles").onDelete("CASCADE");
    t.primary(["user_id", "role_id"]);
  });

  await knex.schema.createTable("refresh_tokens", (t) => {
    t.string("id").primary();
    t.string("user_id").notNullable().references("id").inTable("users").onDelete("CASCADE");
    t.string("token_hash").notNullable().unique();
    t.timestamp("expires_at").notNullable();
    t.timestamp("created_at").defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("refresh_tokens");
  await knex.schema.dropTableIfExists("user_roles");
  await knex.schema.dropTableIfExists("users");
  await knex.schema.dropTableIfExists("roles");
  await knex.schema.dropTableIfExists("companies");
}
```

- [ ] **Step 5: Write the failing test `server/tests/migration.test.ts`**

```ts
import { afterAll, describe, expect, it } from "vitest";
import knexLib from "knex";

const db = knexLib({
  client: "better-sqlite3",
  connection: { filename: ":memory:" },
  useNullAsDefault: true,
  migrations: { directory: "./src/db/migrations", extension: "ts" },
});

describe("migration", () => {
  it("creates all core tables", async () => {
    await db.migrate.latest();
    for (const table of ["companies", "roles", "users", "user_roles", "refresh_tokens"]) {
      expect(await db.schema.hasTable(table)).toBe(true);
    }
  });
  afterAll(async () => db.destroy());
});
```

- [ ] **Step 6: Run the test**

Run: `cd server && npm test -- migration`
Expected: PASS (tables created in an in-memory SQLite db).

- [ ] **Step 7: Commit**

```bash
git add server/knexfile.ts server/src/db/knex.ts server/src/db/migrations/20260919_0001_init.ts server/src/types/index.ts server/tests/migration.test.ts
git commit -m "feat(server): add knex config and initial schema migration"
```

---

## Task 3: Password service (hash + verify)

**Files:**
- Create: `server/src/services/password.service.ts`
- Test: `server/tests/password.service.test.ts`

**Interfaces:**
- Produces: `hashPassword(plain: string): Promise<string>`, `verifyPassword(plain: string, hash: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing test `server/tests/password.service.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/services/password.service.js";

describe("password.service", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("demo");
    expect(hash).not.toBe("demo");
    expect(await verifyPassword("demo", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm test -- password`
Expected: FAIL (module not found).

- [ ] **Step 3: Create `server/src/services/password.service.ts`**

```ts
import bcrypt from "bcryptjs";

const ROUNDS = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npm test -- password`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/password.service.ts server/tests/password.service.test.ts
git commit -m "feat(server): add password hashing service"
```

---

## Task 4: Token service (access JWT + rotating refresh tokens)

**Files:**
- Create: `server/src/services/token.service.ts`
- Test: `server/tests/token.service.test.ts`

**Interfaces:**
- Consumes: `db` (`src/db/knex.ts`), `config` (`src/config.ts`), types `AccessClaims`, `RoleKey`.
- Produces:
  - `signAccessToken(claims: AccessClaims): string`
  - `verifyAccessToken(token: string): AccessClaims` (throws on invalid/expired)
  - `issueRefreshToken(userId: string): Promise<string>` (returns raw token; stores only its hash)
  - `rotateRefreshToken(raw: string): Promise<{ userId: string; refreshToken: string }>` (throws if unknown/expired; deletes the used row)
  - `revokeRefreshToken(raw: string): Promise<void>`

- [ ] **Step 1: Write the failing test `server/tests/token.service.test.ts`**

```ts
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { db } from "../src/db/knex.js";
import {
  signAccessToken, verifyAccessToken,
  issueRefreshToken, rotateRefreshToken, revokeRefreshToken,
} from "../src/services/token.service.js";

beforeAll(async () => {
  await db.migrate.latest();
  await db("companies").insert({ id: "c1", name: "Demo Co" });
  await db("users").insert({
    id: "u1", company_id: "c1", name: "U One",
    email: "u1@demo.gwp.vn", password_hash: "x",
  });
});
afterAll(async () => db.destroy());

describe("token.service", () => {
  it("signs and verifies an access token", () => {
    const token = signAccessToken({ sub: "u1", company_id: "c1", roles: ["member"] });
    const claims = verifyAccessToken(token);
    expect(claims.sub).toBe("u1");
    expect(claims.roles).toContain("member");
  });

  it("rejects a tampered token", () => {
    expect(() => verifyAccessToken("not.a.jwt")).toThrow();
  });

  it("issues, rotates, and revokes refresh tokens", async () => {
    const raw = await issueRefreshToken("u1");
    const rotated = await rotateRefreshToken(raw);
    expect(rotated.userId).toBe("u1");
    // old token no longer valid after rotation
    await expect(rotateRefreshToken(raw)).rejects.toThrow();
    // new token can be revoked
    await revokeRefreshToken(rotated.refreshToken);
    await expect(rotateRefreshToken(rotated.refreshToken)).rejects.toThrow();
  });
});
```

> Note: this test uses the default `DB=./data/app.db`. Set `DB=:memory:` in the test env, or ensure `server/.env` points at a throwaway file. Add `server/data/` to `.gitignore` (done in Task 1). For a clean in-memory run, prefix: `DB=:memory: npm test -- token`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && DB=:memory: npm test -- token`
Expected: FAIL (module not found).

- [ ] **Step 3: Create `server/src/services/token.service.ts`**

```ts
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { db } from "../db/knex.js";
import type { AccessClaims } from "../types/index.js";

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, config.jwtSecret, { expiresIn: config.accessTtl });
}

export function verifyAccessToken(token: string): AccessClaims {
  const decoded = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
  return {
    sub: String(decoded.sub),
    company_id: String(decoded.company_id),
    roles: (decoded.roles ?? []) as AccessClaims["roles"],
  };
}

function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export async function issueRefreshToken(userId: string): Promise<string> {
  const raw = crypto.randomBytes(48).toString("hex");
  const expires = new Date(Date.now() + config.refreshTtlDays * 864e5);
  await db("refresh_tokens").insert({
    id: crypto.randomUUID(),
    user_id: userId,
    token_hash: hashToken(raw),
    expires_at: expires.toISOString(),
  });
  return raw;
}

export async function rotateRefreshToken(
  raw: string,
): Promise<{ userId: string; refreshToken: string }> {
  const row = await db("refresh_tokens").where({ token_hash: hashToken(raw) }).first();
  if (!row) throw new Error("invalid refresh token");
  await db("refresh_tokens").where({ id: row.id }).del();
  if (new Date(row.expires_at).getTime() < Date.now()) throw new Error("expired refresh token");
  const refreshToken = await issueRefreshToken(row.user_id);
  return { userId: row.user_id, refreshToken };
}

export async function revokeRefreshToken(raw: string): Promise<void> {
  await db("refresh_tokens").where({ token_hash: hashToken(raw) }).del();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && DB=:memory: npm test -- token`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/token.service.ts server/tests/token.service.test.ts
git commit -m "feat(server): add JWT access + rotating refresh token service"
```

---

## Task 5: User service (lookup + public projection)

**Files:**
- Create: `server/src/services/user.service.ts`
- Test: `server/tests/user.service.test.ts`

**Interfaces:**
- Consumes: `db`, types `UserRow`, `UserPublic`, `RoleKey`.
- Produces:
  - `findByEmail(companyScope: string | null, email: string): Promise<UserRow | undefined>` (companyScope null = search all companies; Phase 0 single-company passes null)
  - `getUserPublic(userId: string): Promise<UserPublic | undefined>`
  - `getUserRoles(userId: string): Promise<RoleKey[]>`

- [ ] **Step 1: Write the failing test `server/tests/user.service.test.ts`**

```ts
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { db } from "../src/db/knex.js";
import { findByEmail, getUserPublic, getUserRoles } from "../src/services/user.service.js";

beforeAll(async () => {
  await db.migrate.latest();
  await db("companies").insert({ id: "c1", name: "Demo Co" });
  await db("roles").insert([
    { id: "r-admin", key: "admin", label: "Admin" },
    { id: "r-member", key: "member", label: "Member" },
  ]);
  await db("users").insert({
    id: "u1", company_id: "c1", name: "U One", title: "Boss",
    email: "u1@demo.gwp.vn", password_hash: "x",
  });
  await db("user_roles").insert([
    { user_id: "u1", role_id: "r-admin" },
    { user_id: "u1", role_id: "r-member" },
  ]);
});
afterAll(async () => db.destroy());

describe("user.service", () => {
  it("finds a user by email", async () => {
    const u = await findByEmail(null, "u1@demo.gwp.vn");
    expect(u?.id).toBe("u1");
  });
  it("returns a public projection with roles", async () => {
    const pub = await getUserPublic("u1");
    expect(pub?.name).toBe("U One");
    expect(pub?.roles.sort()).toEqual(["admin", "member"]);
    expect((pub as any).password_hash).toBeUndefined();
  });
  it("returns roles list", async () => {
    expect((await getUserRoles("u1")).sort()).toEqual(["admin", "member"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && DB=:memory: npm test -- user.service`
Expected: FAIL (module not found).

- [ ] **Step 3: Create `server/src/services/user.service.ts`**

```ts
import { db } from "../db/knex.js";
import type { RoleKey, UserPublic, UserRow } from "../types/index.js";

export async function findByEmail(
  companyScope: string | null,
  email: string,
): Promise<UserRow | undefined> {
  const q = db<UserRow>("users").where({ email });
  if (companyScope) q.andWhere({ company_id: companyScope });
  return q.first();
}

export async function getUserRoles(userId: string): Promise<RoleKey[]> {
  const rows = await db("user_roles")
    .join("roles", "roles.id", "user_roles.role_id")
    .where("user_roles.user_id", userId)
    .select<{ key: RoleKey }[]>("roles.key as key");
  return rows.map((r) => r.key);
}

export async function getUserPublic(userId: string): Promise<UserPublic | undefined> {
  const u = await db<UserRow>("users").where({ id: userId }).first();
  if (!u) return undefined;
  const roles = await getUserRoles(userId);
  return {
    id: u.id, company_id: u.company_id, name: u.name, email: u.email,
    title: u.title, department_id: u.department_id, team_id: u.team_id,
    manager_id: u.manager_id, roles,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && DB=:memory: npm test -- user.service`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/user.service.ts server/tests/user.service.test.ts
git commit -m "feat(server): add user lookup and public-projection service"
```

---

## Task 6: Auth middleware (`requireAuth`)

**Files:**
- Create: `server/src/middleware/auth.middleware.ts`
- Test: `server/tests/auth.middleware.test.ts`

**Interfaces:**
- Consumes: `verifyAccessToken` (token.service), `HttpError` (error.middleware), `AccessClaims`.
- Produces: `requireAuth(req, res, next)` express middleware that sets `req.user: AccessClaims` or responds 401. Also augments Express `Request` with an optional `user?: AccessClaims`.

- [ ] **Step 1: Write the failing test `server/tests/auth.middleware.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { requireAuth } from "../src/middleware/auth.middleware.js";
import { signAccessToken } from "../src/services/token.service.js";
import { errorHandler } from "../src/middleware/error.middleware.js";

function appWithGuard() {
  const app = express();
  app.get("/protected", requireAuth, (req, res) => res.json({ sub: (req as any).user.sub }));
  app.use(errorHandler);
  return app;
}

describe("requireAuth", () => {
  it("401s without a token", async () => {
    const res = await request(appWithGuard()).get("/protected");
    expect(res.status).toBe(401);
  });
  it("passes with a valid Bearer token", async () => {
    const token = signAccessToken({ sub: "u1", company_id: "c1", roles: ["member"] });
    const res = await request(appWithGuard()).get("/protected").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.sub).toBe("u1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && DB=:memory: npm test -- auth.middleware`
Expected: FAIL (module not found).

- [ ] **Step 3: Create `server/src/middleware/auth.middleware.ts`**

```ts
import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../services/token.service.js";
import { HttpError } from "./error.middleware.js";
import type { AccessClaims } from "../types/index.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: AccessClaims; }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return next(new HttpError(401, "Unauthorized"));
  try {
    req.user = verifyAccessToken(token);
    next();
  } catch {
    next(new HttpError(401, "Unauthorized"));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && DB=:memory: npm test -- auth.middleware`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/middleware/auth.middleware.ts server/tests/auth.middleware.test.ts
git commit -m "feat(server): add requireAuth JWT middleware"
```

---

## Task 7: Auth routes (`/login`, `/refresh`, `/logout`, `/me`)

**Files:**
- Create: `server/src/api/v1/auth.routes.ts`, `server/src/api/v1/index.ts`
- Modify: `server/src/app.ts` (mount the v1 router)
- Test: `server/tests/auth.routes.test.ts`

**Interfaces:**
- Consumes: password/token/user services, `requireAuth`, `HttpError`.
- Produces: router mounted at `/api/v1` with:
  - `POST /api/v1/auth/login` body `{ email, password }` → `200 { user: UserPublic, accessToken, refreshToken }` or `401`
  - `POST /api/v1/auth/refresh` body `{ refreshToken }` → `200 { accessToken, refreshToken }` or `401`
  - `POST /api/v1/auth/logout` body `{ refreshToken }` → `204`
  - `GET /api/v1/auth/me` (Bearer) → `200 { user: UserPublic }` or `401`

- [ ] **Step 1: Write the failing test `server/tests/auth.routes.test.ts`**

```ts
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { db } from "../src/db/knex.js";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/services/password.service.js";

const app = createApp();

beforeAll(async () => {
  await db.migrate.latest();
  await db("companies").insert({ id: "c1", name: "Demo Co" });
  await db("roles").insert({ id: "r-member", key: "member", label: "Member" });
  await db("users").insert({
    id: "u1", company_id: "c1", name: "U One", title: "Staff",
    email: "u1@demo.gwp.vn", password_hash: await hashPassword("demo"),
  });
  await db("user_roles").insert({ user_id: "u1", role_id: "r-member" });
});
afterAll(async () => db.destroy());

describe("auth routes", () => {
  it("logs in and returns tokens + user", async () => {
    const res = await request(app).post("/api/v1/auth/login")
      .send({ email: "u1@demo.gwp.vn", password: "demo" });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe("u1");
    expect(res.body.user.roles).toContain("member");
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
  });

  it("rejects a wrong password", async () => {
    const res = await request(app).post("/api/v1/auth/login")
      .send({ email: "u1@demo.gwp.vn", password: "nope" });
    expect(res.status).toBe(401);
  });

  it("returns the current user for /me", async () => {
    const login = await request(app).post("/api/v1/auth/login")
      .send({ email: "u1@demo.gwp.vn", password: "demo" });
    const me = await request(app).get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${login.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("u1@demo.gwp.vn");
  });

  it("refreshes and then logs out", async () => {
    const login = await request(app).post("/api/v1/auth/login")
      .send({ email: "u1@demo.gwp.vn", password: "demo" });
    const refreshed = await request(app).post("/api/v1/auth/refresh")
      .send({ refreshToken: login.body.refreshToken });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.accessToken).toBeTruthy();
    const out = await request(app).post("/api/v1/auth/logout")
      .send({ refreshToken: refreshed.body.refreshToken });
    expect(out.status).toBe(204);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && DB=:memory: npm test -- auth.routes`
Expected: FAIL (router not mounted / module not found).

- [ ] **Step 3: Create `server/src/api/v1/auth.routes.ts`**

```ts
import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../../middleware/error.middleware.js";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { verifyPassword } from "../../services/password.service.js";
import {
  signAccessToken, issueRefreshToken, rotateRefreshToken, revokeRefreshToken,
} from "../../services/token.service.js";
import { findByEmail, getUserPublic, getUserRoles } from "../../services/user.service.js";

export const authRoutes = Router();

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const refreshSchema = z.object({ refreshToken: z.string().min(1) });

authRoutes.post("/login", async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const user = await findByEmail(null, email);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      throw new HttpError(401, "Invalid credentials");
    }
    const roles = await getUserRoles(user.id);
    const accessToken = signAccessToken({ sub: user.id, company_id: user.company_id, roles });
    const refreshToken = await issueRefreshToken(user.id);
    const pub = await getUserPublic(user.id);
    res.json({ user: pub, accessToken, refreshToken });
  } catch (e) {
    if (e instanceof z.ZodError) return next(new HttpError(400, "Invalid request"));
    next(e);
  }
});

authRoutes.post("/refresh", async (req, res, next) => {
  try {
    const { refreshToken } = refreshSchema.parse(req.body);
    const { userId, refreshToken: next_ } = await rotateRefreshToken(refreshToken).catch(() => {
      throw new HttpError(401, "Invalid refresh token");
    });
    const roles = await getUserRoles(userId);
    const user = await getUserPublic(userId);
    const accessToken = signAccessToken({ sub: userId, company_id: user!.company_id, roles });
    res.json({ accessToken, refreshToken: next_ });
  } catch (e) {
    if (e instanceof z.ZodError) return next(new HttpError(400, "Invalid request"));
    next(e);
  }
});

authRoutes.post("/logout", async (req, res, next) => {
  try {
    const { refreshToken } = refreshSchema.parse(req.body);
    await revokeRefreshToken(refreshToken);
    res.status(204).end();
  } catch (e) {
    if (e instanceof z.ZodError) return next(new HttpError(400, "Invalid request"));
    next(e);
  }
});

authRoutes.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await getUserPublic(req.user!.sub);
    if (!user) throw new HttpError(404, "User not found");
    res.json({ user });
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 4: Create `server/src/api/v1/index.ts`**

```ts
import { Router } from "express";
import { authRoutes } from "./auth.routes.js";

export const v1 = Router();
v1.use("/auth", authRoutes);
```

- [ ] **Step 5: Mount the router in `server/src/app.ts`**

Add the import near the top:
```ts
import { v1 } from "./api/v1/index.js";
```
Then, immediately after the existing `app.get("/api/v1/health", ...)` line and BEFORE the `express.static` line, add:
```ts
  app.use("/api/v1", v1);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd server && DB=:memory: npm test -- auth.routes`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add server/src/api/v1/auth.routes.ts server/src/api/v1/index.ts server/src/app.ts server/tests/auth.routes.test.ts
git commit -m "feat(server): add auth routes (login/refresh/logout/me)"
```

---

## Task 8: Seed the demo org from legacy `data.js`

**Files:**
- Create: `server/src/db/seed.ts`
- Test: `server/tests/seed.test.ts`

**Interfaces:**
- Consumes: `db`, `hashPassword`.
- Produces: `seed(): Promise<void>` — idempotent (safe to run repeatedly): inserts roles, one company (`demo-co`), the 10 legacy people as users, their role assignments, and manager relationships. Default password `demo` for every seeded user. Ids equal the legacy `PEOPLE` keys.

- [ ] **Step 1: Write the failing test `server/tests/seed.test.ts`**

```ts
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { db } from "../src/db/knex.js";
import { seed } from "../src/db/seed.js";
import { findByEmail } from "../src/services/user.service.js";
import { verifyPassword } from "../src/services/password.service.js";
import { getUserRoles } from "../src/services/user.service.js";

beforeAll(async () => {
  await db.migrate.latest();
  await seed();
  await seed(); // second run must not duplicate (idempotent)
});
afterAll(async () => db.destroy());

describe("seed", () => {
  it("creates exactly 10 users once (idempotent)", async () => {
    const [{ count }] = await db("users").count<{ count: number }[]>("id as count");
    expect(Number(count)).toBe(10);
  });
  it("seeds the region director with owner+manager roles and password demo", async () => {
    const u = await findByEmail(null, "l1@demo.gwp.vn");
    expect(u?.id).toBe("l1");
    expect(await verifyPassword("demo", u!.password_hash)).toBe(true);
    expect((await getUserRoles("l1")).sort()).toEqual(["admin", "manager", "owner"]);
  });
  it("sets manager relationships from the org tree", async () => {
    const s1 = await db("users").where({ id: "s1" }).first();
    expect(s1.manager_id).toBe("p7");
    const p7 = await db("users").where({ id: "p7" }).first();
    expect(p7.manager_id).toBe("l1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && DB=:memory: npm test -- seed`
Expected: FAIL (module not found).

- [ ] **Step 3: Create `server/src/db/seed.ts`**

```ts
import { db } from "./knex.js";
import { hashPassword } from "../services/password.service.js";
import type { RoleKey } from "../types/index.js";

const COMPANY = { id: "demo-co", name: "GoWise Demo Co." };

const ROLES: { id: string; key: RoleKey; label: string }[] = [
  { id: "r-owner", key: "owner", label: "Owner" },
  { id: "r-admin", key: "admin", label: "Admin" },
  { id: "r-manager", key: "manager", label: "Manager" },
  { id: "r-member", key: "member", label: "Member" },
];

// Mirrors assets/data.js PEOPLE + ORG. Ids MUST equal PEOPLE keys.
const PEOPLE: {
  id: string; name: string; title: string; manager: string | null; roles: RoleKey[];
}[] = [
  { id: "l1", name: "Trần Hải Đăng", title: "Giám đốc vùng HCM", manager: null, roles: ["owner", "admin", "manager"] },
  { id: "p7", name: "Phạm Thu Hà", title: "Trưởng PGD Quận 7", manager: "l1", roles: ["manager"] },
  { id: "thn", name: "Vũ Quốc Bảo", title: "Tổ trưởng Thu hồi nợ sớm", manager: "l1", roles: ["manager"] },
  { id: "td", name: "Hoàng Anh Tuấn", title: "Trưởng nhóm Thẩm định tài sản", manager: "l1", roles: ["manager"] },
  { id: "hr", name: "Mai Khánh Linh", title: "Chuyên viên Tuyển dụng khối vận hành", manager: "l1", roles: ["manager"] },
  { id: "s1", name: "Lê Văn Sơn", title: "Chuyên viên tư vấn — PGD Quận 7", manager: "p7", roles: ["member"] },
  { id: "s2", name: "Đỗ Minh Thư", title: "Chuyên viên tư vấn — PGD Quận 7", manager: "p7", roles: ["member"] },
  { id: "s3", name: "Ngô Thanh Tùng", title: "Phó tổ Thu hồi nợ sớm", manager: "thn", roles: ["member"] },
  { id: "s4", name: "Bùi Hải Yến", title: "Nhân viên thu hồi nợ", manager: "thn", roles: ["member"] },
  { id: "s5", name: "Trịnh Gia Huy", title: "Nhân viên thẩm định", manager: "td", roles: ["member"] },
];

const roleId = (key: RoleKey) => ROLES.find((r) => r.key === key)!.id;

export async function seed(): Promise<void> {
  await db("companies").insert(COMPANY).onConflict("id").ignore();
  await db("roles").insert(ROLES).onConflict("id").ignore();

  const passwordHash = await hashPassword("demo");
  // Insert users without manager_id first (self-referential FK), then set it.
  for (const p of PEOPLE) {
    await db("users").insert({
      id: p.id, company_id: COMPANY.id, name: p.name, title: p.title,
      email: `${p.id}@demo.gwp.vn`, password_hash: passwordHash,
    }).onConflict("id").ignore();
  }
  for (const p of PEOPLE) {
    await db("users").where({ id: p.id }).update({ manager_id: p.manager });
    for (const key of p.roles) {
      await db("user_roles")
        .insert({ user_id: p.id, role_id: roleId(key) })
        .onConflict(["user_id", "role_id"]).ignore();
    }
  }
}

// Allow `npm run seed` to execute this file directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  seed()
    .then(() => { console.log("Seed complete."); return db.destroy(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && DB=:memory: npm test -- seed`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/db/seed.ts server/tests/seed.test.ts
git commit -m "feat(server): seed demo org (10 users, roles, manager tree) from legacy data"
```

---

## Task 9: Frontend session helpers (`assets/auth.js`)

**Files:**
- Create: `assets/auth.js`
- Test: `server/tests/auth.frontend.test.ts` (runs the browser helper under Node with a mock storage)

**Interfaces:**
- Produces (on `window.GWPAuth` / `globalThis.GWPAuth`):
  - `SKEY: string` = `"gwp-demo-tc-session"`
  - `saveSession(store, data): void`
  - `getSession(store): { userId, accessToken, refreshToken, name, role } | null`
  - `clearSession(store): void`
  - `isAuthed(store): boolean`
  - `store` is any object with `getItem/setItem/removeItem` (e.g. `localStorage`).

- [ ] **Step 1: Write the failing test `server/tests/auth.frontend.test.ts`**

```ts
import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

function mockStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

beforeAll(() => {
  // load the browser script into this context
  const code = fs.readFileSync(path.resolve(__dirname, "../../assets/auth.js"), "utf8");
  // eslint-disable-next-line no-eval
  (0, eval)(code);
});

describe("GWPAuth", () => {
  it("saves, reads, detects auth, and clears", () => {
    const A = (globalThis as any).GWPAuth;
    const store = mockStore();
    expect(A.isAuthed(store)).toBe(false);
    A.saveSession(store, { userId: "l1", accessToken: "a", refreshToken: "r", name: "X", role: "Y" });
    expect(A.getSession(store).userId).toBe("l1");
    expect(A.isAuthed(store)).toBe(true);
    A.clearSession(store);
    expect(A.getSession(store)).toBeNull();
    expect(A.isAuthed(store)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm test -- auth.frontend`
Expected: FAIL (file `assets/auth.js` not found).

- [ ] **Step 3: Create `assets/auth.js`**

```js
/* GWP session/token helpers — storage-injectable so they are unit-testable. */
(function (global) {
  "use strict";
  var SKEY = "gwp-demo-tc-session";
  function saveSession(store, data) { store.setItem(SKEY, JSON.stringify(data)); }
  function getSession(store) {
    try { return JSON.parse(store.getItem(SKEY) || "null"); } catch (e) { return null; }
  }
  function clearSession(store) { store.removeItem(SKEY); }
  function isAuthed(store) {
    var s = getSession(store);
    return !!(s && s.accessToken && s.userId);
  }
  global.GWPAuth = { SKEY: SKEY, saveSession: saveSession, getSession: getSession, clearSession: clearSession, isAuthed: isAuthed };
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npm test -- auth.frontend`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add assets/auth.js server/tests/auth.frontend.test.ts
git commit -m "feat(web): add unit-tested GWPAuth session/token helpers"
```

---

## Task 10: Wire the frontend to real login

**Files:**
- Modify: `index.html` (replace role-picker with email/password login calling the API)
- Modify: `assets/app.js` (`session`/`signOut`/`requireSession` use `GWPAuth`; remove `signIn`)
- Modify: `dashboard.html`, `employee.html`, `canvas.html` (load `assets/auth.js` before `assets/app.js`)

**Interfaces:**
- Consumes: `POST /api/v1/auth/login`, `GET /api/v1/auth/me`, `window.GWPAuth`, and the existing `PEOPLE` global from `data.js`.
- Produces: after login, `requireSession()` still returns the `PEOPLE[userId]` object the existing pages expect (so dashboard/employee/canvas logic is unchanged), gated on a valid stored token.

- [ ] **Step 1: Replace the login form + script in `index.html`**

Replace the `<form>` … `</form>` block (the role `<select>`, password input, submit button, and demo note) with:

```html
<form class="loginbox" id="frm" autocomplete="off">
  <img id="logo" alt="GoWise Partners">
  <div class="brand">GoWise Partners</div>
  <h1>Performance Follow-up</h1>
  <p class="sub">Đăng nhập để theo dõi canvas hiệu suất của đội ngũ theo nhịp tuần.</p>

  <label for="email">Email</label>
  <input type="email" id="email" placeholder="ban@congty.vn" required>

  <label for="pw">Mật khẩu</label>
  <input type="password" id="pw" placeholder="Mật khẩu" required>

  <button class="btn" type="submit">Đăng nhập</button>
  <p class="err" id="err" style="color:#b3261e;min-height:1.2em"></p>
  <div class="login-tools">
    <a href="canvas-online/">Canvas Online</a>
    <a href="coaching-report/">Coaching Report</a>
  </div>
  <p class="demo">Bản demo: đăng nhập bằng email dạng <code>l1@demo.gwp.vn</code> (hoặc p7, thn, td, hr, s1–s5), mật khẩu <code>demo</code>.</p>
</form>
```

Then replace the trailing `<script>` block (below the `data.js`/`app.js` includes) with:

```html
<script src="assets/data.js"></script>
<script src="assets/auth.js"></script>
<script src="assets/app.js"></script>
<script>
document.getElementById("logo").src = LOGO;
if (GWPAuth.isAuthed(localStorage)) location.replace("dashboard.html");
document.getElementById("frm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("err");
  err.textContent = "";
  try {
    const r = await fetch(API_BASE + "/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: document.getElementById("email").value.trim(),
        password: document.getElementById("pw").value,
      }),
    });
    if (!r.ok) { err.textContent = "Email hoặc mật khẩu không đúng."; return; }
    const d = await r.json();
    GWPAuth.saveSession(localStorage, {
      userId: d.user.id, accessToken: d.accessToken, refreshToken: d.refreshToken,
      name: d.user.name, role: d.user.title,
    });
    location.href = "dashboard.html";
  } catch (_) { err.textContent = "Không kết nối được máy chủ."; }
});
</script>
```

- [ ] **Step 2: Update `assets/app.js` session functions**

Replace the current session block (the `SKEY` const plus `session`, `signIn`, `signOut`, `requireSession` functions) with:

```js
/* ---------- API base ---------- */
const API_BASE = (location.origin && location.origin.startsWith("http"))
  ? location.origin + "/api/v1" : "/api/v1";

/* ---------- Session (JWT via GWPAuth) ---------- */
function session(){ return GWPAuth.getSession(localStorage); }
function signOut(){ GWPAuth.clearSession(localStorage); location.href="index.html"; }
function requireSession(){
  if(!GWPAuth.isAuthed(localStorage)){ location.replace("index.html"); return null; }
  const s = session();
  const me = PEOPLE[s.userId];
  if(!me){ GWPAuth.clearSession(localStorage); location.replace("index.html"); return null; }
  return me;
}
```

> `signIn` is intentionally removed — login now happens through the API in `index.html`. `TODAY`, `esc`, and all other helpers below the session block stay unchanged.

- [ ] **Step 3: Add the `auth.js` include to the three app pages**

In `dashboard.html`, `employee.html`, and `canvas.html`, add this line immediately **before** the existing `<script src="assets/app.js"></script>` line:

```html
<script src="assets/auth.js"></script>
```

- [ ] **Step 4: Manual verification (real server, seeded DB)**

```bash
cd server
cp .env.example .env    # DEMO_MODE=on, DB=./data/app.db
mkdir -p data
npm run migrate
npm run seed
npm run dev
```
Then in a browser open `http://localhost:8787/`:
- Expected: login form (email + password), no role dropdown.
- Log in with `l1@demo.gwp.vn` / `demo` → redirected to `dashboard.html`, header shows "Trần Hải Đăng", the team tree and "Cần bạn xử lý" render as before.
- Click through to an employee and a canvas → pages still render (they read `PEOPLE`/`CANVAS` from `data.js`).
- Click "Đăng xuất" → back to the login form; revisiting `dashboard.html` directly redirects to login.
- Log in with `s4@demo.gwp.vn` / `demo` → header shows "Bùi Hải Yến".

- [ ] **Step 5: Commit**

```bash
git add index.html assets/app.js dashboard.html employee.html canvas.html
git commit -m "feat(web): replace fake role-picker with real API login (JWT)"
```

---

## Self-Review

**1. Spec coverage (Phase 0 scope from spec §4):**
- Node/TS API + SQLite → Tasks 1–2. ✓
- Serves existing frontend → Task 1 (Step 7). ✓
- Real login replacing role-picker → Tasks 3–7, 9–10. ✓
- Sessions / JWT (+ refresh, CORS, `/api/v1`) → Tasks 1, 4, 6, 7. ✓
- Move `data.js` → DB as seed → Task 8. ✓
- API-first (service layer, thin routes) → Tasks 3–5 (services), 6–7 (thin routes). ✓
- Env config `DEMO_MODE/DB/JWT_SECRET/APP_KEY` → Task 1 (config + .env.example). ✓
- Dual DB via Knex → Task 2 (knexfile branches sqlite/pg). ✓
- Seed ids equal legacy `PEOPLE` keys → Task 8 (asserted in tests) + relied on by Task 10. ✓
- Deferred to later phases (correctly not here): org/department/team CRUD (Phase 1), canvas persistence/editing (Phase 2), AI/BYOK (Phase 3), Docker packaging + demo-seed automation + deploy runbook (Phase 4). `APP_KEY` is loaded now but unused until Phase 3 — intentional.

**2. Placeholder scan:** No "TBD/TODO/implement later"; every code step has real, runnable code. ✓

**3. Type consistency:** `AccessClaims`, `UserPublic`, `UserRow`, `RoleKey`, `TokenPair` defined in Task 2 and used verbatim in Tasks 4–7. Function names consistent across producer/consumer blocks: `signAccessToken`, `verifyAccessToken`, `issueRefreshToken`, `rotateRefreshToken`, `revokeRefreshToken`, `findByEmail`, `getUserPublic`, `getUserRoles`, `requireAuth`, `GWPAuth.*`. `SKEY` value `"gwp-demo-tc-session"` matches the original `assets/app.js`. ✓

**Note on test DB:** service/route/seed tests hit the configured DB. Run them with `DB=:memory:` (as shown in each task's run command) for isolation; `vitest.config.ts` sets `fileParallelism: false` so the shared in-memory DB is safe across sequential files. CI/dev can export `DB=:memory:` once for the whole `npm test` run.
