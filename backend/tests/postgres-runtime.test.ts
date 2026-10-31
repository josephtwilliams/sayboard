import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Console } from "node:console";
const fake = vi.hoisted(() => {
  const pools: unknown[] = [];
  return {
    pools,
    query:
      vi.fn<
        (
          sql: string,
          params: (string | number)[],
        ) => Promise<{ rows: unknown[] }>
      >(),
    end: vi.fn<() => Promise<void>>(),
    on: vi.fn(),
  };
});
vi.mock("pg", () => ({
  Pool: class {
    query = fake.query;
    end = fake.end;
    on = fake.on;
    constructor(options: unknown) {
      fake.pools.push(options);
    }
  },
}));
import { productionStoreFactory } from "../postgres-runtime.ts";
const env = {
  NODE_ENV: "production",
  SAYBOARD_STORAGE: "postgres",
  DATABASE_URL:
    "postgresql://synthetic:unused@database.example.test/sayboard?sslmode=require",
};
let stderr = "";
beforeEach(() => {
  stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  });
  vi.spyOn(console, "error").mockImplementation(
    new Console(process.stdout, process.stderr).error,
  );
  fake.pools.length = 0;
  fake.query.mockReset().mockResolvedValue({ rows: [{ version: 2 }] });
  fake.end.mockReset().mockResolvedValue();
  fake.on.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});
it("initializes one pool lazily, shares simultaneous requests", async () => {
  const getStore = productionStoreFactory(env);
  expect(fake.pools).toHaveLength(0);
  const first = getStore();
  expect(getStore()).toBe(first);
  const [a, b] = await Promise.all([first, getStore()]);
  expect(a).toBe(b);
  expect(fake.pools).toHaveLength(1);
  expect(fake.on).toHaveBeenCalledWith("error", expect.any(Function));
  expect(fake.query).toHaveBeenCalledExactlyOnceWith(
    "SELECT version FROM sayboard.schema_version WHERE singleton = TRUE",
    [],
  );
  expect(fake.end).not.toHaveBeenCalled();
  fake.query.mockResolvedValueOnce({ rows: [] });
  expect(await a.board("00000000-0000-4000-8000-000000000000")).toBeNull();
  expect(fake.pools).toHaveLength(1);
});
it("closes failed initialization, hides driver details, and allows a later retry", async () => {
  fake.query.mockRejectedValueOnce(
    new Error("synthetic driver connection detail"),
  );
  const getStore = productionStoreFactory(env);
  await expect(getStore()).rejects.toThrow(
    "PostgreSQL storage unavailable or schema not applied",
  );
  expect(fake.end).toHaveBeenCalledOnce();
  await getStore();
  expect(fake.pools).toHaveLength(2);
  expect(stderr).toBe("");
});
it("fails before constructing a pool when configuration is absent", async () => {
  await expect(productionStoreFactory({})()).rejects.toThrow("not configured");
  expect(fake.pools).toHaveLength(0);
  expect(stderr).toBe("");
});
it("fails closed and closes the pool for an unmigrated schema", async () => {
  fake.query.mockResolvedValueOnce({ rows: [{ version: 1 }] });
  await expect(productionStoreFactory(env)()).rejects.toThrow(
    "schema not applied",
  );
  expect(fake.end).toHaveBeenCalledOnce();
  expect(stderr).toBe("");
});
it.each([false, true])(
  "reports idle pool failures without inspecting them or replacing the pool when the log sink throws: %s",
  async (sinkThrows) => {
    const getStore = productionStoreFactory(env);
    const store = await getStore();
    const sink = sinkThrows
      ? vi.spyOn(console, "error").mockImplementation(() => {
          throw new Error("synthetic broken log sink");
        })
      : undefined;
    const failure = Object.defineProperties(new Error(), {
      message: {
        get() {
          throw new Error("synthetic private message");
        },
      },
      stack: {
        get() {
          throw new Error("synthetic private stack");
        },
      },
      toString: {
        value() {
          throw new Error("synthetic private string");
        },
      },
    });
    const callback = fake.on.mock.calls[0][1];
    expect(() => callback(failure)).not.toThrow();
    if (sink)
      expect(sink).toHaveBeenCalledExactlyOnceWith(
        '{"event":"postgres_idle_pool_error"}',
      );
    expect(stderr).toBe(
      sinkThrows ? "" : '{"event":"postgres_idle_pool_error"}\n',
    );
    expect(await getStore()).toBe(store);
    expect(fake.pools).toHaveLength(1);
    expect(fake.end).not.toHaveBeenCalled();
  },
);
