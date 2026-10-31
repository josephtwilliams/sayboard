import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostedCapabilitiesHandler } from "../capabilities.ts";
import { createHostedHandler } from "../hosted.ts";

const runtime = {
  NODE_ENV: "production",
};
const configured = {
  ...runtime,
  SAYBOARD_AUTH_ENABLED: "1",
  SAYBOARD_STORAGE: "postgres",
  SAYBOARD_ORIGIN: "https://sayboard.example.test",
  DATABASE_URL: "postgresql://synthetic:unused@db.example.test/synthetic",
};
const request = () =>
  new Request("https://sayboard.example.test/api/auth/capabilities");
afterEach(() => {
  vi.restoreAllMocks();
});

describe("hosted account configuration discovery", () => {
  it.each([undefined, "", "0"])(
    "reports disabled only when the auth opt-in is absent or disabled: %s",
    async (flag) => {
      const response = await createHostedCapabilitiesHandler({
        ...runtime,
        SAYBOARD_AUTH_ENABLED: flag,
      })(request());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ state: "disabled" });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toBeNull();
    },
  );

  it.each([
    { ...configured, DATABASE_URL: "" },
    { ...configured, SAYBOARD_STORAGE: "sqlite", SAYBOARD_DATABASE_PATH: "relative-path" },
    { ...configured, SAYBOARD_ORIGIN: "http://localhost" },
    { ...configured, SAYBOARD_AUTH_ENABLED: "true" },
    { ...runtime, NODE_ENV: "development" },
    { ...runtime, SAYBOARD_LOCAL_DEV: "1" },
  ])("keeps unexpected configuration failures observable: %#", async (env) => {
    const response = await createHostedCapabilitiesHandler(env)(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "auth_unconfigured" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("reports configuration independently from runtime storage failures", async () => {
    const sink = vi.spyOn(console, "error").mockImplementation(() => {});
    const capabilities = createHostedCapabilitiesHandler(configured);
    const getStore = vi.fn(async () => {
      throw new Error("Synthetic storage outage");
    });
    const accounts = createHostedHandler(configured, getStore);
    expect(await (await capabilities(request())).json()).toEqual({
      state: "enabled",
    });
    expect(getStore).not.toHaveBeenCalled();
    const response = await accounts(
      new Request("https://sayboard.example.test/api/auth/session", {
        headers: {},
      }),
      "203.0.113.10",
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "storage_unavailable" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(getStore).toHaveBeenCalledOnce();
    expect(await (await capabilities(request())).json()).toEqual({
      state: "enabled",
    });
    expect(sink).toHaveBeenCalledExactlyOnceWith(
      '{"event":"hosted_handler_failed"}',
    );
  });

  it("accepts only read-only GET requests", async () => {
    const response = await createHostedCapabilitiesHandler(runtime)(
      new Request(request().url, { method: "POST" }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
