import { describe, expect, it, vi } from 'vitest';
import { PhraseAudioCache } from '../src/speech/audio-cache';
import { SpeechEngine, type LocalModel, type SpeechOutput, type SpeakOptions } from '../src/speech/engine';

const audio = { samples: new Float32Array([0.1, -0.1]), sampleRate: 24000 };
function fixture(generate: LocalModel['generate'] = async () => audio) {
  const output: SpeechOutput = { system: vi.fn(), unlock: vi.fn(() => true), play: vi.fn(async () => {}), cancel: vi.fn(), dispose: vi.fn() };
  const model: LocalModel = { identity: 'test-fixed-voice-v1', load: vi.fn(async (_signal, progress) => { progress(1); }), generate: vi.fn(generate), dispose: vi.fn() };
  return { output, model, engine: new SpeechEngine(output, model) };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('local speech engine', () => {
  it('does not load a model on construction or speech; keeps system voice available', () => {
    const { engine, model, output } = fixture();
    engine.speak('Yes'); expect(model.load).not.toHaveBeenCalled(); expect(output.system).toHaveBeenCalledOnce();
  });
  it('speaks an unprepared phrase immediately with device voice, then reuses local audio', async () => {
    const { engine, model, output } = fixture();
    await engine.loadModel(); engine.speak('Yes'); await flush(); engine.speak('Yes'); await flush();
    expect(model.generate).toHaveBeenCalledOnce(); expect(output.system).toHaveBeenCalledOnce(); expect(output.play).toHaveBeenCalledOnce();
  });
  it('drops stale synthesis and coalesces rapid taps to only the latest pending phrase', async () => {
    let resolve: ((value: typeof audio) => void) | undefined;
    const { engine, model, output } = fixture(() => new Promise(done => { resolve = done; }));
    await engine.loadModel(); engine.speak('Yes'); engine.speak('No'); engine.speak('Help');
    resolve?.(audio); await flush();
    expect(model.generate).toHaveBeenCalledTimes(2); expect(model.generate).toHaveBeenLastCalledWith('Help', 1);
    expect(output.system).toHaveBeenLastCalledWith('Help', expect.any(Object));
    expect(output.play).not.toHaveBeenCalled(); resolve?.(audio); await flush(); expect(output.play).not.toHaveBeenCalled();
  });
  it('suppresses old system callbacks after cancellation', () => {
    const { engine, output } = fixture(); const end = vi.fn();
    engine.speak('Yes', { onEnd: end });
    const options: SpeakOptions = vi.mocked(output.system).mock.calls[0][1];
    engine.cancel(); options.onEnd?.(); expect(end).not.toHaveBeenCalled();
  });
  it('falls back on local inference error and keeps the phrase unchanged', async () => {
    const { engine, output } = fixture(async () => { throw new Error('out of memory'); });
    await engine.loadModel(); engine.speak('I need water'); await flush();
    expect(output.system).toHaveBeenCalledWith('I need water', expect.any(Object));
  });
  it('does not resurrect a cancelled download', async () => {
    const { engine, model } = fixture(); let finish: (() => void) | undefined;
    model.load = () => new Promise(resolve => { finish = resolve; });
    const statuses: string[] = []; engine.subscribe(status => statuses.push(status.phase));
    const promise = engine.loadModel(); engine.cancelDownload(); finish?.(); await promise;
    expect(statuses).toEqual(['idle', 'loading', 'idle']); expect(engine.getMode()).toBe('system');
  });
  it('allows caregiver choice of system mode after loading', async () => {
    const { engine, output, model } = fixture(); await engine.loadModel(); engine.setMode('system'); engine.speak('Yes');
    expect(output.system).toHaveBeenCalledOnce(); expect(model.generate).not.toHaveBeenCalled();
  });
});
describe('memory audio cache', () => {
  it('evicts least recently used audio within byte and entry limits', () => {
    const cache = new PhraseAudioCache(16, 2); cache.set('yes', audio); cache.set('no', audio); cache.get('yes'); cache.set('help', audio);
    expect(cache.get('no')).toBeUndefined(); expect(cache.get('yes')).toBe(audio); expect(cache.byteLength).toBe(16);
    cache.clear(); expect(cache.byteLength).toBe(0);
  });
  it('does not retain oversized clips', () => {
    const cache = new PhraseAudioCache(4); cache.set('yes', audio); expect(cache.byteLength).toBe(0);
  });
});

it('separates phrase audio when model identity or speaking rate changes', async () => {
  const { engine, model } = fixture();
  await engine.loadModel();
  engine.speak('Yes', { rate: 1 }); await flush();
  engine.speak('Yes', { rate: 0.8 }); await flush();
  engine.speak('Yes', { rate: 1 }); await flush();
  expect(model.generate).toHaveBeenCalledTimes(2);
});

it('rejects invalid model audio and falls back without playing it', async () => {
  const { engine, output } = fixture(async () => ({ samples: new Float32Array([NaN]), sampleRate: 24000 }));
  await engine.loadModel(); engine.speak('Help'); await flush();
  expect(output.play).not.toHaveBeenCalled();
  expect(output.system).toHaveBeenCalledWith('Help', expect.any(Object));
});

it('can restart immediately after cancelling a download without the old completion clearing the new load', async () => {
  const { engine, model } = fixture();
  const starts: { signal: AbortSignal; finish: () => void }[] = [];
  model.load = signal => new Promise<void>(resolve => { starts.push({ signal, finish: resolve }); });
  const first = engine.loadModel(); engine.cancelDownload(); const second = engine.loadModel();
  expect(starts).toHaveLength(2); expect(starts[0].signal.aborted).toBe(true);
  starts[0].finish(); await first;
  expect(engine.loadModel()).toBe(second);
  starts[1].finish(); await second;
  expect(engine.getMode()).toBe('model');
});

it('prepares exactly five defaults silently and reuses them for subsequent taps', async () => {
  const { engine, model, output } = fixture(); await engine.loadModel();
  const progress = vi.fn();
  expect(await engine.prepareDefaultPhrases(1, progress)).toEqual({ prepared: 5, cancelled: false });
  expect(model.generate).toHaveBeenCalledTimes(5);
  expect(output.play).not.toHaveBeenCalled(); expect(progress).toHaveBeenLastCalledWith(5);
  engine.speak('Stop'); await flush();
  expect(model.generate).toHaveBeenCalledTimes(5); expect(output.play).toHaveBeenCalledOnce();
});

it('a tile tap interrupts silent preparation and is the next inference job', async () => {
  let resolve: ((value: typeof audio) => void) | undefined;
  const { engine, model, output } = fixture(() => new Promise(done => { resolve = done; }));
  await engine.loadModel(); const preparing = engine.prepareDefaultPhrases();
  engine.speak('Help'); resolve?.(audio); await flush();
  expect(await preparing).toEqual({ prepared: 0, cancelled: true });
  expect(model.generate).toHaveBeenCalledTimes(2); expect(model.generate).toHaveBeenLastCalledWith('Help', 1);
  resolve?.(audio); await flush(); expect(output.play).not.toHaveBeenCalled();
  engine.speak('Help'); await flush(); expect(output.play).toHaveBeenCalledOnce();
});

it('cached speech starts without waiting for an obsolete inference job', async () => {
  const { engine, model, output } = fixture(); await engine.loadModel();
  engine.speak('Yes'); await flush();
  let finish: ((value: typeof audio) => void) | undefined;
  model.generate = vi.fn(() => new Promise<typeof audio>(resolve => { finish = resolve; }));
  engine.speak('No'); engine.speak('Yes'); await flush();
  expect(output.play).toHaveBeenCalledOnce();
  finish?.(audio); await flush(); expect(output.play).toHaveBeenCalledOnce();
});

it('uses device voice synchronously while a custom phrase silently fills the cache', async () => {
  vi.useFakeTimers();
  try {
    let finish: ((value: typeof audio) => void) | undefined;
    const { engine, output, model } = fixture(() => new Promise(resolve => { finish = resolve; }));
    await engine.loadModel(); engine.speak('Please bring my glasses');
    expect(output.system).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(999); expect(output.system).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(output.system).toHaveBeenCalledOnce();
    finish?.(audio); await flush(); expect(output.play).not.toHaveBeenCalled();
    engine.speak('Please bring my glasses'); await flush();
    expect(model.generate).toHaveBeenCalledOnce(); expect(output.play).toHaveBeenCalledOnce();
    engine.dispose();
  } finally { vi.useRealTimers(); }
});

it('bounds latest tap silence even when obsolete inference holds the worker queue', async () => {
  vi.useFakeTimers();
  try {
    let finish: ((value: typeof audio) => void) | undefined;
    const { engine, output, model } = fixture(() => new Promise(resolve => { finish = resolve; }));
    await engine.loadModel(); engine.speak('Old phrase');
    await vi.advanceTimersByTimeAsync(500); engine.speak('New phrase');
    await vi.advanceTimersByTimeAsync(1000);
    expect(output.system).toHaveBeenCalledTimes(2); expect(output.system).toHaveBeenLastCalledWith('New phrase', expect.any(Object));
    finish?.(audio); await flush(); expect(model.generate).toHaveBeenLastCalledWith('New phrase', 1);
    finish?.(audio); await flush(); expect(output.play).not.toHaveBeenCalled();
    engine.dispose();
  } finally { vi.useRealTimers(); }
});

it('Stop cancels immediate device speech and suppresses stale inference output', async () => {
  vi.useFakeTimers();
  try {
    let finish: ((value: typeof audio) => void) | undefined;
    const { engine, output } = fixture(() => new Promise(resolve => { finish = resolve; }));
    await engine.loadModel(); engine.speak('Help'); engine.cancel();
    await vi.advanceTimersByTimeAsync(1000); finish?.(audio); await flush();
    expect(output.system).toHaveBeenCalledOnce(); expect(output.play).not.toHaveBeenCalled();
    engine.dispose();
  } finally { vi.useRealTimers(); }
});

it('inference failure after audible fallback never speaks the phrase twice', async () => {
  vi.useFakeTimers();
  try {
    let reject: ((reason: Error) => void) | undefined;
    const { engine, output } = fixture(() => new Promise((_resolve, fail) => { reject = fail; }));
    await engine.loadModel(); engine.speak('Water');
    await vi.advanceTimersByTimeAsync(1000); reject?.(new Error('Inference stalled')); await flush();
    expect(output.system).toHaveBeenCalledOnce(); engine.dispose();
  } finally { vi.useRealTimers(); }
});

it('falls back synchronously when AudioContext cannot be unlocked', async () => {
  const { engine, output, model } = fixture(); await engine.loadModel();
  vi.mocked(output.unlock).mockImplementation(() => { throw new Error('AudioContext unavailable'); });
  expect(() => engine.speak('Help')).not.toThrow();
  expect(output.system).toHaveBeenCalledWith('Help', expect.any(Object)); expect(model.generate).not.toHaveBeenCalled();
});

it('prepares custom phrases silently with deduplication and a 32-entry cap', async () => {
  const { engine, output, model } = fixture(); await engine.loadModel();
  const phrases = ['', '  ', 'x'.repeat(201), 'Custom', 'Custom', ...Array.from({ length: 40 }, (_, i) => `Phrase ${i}`)];
  expect(await engine.preparePhrases(phrases)).toEqual({ prepared: 32, cancelled: false });
  expect(model.generate).toHaveBeenCalledTimes(32); expect(output.play).not.toHaveBeenCalled();
  expect(model.generate).not.toHaveBeenCalledWith('Phrase 31', 1);
  engine.speak('Custom'); await flush(); expect(model.generate).toHaveBeenCalledTimes(32); expect(output.play).toHaveBeenCalledOnce();
});

it('stops admitting preparation work after its 60-second budget', async () => {
  const time = vi.spyOn(performance, 'now');
  time.mockReturnValue(0);
  try {
    const { engine, model } = fixture(async () => { time.mockReturnValue(60001); return audio; });
    await engine.loadModel();
    expect(await engine.preparePhrases(['First', 'Second'])).toEqual({ prepared: 1, cancelled: true });
    expect(model.generate).toHaveBeenCalledOnce();
  } finally { time.mockRestore(); }
});

it('keeps immediate device speech available during setup and when no worker model is supported', async () => {
  const { engine, model, output } = fixture();
  let finish: (() => void) | undefined;
  model.load = () => new Promise(resolve => { finish = resolve; });
  const loading = engine.loadModel(); engine.speak('Help');
  expect(output.system).toHaveBeenCalledWith('Help', expect.any(Object)); expect(model.generate).not.toHaveBeenCalled();
  finish?.(); await loading; engine.dispose();
  vi.mocked(output.system).mockClear();
  const unsupported = new SpeechEngine(output); unsupported.setMode('model'); unsupported.speak('No');
  expect(output.system).toHaveBeenCalledWith('No', expect.any(Object)); unsupported.dispose();
});

it('bounds silence when cached playback is waiting for audio permission', async () => {
  vi.useFakeTimers();
  try {
    const { engine, output, model } = fixture(); await engine.loadModel();
    engine.speak('Yes'); await flush();
    vi.mocked(output.play).mockImplementation(() => new Promise(() => {}));
    const cancellations = vi.mocked(output.cancel).mock.calls.length;
    engine.speak('Yes'); await vi.advanceTimersByTimeAsync(1000);
    expect(model.generate).toHaveBeenCalledOnce(); expect(output.system).toHaveBeenCalledWith('Yes', expect.any(Object));
    expect(output.cancel).toHaveBeenCalledTimes(cancellations + 2);
    engine.dispose();
  } finally { vi.useRealTimers(); }
});

it('does not fall back during a longer clip once local playback actually starts', async () => {
  vi.useFakeTimers();
  try {
    const { engine, output } = fixture(); await engine.loadModel();
    await engine.preparePhrases(['I need water']);
    let finish: (() => void) | undefined;
    vi.mocked(output.play).mockImplementation((_audio, options) => { options.onStart?.(); return new Promise(resolve => { finish = resolve; }); });
    engine.speak('I need water'); await flush(); await vi.advanceTimersByTimeAsync(5000);
    expect(output.system).not.toHaveBeenCalled(); finish?.(); await flush(); engine.dispose();
  } finally { vi.useRealTimers(); }
});


it('uses device speech synchronously when prepared audio needs a suspended context to resume', async () => {
  const { engine, output, model } = fixture(); await engine.loadModel();
  await engine.preparePhrases(['Help']);
  vi.mocked(output.unlock).mockReturnValue(false);
  engine.speak('Help');
  expect(output.system).toHaveBeenCalledWith('Help', expect.any(Object));
  await flush(); expect(output.play).not.toHaveBeenCalled();
  expect(model.generate).toHaveBeenCalledOnce();
  vi.mocked(output.unlock).mockReturnValue(true);
  engine.speak('Help'); await flush(); expect(output.play).toHaveBeenCalledOnce();
  engine.dispose();
});

it('keeps a phrase that finishes after a newer tap for the next tap', async () => {
  const finish: ((value: typeof audio) => void)[] = [];
  const { engine, model, output } = fixture(() => new Promise(resolve => { finish.push(resolve); }));
  await engine.loadModel(); engine.speak('I'); engine.speak('want');
  finish[0](audio); await flush(); finish[1](audio); await flush();
  expect(output.play).not.toHaveBeenCalled();
  engine.speak('I'); await flush();
  expect(model.generate).toHaveBeenCalledTimes(2); expect(output.play).toHaveBeenCalledOnce();
});

it('keeps the clip in progress when phrase preparation is stopped', async () => {
  let finish: ((value: typeof audio) => void) | undefined;
  const { engine, model, output } = fixture(() => new Promise(resolve => { finish = resolve; }));
  await engine.loadModel(); const preparing = engine.preparePhrases(['Yes', 'No']);
  engine.cancel(); finish?.(audio);
  expect(await preparing).toEqual({ prepared: 0, cancelled: true });
  engine.speak('Yes'); await flush();
  expect(model.generate).toHaveBeenCalledOnce(); expect(output.play).toHaveBeenCalledOnce();
});
