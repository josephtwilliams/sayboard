import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import wasmUrl from "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url";
import mjsUrl from "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url";
import {
  MODEL_CACHE,
  MODEL_ID,
  MODEL_REVISION,
  VOICE_CACHE,
} from "../src/speech/kokoro-assets";

const { fromPretrained, loadRuntimeModule } = vi.hoisted(() => ({
  fromPretrained: vi.fn(),
  loadRuntimeModule: vi.fn(),
}));
vi.mock("../src/speech/kokoro-runtime", () => ({ loadRuntimeModule }));
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
  loadRuntimeModule.mockReset().mockResolvedValue(undefined);
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

const validWasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const brokenBodies = [
  [
    "interrupted stream",
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError("Connection lost"));
          },
        }),
      ),
  ],
  ["HTML error page", html],
  [
    "mislabelled HTML",
    () =>
      new Response("<!doctype html><html>Blocked</html>", {
        headers: { "content-type": "application/wasm" },
      }),
  ],
  [
    "truncated binary",
    () =>
      new Response(new Uint8Array([...validWasm, 1, 4, 1]), {
        headers: { "content-type": "application/wasm" },
      }),
  ],
] as const;

for (const runtime of ["/espeak.wasm", wasmUrl]) {
  it.each(brokenBodies)(
    `keeps good caches after ${runtime} returns a 200 %s and retries without downloading the model`,
    async (_name, broken) => {
      const model = await storage.open(MODEL_CACHE);
      model.entries.set(asset("config.json"), new Response("{}"));
      model.entries.set(
        asset("onnx/model_quantized.onnx"),
        new Response("model"),
      );
      model.entries.set(asset("voices/af_heart.bin"), new Response("voice"));
      const voices = await storage.open(VOICE_CACHE);
      fromPretrained.mockImplementation(async () => {
        await readConfig();
        await (
          await fetch(asset("onnx/model_quantized.onnx", "main"))
        ).arrayBuffer();
        await WebAssembly.compile(await (await fetch(runtime)).arrayBuffer());
        return { generate: async () => ({}) };
      });
      network.mockImplementation(async () => broken());
      expect(await load()).toBe("error");
      expect(storage.stores.get(MODEL_CACHE)).toBe(model);
      expect(storage.stores.get(VOICE_CACHE)).toBe(voices);
      network.mockImplementation(async () => new Response(validWasm));
      expect(await load()).toBe("ready");
      expect(network).toHaveBeenCalledTimes(2);
      expect(network.mock.calls.every(([url]) => url === runtime)).toBe(true);
    },
  );
}

it.each(brokenBodies.slice(0, 3))(
  "keeps good caches after a runtime module returns a 200 %s",
  async (_name, broken) => {
    const model = await storage.open(MODEL_CACHE);
    model.entries.set(asset("config.json"), new Response("{}"));
    model.entries.set(asset("voices/af_heart.bin"), new Response("voice"));
    const voices = await storage.open(VOICE_CACHE);
    fromPretrained.mockImplementation(async () => {
      await readConfig();
      const source = await (await fetch(mjsUrl)).text();
      if (source !== "export {};") throw new SyntaxError("Invalid module");
      return { generate: async () => ({}) };
    });
    network.mockImplementation(async () => broken());
    expect(await load()).toBe("error");
    expect(storage.stores.get(MODEL_CACHE)).toBe(model);
    expect(storage.stores.get(VOICE_CACHE)).toBe(voices);
    network.mockImplementation(async () => new Response("export {};"));
    expect(await load()).toBe("ready");
    expect(network).toHaveBeenCalledTimes(2);
  },
);

it.each([
  ["HTML", new SyntaxError("Unexpected token '<'")],
  ["truncated JavaScript", new SyntaxError("Unexpected end of input")],
  [
    "failed module request",
    new TypeError("Failed to fetch dynamically imported module"),
  ],
])(
  "keeps model caches when the native runtime import receives %s",
  async (_name, failure) => {
    const model = await storage.open(MODEL_CACHE);
    model.entries.set(asset("config.json"), new Response("{}"));
    model.entries.set(
      asset("onnx/model_quantized.onnx"),
      new Response("model"),
    );
    model.entries.set(asset("voices/af_heart.bin"), new Response("voice"));
    const voices = await storage.open(VOICE_CACHE);
    loadRuntimeModule.mockRejectedValueOnce(failure);
    expect(await load()).toBe("error");
    expect(loadRuntimeModule).toHaveBeenCalledWith(mjsUrl);
    expect(fromPretrained).not.toHaveBeenCalled();
    expect(storage.stores.get(MODEL_CACHE)).toBe(model);
    expect(storage.stores.get(VOICE_CACHE)).toBe(voices);
    expect(await load()).toBe("ready");
    expect(network).not.toHaveBeenCalled();
  },
);
