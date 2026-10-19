/// <reference lib="webworker" />
import { PHONEMIZER_WASM_URL } from './phonemizer';
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';
import mjsUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url';
import { MODEL_ID, MODEL_REVISION, MODEL_CACHE, VOICE_CACHE, MAX_MODEL_BYTES, MODEL_FILES, pinnedAsset } from './kokoro-assets';

declare const self: DedicatedWorkerGlobalScope;
const send = (message: unknown, transfer: Transferable[] = []) => self.postMessage(message, transfer);
const networkFetch = globalThis.fetch.bind(globalThis);
const storage = globalThis.caches;
const openCache = storage?.open.bind(storage);
// The SDK's voice cache uses an unversioned name. Isolate this fixed voice/version.
if (storage && openCache) storage.open = name => openCache(name === 'kokoro-voices' ? VOICE_CACHE : name);
let cache: Cache | null = null;
let model: KokoroTTS | null = null;
let downloading = true;
let downloadedBytes = 0;
let lastProgress = 0;
const seen = new Set<string>();
let downloadFailed = false;

env.allowLocalModels = false;
env.useBrowserCache = false;
env.useFSCache = false;
const wasm = env.backends.onnx.wasm;
if (!wasm) throw new Error('WASM runtime unavailable');
wasm.numThreads = 1;
wasm.proxy = false;
wasm.wasmPaths = { wasm: wasmUrl, mjs: mjsUrl };
env.remotePathTemplate = `{model}/resolve/${MODEL_REVISION}/`;

const assetFetch: typeof fetch = async (input, init) => {
  const requested = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = pinnedAsset(requested);
  if (!url) {
    if (new URL(requested, location.href).href === new URL(PHONEMIZER_WASM_URL, location.href).href || new URL(requested, location.href).href === new URL(wasmUrl, location.href).href || new URL(requested, location.href).href === new URL(mjsUrl, location.href).href) return networkFetch(input, init);
    throw new Error('Unexpected speech asset request blocked');
  }
  const stored = await cache?.match(url);
  if (stored) return stored;
  if (!downloading) throw new Error('Speech assets unavailable offline');
  const response = await networkFetch(url, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' });
  // A web filter or captive portal page is never a model file, so it is not cached.
  if (!response.ok || !response.body || /^text\/html/i.test(response.headers.get('content-type') ?? '')) throw new Error('Speech asset download failed');
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    downloadedBytes += result.value.byteLength;
    if (downloadedBytes > MAX_MODEL_BYTES) { await reader.cancel(); throw new Error('Speech download exceeds size limit'); }
    chunks.push(result.value);
    if (performance.now() - lastProgress > 100) {
      lastProgress = performance.now();
      send({ kind: 'progress', fraction: Math.min(0.98, downloadedBytes / 93000000), bytes: downloadedBytes });
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const complete = new Response(bytes, { headers: response.headers });
  try { await cache?.put(url, complete.clone()); } catch { /* Storage denied/full: keep the loaded model in memory. */ }
  seen.add(url);
  return complete;
};
// Notes failed downloads. Only complete files are cached, so a dropped connection must not clear them.
globalThis.fetch = (input, init) => assetFetch(input, init).then(response => {
  if (!response.ok) downloadFailed = true;
  return response;
}, error => { downloadFailed = true; throw error; });

async function load() {
  try {
    if (storage && openCache) {
      for (const name of await storage.keys()) {
        if (name.startsWith('sayboard-tts-') && name !== MODEL_CACHE && name !== VOICE_CACHE) await storage.delete(name);
      }
      cache = await openCache(MODEL_CACHE);
      // Enforce the manifest even if a previous runtime left extra entries.
      for (const request of await cache.keys()) if (pinnedAsset(request.url) !== request.url) await cache.delete(request);
    }
  } catch { cache = null; }
  try {
    // Download the voice too before announcing ready. Generate will make no network requests.
    await fetch(`https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/voices/af_heart.bin`);
    model = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'wasm' });
    await model.generate('Yes', { voice: 'af_heart', speed: 1 });
  } catch (error) {
    // A cached error page or truncated file would fail every later load, so the next load downloads afresh.
    if (!downloadFailed && storage) await Promise.all([storage.delete(MODEL_CACHE), storage.delete(VOICE_CACHE)]).catch(() => {});
    throw error;
  }
  downloading = false;
  send({ kind: 'ready', bytes: downloadedBytes, assets: MODEL_FILES.length, fetched: seen.size });
}

globalThis.onmessage = async (event: MessageEvent<unknown>) => {
  const data = event.data;
  if (!data || typeof data !== 'object' || !('kind' in data)) return;
  try {
    if (data.kind === 'load') { await load(); return; }
    if (data.kind === 'generate' && 'id' in data && typeof data.id === 'number' && 'text' in data && typeof data.text === 'string' && data.text.length <= 200 && 'rate' in data && typeof data.rate === 'number' && Number.isFinite(data.rate) && data.rate >= 0.5 && data.rate <= 1.5) {
      if (!model) throw new Error('Model not ready');
      const started = performance.now();
      const audio = await model.generate(data.text, { voice: 'af_heart', speed: data.rate });
      // Runtime output is copied before transferring, so ONNX buffers remain intact.
      const samples = new Float32Array(audio.audio);
      send({ kind: 'audio', id: data.id, samples, sampleRate: audio.sampling_rate, elapsedMs: performance.now() - started }, [samples.buffer]);
    }
  } catch {
    send({ kind: 'error' });
  }
};
