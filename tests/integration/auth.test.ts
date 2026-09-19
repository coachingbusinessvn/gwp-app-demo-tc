import { describe, expect, it } from "vitest";
import jwt, { type JwtPayload } from "jsonwebtoken";
import request from "supertest";
import { loadConfig } from "../../server/src/config.js";
import { createAuthService } from "../../server/src/modules/auth/service.js";
import {
  FIXTURE_PASSWORD,
  fixture,
  personaEmail,
  testEnv,
  type Fixture,
} from "../helpers/fixture.js";

const config = loadConfig(testEnv);
const ORIGIN = testEnv.APP_ORIGIN as string;

type TestResponse = {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, unknown>;
};

function setCookies(res: TestResponse): string[] {
  const raw = res.headers["set-cookie"];
  return Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
}

/** Extract a cookie's value from a response's Set-Cookie list. */
function cookieValue(res: TestResponse, name: string): string | undefined {
  for (const line of setCookies(res)) {
    const pair = line.split(";", 1)[0];
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq).trim() === name)
      return pair.slice(eq + 1).trim();
  }
  return undefined;
}

function cookieLine(res: TestResponse, name: string): string | undefined {
  return setCookies(res).find((line) => line.startsWith(`${name}=`));
}

/**
 * The auth_session row this access token belongs to — seeded fixtures already
 * hold one session per persona from their fixture login, so tests must look
 * up by sid, never by user_id.
 */
async function sessionOf(f: Fixture, accessToken: string) {
  const sid = (jwt.decode(accessToken) as JwtPayload).sid as string;
  return f.db("auth_session").where({ id: sid }).first();
}

async function login(
  f: Fixture,
  email: string,
  password: string,
): Promise<TestResponse> {
  return request(f.app)
    .post("/api/v1/auth/login")
    .set("Origin", ORIGIN)
    .send({ email, password }) as unknown as Promise<TestResponse>;
}

/**
 * A well-formed refresh request; pass overrides/omissions to break pieces.
 * The double-submit check needs BOTH the gwp_csrf cookie and the matching
 * X-CSRF-Token header — csrfCookie/csrfHeader are set independently so tests
 * can exercise a mismatch.
 */
function refreshReq(
  f: Fixture,
  opts: {
    refresh?: string;
    csrfCookie?: string;
    csrfHeader?: string;
    origin?: string | null;
  },
) {
  let t = request(f.app).post("/api/v1/auth/refresh");
  const cookies: string[] = [];
  if (opts.refresh !== undefined)
    cookies.push(`${config.refreshCookieName}=${opts.refresh}`);
  if (opts.csrfCookie !== undefined)
    cookies.push(`${config.csrfCookieName}=${opts.csrfCookie}`);
  if (cookies.length > 0) t = t.set("Cookie", cookies.join("; "));
  if (opts.origin !== null) t = t.set("Origin", opts.origin ?? ORIGIN);
  if (opts.csrfHeader !== undefined)
    t = t.set("X-CSRF-Token", opts.csrfHeader);
  return t;
}

