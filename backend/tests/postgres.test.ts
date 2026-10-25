import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PostgresStore } from "../postgres-store.ts";
import { hashPassword, tokenHash } from "../password.ts";
import { parseBoard, starterBoard } from "../../src/board.ts";
import { postgresOptions } from "../postgres-runtime.ts";

const migration = readFileSync(
  new URL("../migrations/001_postgres.sql", import.meta.url),
  "utf8",
);
const categoryMigration = readFileSync(
  new URL("../migrations/002_board_categories.sql", import.meta.url),
  "utf8",
);
const db = new PGlite();
const store = new PostgresStore((sql, params) => db.query(sql, params));
let passwordHash: string;
const owner = randomUUID();
const other = randomUUID();
beforeAll(async () => {
  await db.exec(migration);
  await db.exec(categoryMigration);
  passwordHash = await hashPassword("synthetic-test-password-only");
}, 20_000);
beforeEach(async () => {
  await db.exec(
    "TRUNCATE sayboard.accounts, sayboard.sessions, sayboard.boards, sayboard.login_limits CASCADE",
  );
  for (const [id, username] of [
    [owner, "caregiver"],
    [other, "second"],
  ])
    await db.query(
      "INSERT INTO sayboard.accounts(id, username, password_hash) VALUES ($1, $2, $3)",
      [id, username, passwordHash],
    );
});
afterAll(async () => {
  await db.close();
});

