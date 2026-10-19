import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import {
  MODEL_CACHE,
  MODEL_ID,
  MODEL_REVISION,
  VOICE_CACHE,
} from "../src/speech/kokoro-assets";

const { fromPretrained } = vi.hoisted(() => ({ fromPretrained: vi.fn() }));
vi.mock("kokoro-js", () => ({
  KokoroTTS: { from_pretrained: fromPretrained },
}));
vi.mock("@huggingface/transformers", () => ({
  env: { backends: { onnx: { wasm: {} } } },
}));
vi.mock("../src/speech/phonemizer", () => ({
  PHONEMIZER_WASM_URL: "/espeak.wasm",
}));

const asset = (file: string, revision = MODEL_REVISION) =>
  `https://huggingface.co/${MODEL_ID}/resolve/${revision}/${file}`;
const html = () =>
  new Response("<html>Blocked</html>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
class FakeCache {
  entries = new Map<string, Response>();
  async match(url: string) {
    return this.entries.get(url)?.clone();
  }
  async put(url: string, response: Response) {
    this.entries.set(url, response);
  }
  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
  async delete(request: { url: string }) {
    return this.entries.delete(request.url);
  }
}
class FakeStorage {
  stores = new Map<string, FakeCache>();
  async open(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache());
    return this.stores.get(name)!;
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
}

let storage: FakeStorage;
let network: Mock<typeof fetch>;
let posted: { kind: string }[];
// Stands in for KokoroTTS.from_pretrained: it reads config.json like the SDK.
async function readConfig() {
  const response = await fetch(asset("config.json", "main"));
  JSON.parse(await response.text());
  return { generate: async () => ({}) };
}
// Each load runs in a new worker, so the module is imported afresh.
async function load() {
  vi.resetModules();
  posted = [];
  vi.stubGlobal("fetch", network);
  vi.stubGlobal("onmessage", null);
  await import("../src/speech/kokoro.worker");
  const handler = globalThis.onmessage as unknown as (event: {
    data: unknown;
  }) => Promise<void>;
  await handler({ data: { kind: "load" } });
  return posted.at(-1)?.kind;
}
beforeEach(() => {
  storage = new FakeStorage();
  network = vi.fn<typeof fetch>(
    async () => new Response(new Uint8Array([1, 2, 3])),
  );
  fromPretrained.mockReset().mockImplementation(readConfig);
  vi.stubGlobal("caches", storage);
  vi.stubGlobal("location", { href: "http://localhost/" });
  vi.stubGlobal("self", {
    postMessage: (message: { kind: string }) => posted.push(message),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("clears a corrupt cached file after a failed load so the next load downloads it again", async () => {
  (await storage.open(MODEL_CACHE)).entries.set(asset("config.json"), html());
  await storage.open(VOICE_CACHE);
  expect(await load()).toBe("error");
  expect(await storage.keys()).toEqual([]);
  network.mockImplementation(async () => new Response("{}"));
  expect(await load()).toBe("ready");
  expect(network).toHaveBeenCalledWith(
    asset("config.json"),
    expect.any(Object),
  );
});

it("keeps complete cached files when the connection drops", async () => {
  const model = (await storage.open(MODEL_CACHE)).entries;
  model.set(asset("onnx/model_quantized.onnx"), new Response("model"));
  network.mockRejectedValue(new TypeError("Failed to fetch"));
  expect(await load()).toBe("error");
  expect(model.has(asset("onnx/model_quantized.onnx"))).toBe(true);
  expect(await storage.keys()).toContain(MODEL_CACHE);
});

it("never caches a filter or captive portal page", async () => {
  network.mockImplementation(async () => html());
  expect(await load()).toBe("error");
  expect((await storage.open(MODEL_CACHE)).entries.size).toBe(0);
});