describe("POST /api/v1/auth/login", () => {
  it("logs a seeded persona in: accessToken+user in JSON, refresh token only via cookie", async () => {
    const f = await fixture({ seeded: true });
    try {
      const logged = await request(f.app)
        .post("/api/v1/auth/login")
        .set("Origin", "https://gwp.test")
        .send({ email: "member@example.test", password: "fixture-password" });
      expect(logged.status).toBe(200);
      expect(logged.body.refreshToken).toBeUndefined();
      expect(
        (logged.headers["set-cookie"] as unknown as string[]).join(";"),
      ).toContain("HttpOnly");

      expect(typeof logged.body.accessToken).toBe("string");
      expect(logged.body.user).toMatchObject({
        id: f.ids.member,
        email: "member@example.test",
      });
      expect(typeof (logged.body.user as { name: string }).name).toBe(
        "string",
      );

      // Refresh cookie: HttpOnly + Secure + SameSite=Strict + scoped path +
      // 7-day Max-Age.
      const refresh = cookieLine(logged, config.refreshCookieName);
      expect(refresh).toBeDefined();
      expect(refresh).toContain("HttpOnly");
      expect(refresh).toContain("Secure");
      expect(refresh).toContain("SameSite=Strict");
      expect(refresh).toContain("Path=/api/v1/auth");
      expect(refresh).toContain(`Max-Age=${config.refreshTokenTtlSeconds}`);
      expect(cookieValue(logged, config.refreshCookieName)).toBeTruthy();

      // CSRF cookie: readable by JS (no HttpOnly), still Strict+Secure.
      const csrf = cookieLine(logged, config.csrfCookieName);
      expect(csrf).toBeDefined();
      expect(csrf).not.toContain("HttpOnly");
      expect(csrf).toContain("Secure");
      expect(csrf).toContain("SameSite=Strict");
      expect(csrf).toContain("Path=/api/v1/auth");
      expect(cookieValue(logged, config.csrfCookieName)).toBeTruthy();
    } finally {
      await f.close();
    }
  });

  it("returns an identical 401 for unknown email vs wrong password", async () => {
    const f = await fixture({ seeded: true });
    try {
      const badUser = await login(f, "nobody@example.test", "fixture-password");
      const badPass = await login(f, personaEmail("member"), "wrong-password");
      expect(badUser.status).toBe(401);
      expect(badPass.status).toBe(401);
      expect(badUser.body.code).toBe("INVALID_CREDENTIALS");
      // Same code + message: the response must not reveal which part failed.
      expect(badUser.body.code).toBe(badPass.body.code);
      expect(badUser.body.message).toBe(badPass.body.message);
      // No cookies are set on a failed login.
      expect(setCookies(badUser)).toHaveLength(0);
      expect(setCookies(badPass)).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

  it("mints a 10-minute HS256 access JWT with iss/aud/sub/sid/jti and no role claims", async () => {
    const f = await fixture({ seeded: true });
    try {
      const logged = await login(f, personaEmail("member"), FIXTURE_PASSWORD);
      expect(logged.status).toBe(200);
      const accessToken = logged.body.accessToken as string;

      const decoded = jwt.decode(accessToken) as JwtPayload & {
        sid?: string;
        roles?: unknown;
        role?: unknown;
      };
      expect(decoded.iss).toBe("gwp");
      expect(decoded.aud).toBe("gwp-web");
      expect(decoded.sub).toBe(f.ids.member);
      expect(typeof decoded.sid).toBe("string");
      expect(typeof decoded.jti).toBe("string");
      expect(decoded.exp! - decoded.iat!).toBe(config.accessTokenTtlSeconds);
      expect(config.accessTokenTtlSeconds).toBe(600);
      // Roles never ride in the JWT — they are checked from the DB per
      // request (spec §4/§8).
      expect(decoded.roles).toBeUndefined();
      expect(decoded.role).toBeUndefined();

      // Signature really verifies against the configured secret.
      const verified = jwt.verify(accessToken, config.jwtSecret, {
        algorithms: ["HS256"],
        issuer: "gwp",
        audience: "gwp-web",
      }) as JwtPayload;
      expect(verified.sid).toBe(decoded.sid);

      // The session row the JWT points at exists and is not revoked.
      const session = await f
        .db("auth_session")
        .where({ id: decoded.sid })
        .first();
      expect(session).toMatchObject({
        user_id: f.ids.member,
        company_id: f.ids.company,
        revoked_at: null,
      });
    } finally {
      await f.close();
    }
  });

  it("audits login success and failure without secrets or email payloads", async () => {
    const f = await fixture({ seeded: true });
    try {
      const ok = await login(f, personaEmail("member"), FIXTURE_PASSWORD);
      const bad = await login(f, personaEmail("member"), "wrong-password");
      expect(ok.status).toBe(200);
      expect(bad.status).toBe(401);

      // Correlate by request_id — the fixture's own persona logins also
      // write auth.login rows.
      const success = await f
        .db("audit_event")
        .where({
          action: "auth.login",
          request_id: ok.headers["x-request-id"],
        })
        .first();
      const failure = await f
        .db("audit_event")
        .where({
          action: "auth.login",
          request_id: bad.headers["x-request-id"],
        })
        .first();
      expect(success).toMatchObject({
        outcome: "success",
        target_id: f.ids.member,
      });
      expect(failure).toMatchObject({
        outcome: "failure",
        target_id: f.ids.member,
      });
      // Never audit the password or the submitted email.
      const serialized = JSON.stringify([success, failure]);
      expect(serialized).not.toContain(FIXTURE_PASSWORD);
      expect(serialized).not.toContain("wrong-password");
      expect(serialized).not.toContain("member@example.test");
    } finally {
      await f.close();
    }
  });

  it("rate-limits login by account+IP: 5 bad attempts then 429", async () => {
    const f = await fixture({ seeded: true });
    try {
      for (let i = 0; i < 5; i++) {
        const res = await login(f, "ratelimit@example.test", "bad-password");
        expect(res.status).toBe(401);
      }
      const limited = await login(f, "ratelimit@example.test", "bad-password");
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe("RATE_LIMITED");
      expect(limited.headers["retry-after"]).toBeDefined();
    } finally {
      await f.close();
    }
  });
});

describe("POST /api/v1/auth/refresh", () => {
  it("rotates the refresh token; reusing the old one revokes the session family", async () => {
    const f = await fixture({ seeded: true });
    try {
      const logged = await login(f, personaEmail("member"), FIXTURE_PASSWORD);
      const rawRefresh = cookieValue(logged, config.refreshCookieName)!;
      const csrf = cookieValue(logged, config.csrfCookieName)!;
      const firstAccess = logged.body.accessToken as string;

      const rotated = (await refreshReq(f, {
        refresh: rawRefresh,
        csrfCookie: csrf,
        csrfHeader: csrf,
      })) as unknown as TestResponse;
      expect(rotated.status).toBe(200);
      expect(typeof rotated.body.accessToken).toBe("string");
      const newRawRefresh = cookieValue(rotated, config.refreshCookieName);
      expect(newRawRefresh).toBeTruthy();
      expect(newRawRefresh).not.toBe(rawRefresh);

      // The old access token still works — rotation alone does not revoke.
      const meBefore = await request(f.app)
        .get("/api/v1/auth/me")
        .auth(rotated.body.accessToken as string, { type: "bearer" });
      expect(meBefore.status).toBe(200);

      // Reusing the consumed refresh token: 401 + the whole family is
      // revoked (the revocation is committed, not rolled back).
      const reused = (await refreshReq(f, {
        refresh: rawRefresh,
        csrfCookie: csrf,
        csrfHeader: csrf,
      })) as unknown as TestResponse;
      expect(reused.status).toBe(401);
      expect(reused.body.code).toBe("INVALID_SESSION");

      const session = await sessionOf(f, firstAccess);
      expect(session.revoked_at).not.toBeNull();

      // Both access tokens die with the session.
      expect(
        (
          await request(f.app)
            .get("/api/v1/auth/me")
            .auth(firstAccess, { type: "bearer" })
        ).status,
      ).toBe(401);
      expect(
        (
          await request(f.app)
            .get("/api/v1/auth/me")
            .auth(rotated.body.accessToken as string, { type: "bearer" })
        ).status,
      ).toBe(401);
      // And the rotated refresh token is dead too.
      expect(
        (
          (await refreshReq(f, {
            refresh: newRawRefresh!,
            csrfCookie: csrf,
            csrfHeader: csrf,
          })) as unknown as TestResponse
        ).status,
      ).toBe(401);

      const audits = await f
        .db("audit_event")
        .where({ action: "auth.refresh" })
        .select("outcome", "safe_metadata");
      expect(
        audits.some(
          (a: { outcome: string; safe_metadata: { reason?: string } }) =>
            a.outcome === "failure" &&
            a.safe_metadata?.reason === "reused_refresh_token",
        ),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });

  it("concurrent rotation of the same token has exactly one winner", async () => {
    const f = await fixture({ seeded: true });
    try {
      const logged = await login(f, personaEmail("member"), FIXTURE_PASSWORD);
      const rawRefresh = cookieValue(logged, config.refreshCookieName)!;
      const csrf = cookieValue(logged, config.csrfCookieName)!;

      const [a, b] = (await Promise.all([
        refreshReq(f, { refresh: rawRefresh, csrfCookie: csrf, csrfHeader: csrf }),
        refreshReq(f, { refresh: rawRefresh, csrfCookie: csrf, csrfHeader: csrf }),
      ])) as unknown as TestResponse[];
      expect([a.status, b.status].sort()).toEqual([200, 401]);

      // The loser is treated as reuse: the session family is revoked.
      const session = await sessionOf(f, logged.body.accessToken as string);
      expect(session.revoked_at).not.toBeNull();
    } finally {
      await f.close();
    }
  });

  it("rejects refresh without a cookie, with a bad Origin, or without/without-matching CSRF", async () => {
    const f = await fixture({ seeded: true });
    try {
      const logged = await login(f, personaEmail("member"), FIXTURE_PASSWORD);
      const rawRefresh = cookieValue(logged, config.refreshCookieName)!;
      const csrf = cookieValue(logged, config.csrfCookieName)!;

      // Missing refresh cookie → 401 (Origin + CSRF pair still valid).
      expect(
        (
          (await refreshReq(f, {
            csrfCookie: csrf,
            csrfHeader: csrf,
          })) as unknown as TestResponse
        ).status,
      ).toBe(401);

      // Origin must equal config.appOrigin.
      for (const origin of [null, "https://evil.test"]) {
        const res = (await refreshReq(f, {
          refresh: rawRefresh,
          csrfCookie: csrf,
          csrfHeader: csrf,
          origin,
        })) as unknown as TestResponse;
        expect(res.status, `origin=${origin}`).toBe(403);
      }

      // X-CSRF-Token header must match the gwp_csrf cookie — missing header
      // and mismatched header both fail with 403.
      for (const header of [undefined, "not-the-token"]) {
        const res = (await refreshReq(f, {
          refresh: rawRefresh,
          csrfCookie: csrf,
          csrfHeader: header,
        })) as unknown as TestResponse;
        expect(res.status, `csrfHeader=${header}`).toBe(403);
      }

      // The original token is still unconsumed — nothing above rotated it.
      const ok = (await refreshReq(f, {
        refresh: rawRefresh,
        csrfCookie: csrf,
        csrfHeader: csrf,
      })) as unknown as TestResponse;
      expect(ok.status).toBe(200);
    } finally {
      await f.close();
    }
  });
});

describe("POST /api/v1/auth/logout", () => {
  it("revokes the session and clears both cookies", async () => {
    const f = await fixture({ seeded: true });
    try {
      const logged = await login(f, personaEmail("member"), FIXTURE_PASSWORD);
      const rawRefresh = cookieValue(logged, config.refreshCookieName)!;
      const csrf = cookieValue(logged, config.csrfCookieName)!;
      const accessToken = logged.body.accessToken as string;

      const out = (await request(f.app)
        .post("/api/v1/auth/logout")
        .set("Origin", ORIGIN)
        .set("X-CSRF-Token", csrf)
        .set(
          "Cookie",
          `${config.refreshCookieName}=${rawRefresh}; ${config.csrfCookieName}=${csrf}`,
        )) as unknown as TestResponse;
      expect(out.status).toBe(204);

      // Both cookies cleared.
      const cleared = cookieLine(out, config.refreshCookieName);
      expect(cleared).toBeDefined();
      expect(cleared).toContain("Expires=Thu, 01 Jan 1970");
      expect(cookieLine(out, config.csrfCookieName)).toBeDefined();

      // Access token and refresh token are both dead.
      expect(
        (
          await request(f.app)
            .get("/api/v1/auth/me")
            .auth(accessToken, { type: "bearer" })
        ).status,
      ).toBe(401);
      expect(
        (
          (await refreshReq(f, {
            refresh: rawRefresh,
            csrfCookie: csrf,
            csrfHeader: csrf,
          })) as unknown as TestResponse
        ).status,
      ).toBe(401);

      const session = await sessionOf(f, accessToken);
      expect(session.revoked_at).not.toBeNull();

      const logoutAudit = await f
        .db("audit_event")
        .where({ action: "auth.logout" })
        .first();
      expect(logoutAudit).toMatchObject({ outcome: "success" });
    } finally {
      await f.close();
    }
  });

  it("requires Origin and CSRF like refresh", async () => {
    const f = await fixture({ seeded: true });
    try {
      const logged = await login(f, personaEmail("member"), FIXTURE_PASSWORD);
      const rawRefresh = cookieValue(logged, config.refreshCookieName)!;
      const csrf = cookieValue(logged, config.csrfCookieName)!;
      const cookieHeader = `${config.refreshCookieName}=${rawRefresh}; ${config.csrfCookieName}=${csrf}`;

      const noCsrf = (await request(f.app)
        .post("/api/v1/auth/logout")
        .set("Origin", ORIGIN)
        .set("Cookie", cookieHeader)) as unknown as TestResponse;
      expect(noCsrf.status).toBe(403);
      const badOrigin = (await request(f.app)
        .post("/api/v1/auth/logout")
        .set("Origin", "https://evil.test")
        .set("X-CSRF-Token", csrf)
        .set("Cookie", cookieHeader)) as unknown as TestResponse;
      expect(badOrigin.status).toBe(403);
    } finally {
      await f.close();
    }
  });
});

describe("GET /api/v1/auth/me", () => {
  it("returns the profile and roles loaded fresh from the DB for each persona", async () => {
    const f = await fixture({ seeded: true });
    try {
      const member = (await f
        .api("member")
        .get("/api/v1/auth/me")) as unknown as TestResponse;
      expect(member.status).toBe(200);
      expect(member.body.user).toMatchObject({
        id: f.ids.member,
        email: personaEmail("member"),
      });
      expect(member.body.roles).toEqual(["member"]);

      const owner = (await f
        .api("owner")
        .get("/api/v1/auth/me")) as unknown as TestResponse;
      expect(owner.status).toBe(200);
      expect(owner.body.user).toMatchObject({ id: f.ids.owner });
      expect(owner.body.roles).toEqual(["owner"]);

      const outsider = (await f
        .api("outsider")
        .get("/api/v1/auth/me")) as unknown as TestResponse;
      expect(outsider.status).toBe(200);
      expect(outsider.body.roles).toEqual(["member"]);

      // Anonymous and garbage tokens → 401.
      expect(
        ((await f.api().get("/api/v1/auth/me")) as unknown as TestResponse)
          .status,
      ).toBe(401);
      expect(
        (
          (await request(f.app)
            .get("/api/v1/auth/me")
            .auth("not-a-jwt", { type: "bearer" })) as unknown as TestResponse
        ).status,
      ).toBe(401);
    } finally {
      await f.close();
    }
  });

  it("deactivating the user in the DB kills the old access token and the refresh token", async () => {
    const f = await fixture({ seeded: true });
    try {
      const logged = await request(f.app)
        .post("/api/v1/auth/login")
        .set("Origin", "https://gwp.test")
        .send({
          email: "member@example.test",
          password: "fixture-password",
        });
      expect(logged.body.refreshToken).toBeUndefined();
      expect(
        (logged.headers["set-cookie"] as unknown as string[]).join(";"),
      ).toContain("HttpOnly");
      const rawRefresh = cookieValue(logged, config.refreshCookieName)!;
      const csrf = cookieValue(logged, config.csrfCookieName)!;

      await f
        .db("app_user")
        .where({ id: f.ids.member })
        .update({ status: "inactive" });
      expect(
        (
          await request(f.app)
            .get("/api/v1/auth/me")
            .auth(logged.body.accessToken, { type: "bearer" })
        ).status,
      ).toBe(401);
      expect(
        (
          (await refreshReq(f, {
            refresh: rawRefresh,
            csrfCookie: csrf,
            csrfHeader: csrf,
          })) as unknown as TestResponse
        ).status,
      ).toBe(401);
    } finally {
      await f.close();
    }
  });
});

describe("revokeAllUserSessions (permanent revoke — spec §8)", () => {
  it("kills every session durably: tokens stay 401 through a deactivate→reactivate cycle", async () => {
    const f = await fixture({ seeded: true });
    try {
      const logged = await login(f, personaEmail("member"), FIXTURE_PASSWORD);
      const rawRefresh = cookieValue(logged, config.refreshCookieName)!;
      const csrf = cookieValue(logged, config.csrfCookieName)!;
      const accessToken = logged.body.accessToken as string;

      // Sanity: the session works before revocation.
      expect(
        (
          await request(f.app)
            .get("/api/v1/auth/me")
            .auth(accessToken, { type: "bearer" })
        ).status,
      ).toBe(200);

      const auth = createAuthService({
        db: f.db,
        clock: () => new Date(),
        config,
      });
      // member holds 2 sessions: the fixture's persona login + this one.
      const revoked = await auth.revokeAllUserSessions(
        f.ids.member,
        "test-revoke-request",
        "deactivated",
      );
      expect(revoked).toBe(2);

      // Revocation is written, not status-derived: the user stays active and
      // a deactivate→reactivate cycle does not bring tokens back.
      await f
        .db("app_user")
        .where({ id: f.ids.member })
        .update({ status: "inactive" });
      await f
        .db("app_user")
        .where({ id: f.ids.member })
        .update({ status: "active" });
      const user = await f
        .db("app_user")
        .where({ id: f.ids.member })
        .first();
      expect(user.status).toBe("active");

      // This session's access token → 401.
      expect(
        (
          await request(f.app)
            .get("/api/v1/auth/me")
            .auth(accessToken, { type: "bearer" })
        ).status,
      ).toBe(401);
      // Its refresh token → 401 (session revoked, not just token consumed).
      expect(
        (
          (await refreshReq(f, {
            refresh: rawRefresh,
            csrfCookie: csrf,
            csrfHeader: csrf,
          })) as unknown as TestResponse
        ).status,
      ).toBe(401);
      // The OTHER member session (fixture login) is revoked too — bulk, not
      // per-session.
      expect(
        ((await f
          .api("member")
          .get("/api/v1/auth/me")) as unknown as TestResponse).status,
      ).toBe(401);

      // One auth.session_revoked audit row per revoked session.
      const session = await sessionOf(f, accessToken);
      expect(session.revoked_at).not.toBeNull();
      const audits = await f
        .db("audit_event")
        .where({ action: "auth.session_revoked" })
        .select("target_id", "outcome", "safe_metadata");
      expect(audits).toHaveLength(2);
      for (const row of audits) {
        expect(row.outcome).toBe("success");
        expect(row.safe_metadata).toMatchObject({ reason: "deactivated" });
      }
      expect(
        audits.map((a: { target_id: string }) => a.target_id),
      ).toContain(session.id);
    } finally {
      await f.close();
    }
  });
});