describe("PostgreSQL schema and store using in-process PostgreSQL", () => {
  it("upgrades schema 1 twice without changing legacy rows or revisions", async () => {
    const upgradeDb = new PGlite();
    const upgradeStore = new PostgresStore((sql, params) =>
      upgradeDb.query(sql, params),
    );
    try {
      await upgradeDb.exec(migration);
      const legacy: unknown = JSON.parse(
        readFileSync(
          new URL(
            "../../tests/fixtures/legacy-custom-board.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      await upgradeDb.query(
        "INSERT INTO sayboard.accounts(id, username, password_hash) VALUES ($1, 'synthetic_upgrade', $2)",
        [owner, passwordHash],
      );
      await upgradeDb.query(
        "INSERT INTO sayboard.boards(account_id, payload, revision) VALUES ($1, $2::jsonb, 7)",
        [owner, JSON.stringify(legacy)],
      );
      await expect(upgradeStore.assertSchema()).rejects.toThrow("Unsupported");
      const before = await upgradeDb.query("SELECT * FROM sayboard.boards");
      const accounts = await upgradeDb.query("SELECT * FROM sayboard.accounts");
      await upgradeDb.exec(categoryMigration);
      await upgradeDb.exec(categoryMigration);
      await upgradeStore.assertSchema();
      expect(
        (await upgradeDb.query("SELECT * FROM sayboard.boards")).rows,
      ).toEqual(before.rows);
      expect(
        (await upgradeDb.query("SELECT * FROM sayboard.accounts")).rows,
      ).toEqual(accounts.rows);
      expect(await upgradeStore.board(owner)).toEqual({
        board: parseBoard(legacy),
        revision: 7,
      });
      expect(await upgradeStore.saveBoard(owner, starterBoard(), 7)).toEqual({
        board: starterBoard(),
        revision: 8,
      });
    } finally {
      await upgradeDb.close();
    }
  });
  it("checks schema version and allows deliberate idempotent application", async () => {
    await store.assertSchema();
    await db.exec(categoryMigration);
    expect((await store.account("caregiver"))?.id).toBe(owner);
    await db.exec("UPDATE sayboard.schema_version SET version = 3");
    await expect(store.assertSchema()).rejects.toThrow("Unsupported");
    await expect(db.exec(categoryMigration)).rejects.toThrow("Unsupported");
    await db.exec("ROLLBACK");
    await db.exec("UPDATE sayboard.schema_version SET version = 2");
  });
  it("reads only real accounts and treats injection strings as values", async () => {
    expect(await store.account("caregiver")).toEqual({
      id: owner,
      username: "caregiver",
      passwordHash,
      localOnly: false,
    });
    expect(await store.account("missing")).toBeNull();
    expect(await store.account("' OR 1=1 --")).toBeNull();
    expect(await store.account("admin")).toBeNull();
  });
  it("schema refuses admin, local-only accounts and unhashed passwords", async () => {
    for (const username of ["admin", "ADMIN"])
      await expect(
        db.query(
          "INSERT INTO sayboard.accounts(id, username, password_hash) VALUES ($1, $2, $3)",
          [randomUUID(), username, passwordHash],
        ),
      ).rejects.toThrow();
    await expect(
      db.query("INSERT INTO sayboard.accounts VALUES ($1, 'local', $2, TRUE)", [
        randomUUID(),
        passwordHash,
      ]),
    ).rejects.toThrow();
    await expect(
      db.query(
        "INSERT INTO sayboard.accounts(id, username, password_hash) VALUES ($1, 'bad', 'plaintext')",
        [randomUUID()],
      ),
    ).rejects.toThrow();
  });
  it("requires numeric version 1 or 2 in stored JSONB", async () => {
    for (const payload of [
      {},
      { version: "1" },
      { version: "2" },
      { version: 3 },
      { version: null },
    ])
      await expect(
        db.query("INSERT INTO sayboard.boards VALUES ($1, $2::jsonb, 1)", [
          owner,
          JSON.stringify(payload),
        ]),
      ).rejects.toThrow();
  });
  it("uses hashed sessions with millisecond expiry and revocation", async () => {
    const hash = tokenHash("synthetic-session-token");
    const expiresAt = 1_900_000_000_000;
    await store.createSession(hash, owner, expiresAt);
    expect(await store.session(hash, expiresAt - 1)).toEqual({
      account: await store.account("caregiver"),
      expiresAt,
    });
    expect(await store.session(hash, expiresAt)).toBeNull();
    expect(await store.session(tokenHash("wrong"), 0)).toBeNull();
    await store.deleteSession(hash);
    expect(await store.session(hash, 0)).toBeNull();
  });
  it("isolates owners and preserves complete boards and revisions", async () => {
    const board = starterBoard();
    expect(await store.board(owner)).toBeNull();
    expect(await store.saveBoard(owner, board, 0)).toEqual({
      board,
      revision: 1,
    });
    expect(await store.board(other)).toBeNull();
    expect(await store.saveBoard(owner, board, 0)).toBeNull();
    expect(await store.saveBoard(other, board, 1)).toBeNull();
    expect(
      await store.saveBoard(owner, { ...board, voice: "demo" }, 1),
    ).toEqual({ board: { ...board, voice: "demo" }, revision: 2 });
    expect(await store.saveBoard(owner, board, 1)).toBeNull();
    expect((await store.board(owner))?.revision).toBe(2);
  });
  it("competing creates and saves have exactly one winner", async () => {
    const board = starterBoard();
    const instances = [
      store,
      new PostgresStore((sql, params) => db.query(sql, params)),
    ];
    const creates = await Promise.all(
      instances.map((adapter) => adapter.saveBoard(owner, board, 0)),
    );
    expect(creates.filter(Boolean)).toHaveLength(1);
    const saves = await Promise.all(
      instances.map((adapter) => adapter.saveBoard(owner, board, 1)),
    );
    expect(saves.filter(Boolean)).toHaveLength(1);
    expect((await store.board(owner))?.revision).toBe(2);
  });
  it("preflights the login budget without charging and respects expiry", async () => {
    for (let i = 0; i < 20; i++)
      expect(await store.loginAvailable("hashed-peer", 1000)).toBe(true);
    for (let i = 0; i < 10; i++)
      expect(await store.allowLogin("hashed-peer", 1000)).toBe(true);
    expect(await store.loginAvailable("hashed-peer", 300_999)).toBe(false);
    expect(await store.loginAvailable("hashed-peer", 301_000)).toBe(true);
    expect(await store.allowLogin("hashed-peer", 301_000)).toBe(true);
  });
  it("shares atomic rate limits across adapters and resets expiry", async () => {
    const second = new PostgresStore((sql, params) => db.query(sql, params));
    const checks = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 ? store : second).allowLogin("hashed-peer", 1000),
      ),
    );
    expect(checks.filter(Boolean)).toHaveLength(10);
    expect(await second.allowLogin("hashed-peer", 300_999)).toBe(false);
    expect(await store.allowLogin("hashed-peer", 301_000)).toBe(true);
    expect(await second.allowLogin("another-peer", 1000)).toBe(true);
    expect(
      (
        await db.query(
          "SELECT count FROM sayboard.login_limits WHERE key = 'hashed-peer'",
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });
  it("enforces foreign keys and cascades account deletion", async () => {
    await expect(
      store.createSession(tokenHash("test"), randomUUID(), 1000),
    ).rejects.toThrow();
    await expect(
      store.saveBoard(randomUUID(), starterBoard(), 0),
    ).rejects.toThrow();
    await store.createSession(tokenHash("test"), owner, 1000);
    await store.saveBoard(owner, starterBoard(), 0);
    await db.query("DELETE FROM sayboard.accounts WHERE id = $1", [owner]);
    expect(await store.session(tokenHash("test"), 0)).toBeNull();
    expect(await store.board(owner)).toBeNull();
  });
  it("manual maintenance removes expired rows and preserves boards and active sessions", async () => {
    const now = Date.now();
    await store.createSession(tokenHash("expired"), owner, now - 1);
    await store.createSession(tokenHash("active"), owner, now + 600_000);
    await store.allowLogin("obsolete-peer", now - 600_000);
    await store.allowLogin("active-peer", now);
    await store.saveBoard(owner, starterBoard(), 0);
    await db.exec(
      readFileSync(
        new URL("../migrations/maintenance.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(
      (await db.query("SELECT token_hash FROM sayboard.sessions")).rows,
    ).toEqual([{ token_hash: tokenHash("active") }]);
    expect(
      (await db.query("SELECT key FROM sayboard.login_limits")).rows,
    ).toEqual([{ key: "active-peer" }]);
    expect((await store.board(owner))?.revision).toBe(1);
    expect(await store.account("caregiver")).not.toBeNull();
  });
  it("propagates failures and rejects malformed rows rather than inventing data", async () => {
    const unavailable = new PostgresStore(async () => {
      throw new Error("database unavailable");
    });
    await expect(unavailable.board(owner)).rejects.toThrow("unavailable");
    const malformed = new PostgresStore(async () => ({
      rows: [{ payload: starterBoard(), revision: "9007199254740992" }],
    }));
    await expect(malformed.board(owner)).rejects.toThrow("integer");
    const wrongVersion = new PostgresStore(async () => ({ rows: [] }));
    await expect(wrongVersion.assertSchema()).rejects.toThrow("Unsupported");
  });
});

const env = {
  NODE_ENV: "production",
  SAYBOARD_STORAGE: "postgres",
  DATABASE_URL:
    "postgresql://synthetic:unused@database.example.test/sayboard?sslmode=require",
};
describe("production connection configuration without external connections", () => {
  it("requires explicit production selection and refuses local development opt-in", () => {
    for (const value of [
      {},
      { ...env, DATABASE_URL: undefined },
      { ...env, NODE_ENV: "development" },
      { ...env, SAYBOARD_STORAGE: undefined },
      { ...env, SAYBOARD_LOCAL_DEV: "1" },
    ])
      expect(() => postgresOptions(value)).toThrow();
  });
  it("forces verified TLS and bounds serverless pool lifetimes", () => {
    const options = postgresOptions(env);
    expect(options.ssl).toEqual({ rejectUnauthorized: true });
    expect(options.connectionString).toBe(
      "postgresql://synthetic:unused@database.example.test/sayboard",
    );
    expect(options.max).toBe(2);
    expect(options.idleTimeoutMillis).toBe(5000);
    expect(options.enableChannelBinding).toBe(true);
    expect(options.statement_timeout).toBe(10_000);
  });
  it("rejects insecure or overriding URL parameters without leaking values", () => {
    for (const url of [
      "not a URL",
      "https://user:password@database.example.test/db",
      "postgresql://database.example.test/db",
      env.DATABASE_URL.replace("sslmode=require", "sslmode=disable"),
      env.DATABASE_URL + "&sslrootcert=/secret",
      env.DATABASE_URL + "&options=unsafe",
      env.DATABASE_URL + "&channel_binding=require",
    ])
      expect(() => postgresOptions({ ...env, DATABASE_URL: url })).toThrow();
  });
});
