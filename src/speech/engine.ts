import { PhraseAudioCache, type PhraseAudio } from './audio-cache';

export const DEFAULT_PHRASES = Object.freeze(['Yes', 'No', 'Help', 'Stop', 'I need water']);
export const PLAYBACK_FALLBACK_MS = 1000;
export type PreparationResult = { prepared: number; cancelled: boolean };
export type SpeechMode = 'model' | 'system';
export type ModelStatus =
  | { phase: 'idle' | 'ready' }
  | { phase: 'unsupported' | 'error'; detail: string }
  | { phase: 'loading'; progress: number };
export type SpeakOptions = {
  rate?: number;
  systemVoiceURI?: string;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (detail: string) => void;
};
export interface LocalModel {
  readonly identity: string;
  load(signal: AbortSignal, progress: (fraction: number) => void): Promise<void>;
  generate(text: string, rate: number): Promise<PhraseAudio>;
  dispose(): void;
}
export interface SpeechOutput {
  system(text: string, options: SpeakOptions): void;
  // Called in the tap. Returns whether audio is already running, so fallback
  // need not wait for an asynchronous resume and lose iOS speech activation.
  unlock(): boolean;
  play(audio: PhraseAudio, options: SpeakOptions): Promise<void>;
  cancel(): void;
  dispose(): void;
}

export class SpeechEngine {
  private status: ModelStatus;
  private mode: SpeechMode = 'system';
  private listeners = new Set<(status: ModelStatus) => void>();
  private generation = 0;
  private controller: AbortController | null = null;
  private loadPromise: Promise<void> | null = null;
  private pending: (() => Promise<void>) | null = null;
  private queuedCancellation: (() => void) | null = null;
  private running = false;
  private audibleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private cache = new PhraseAudioCache();
  constructor(private output: SpeechOutput, private model?: LocalModel) {
    this.status = model ? { phase: 'idle' } : { phase: 'unsupported', detail: 'A compatible local model has not been installed.' };
  }
  subscribe(listener: (status: ModelStatus) => void): () => void {
    this.listeners.add(listener); listener(this.status);
    return () => { this.listeners.delete(listener); };
  }
  private update(status: ModelStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
  getMode(): SpeechMode { return this.mode; }
  setMode(mode: SpeechMode): void { this.cancel(); this.mode = mode; }
  loadModel(): Promise<void> {
    if (this.disposed || !this.model || this.status.phase === 'ready') return Promise.resolve();
    if (this.loadPromise) return this.loadPromise;
    const controller = new AbortController(); this.controller = controller;
    this.mode = 'model';
    this.update({ phase: 'loading', progress: 0 });
    this.loadPromise = this.model.load(controller.signal, fraction => {
      if (!controller.signal.aborted && !this.disposed) this.update({ phase: 'loading', progress: Math.max(0, Math.min(1, fraction)) });
    }).then(() => {
      if (!controller.signal.aborted && !this.disposed) {
        this.update({ phase: 'ready' });
      }
    }).catch(() => {
      if (!controller.signal.aborted && !this.disposed) this.update({ phase: 'error', detail: 'Local voice could not load. The device voice is still available.' });
    }).finally(() => { if (this.controller === controller) { this.loadPromise = null; this.controller = null; } });
    return this.loadPromise;
  }
  cancelDownload(): void {
    this.controller?.abort();
    this.controller = null; this.loadPromise = null;
    if (this.status.phase === 'loading') { this.mode = 'system'; this.update({ phase: 'idle' }); }
  }
  cancel(): void {
    this.generation++; this.pending = null;
    if (this.audibleTimer !== null) clearTimeout(this.audibleTimer);
    this.audibleTimer = null;
    this.queuedCancellation?.(); this.queuedCancellation = null;
    this.output.cancel();
  }
  // Explicit, silent preparation of five synthetic defaults. A tile tap interrupts it.
  prepareDefaultPhrases(rate = 1, progress: (prepared: number) => void = () => {}): Promise<PreparationResult> {
    return this.preparePhrases(DEFAULT_PHRASES, rate, progress);
  }
  // Preparation is explicit, serial, memory bounded, and interruptible by any tap.
  preparePhrases(phrases: readonly string[], rate = 1, progress: (prepared: number) => void = () => {}): Promise<PreparationResult> {
    this.cancel();
    if (this.disposed || !this.model || this.status.phase !== 'ready') return Promise.resolve({ prepared: 0, cancelled: true });
    const model = this.model;
    const unique = new Set<string>();
    for (const phrase of phrases) {
      const text = phrase.trim();
      if (text.length > 0 && text.length <= 200) unique.add(text);
      if (unique.size === 32) break;
    }
    const selected = [...unique];
    const speed = Math.max(0.5, Math.min(1.5, Number.isFinite(rate) ? rate : 1));
    const token = this.generation;
    const current = () => token === this.generation && !this.disposed;
    const deadline = performance.now() + 60000;
    return new Promise(resolve => {
      this.queuedCancellation = () => resolve({ prepared: 0, cancelled: true });
      this.pending = async () => {
        let prepared = 0;
        try {
          for (const text of selected) {
            if (!current() || performance.now() >= deadline) break;
            const key = JSON.stringify([model.identity, speed, text]);
            if (!this.cache.get(key)) {
              const audio = await model.generate(text, speed);
              // Keep a clip that finishes after a tap or Stop for later taps.
              this.rememberAudio(key, audio);
              if (!current()) break;
            }
            prepared++; progress(prepared);
          }
        } catch {
          if (current()) this.update({ phase: 'error', detail: 'Phrase preparation failed. The device voice is still available.' });
        } finally { resolve({ prepared, cancelled: !current() || prepared !== selected.length }); }
      };
      void this.drain();
    });
  }
  private rememberAudio(key: string, audio: PhraseAudio): void {
    if (!audio.samples.length || audio.samples.length > audio.sampleRate * 30 || !Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0 || !audio.samples.every(Number.isFinite)) throw new Error('Invalid audio');
    this.cache.set(key, audio);
  }
  speak(text: string, options: SpeakOptions = {}): void {
    this.cancel();
    if (this.disposed || !text.trim()) return;
    const token = this.generation;
    const current = () => token === this.generation && !this.disposed;
    const guarded: SpeakOptions = {
      ...options,
      rate: Math.max(0.5, Math.min(1.5, Number.isFinite(options.rate) ? options.rate ?? 1 : 1)),
      onStart: () => { if (current()) options.onStart?.(); },
      onEnd: () => { if (current()) options.onEnd?.(); },
      onError: detail => { if (current()) options.onError?.(detail); },
    };
    if (this.mode !== 'model' || this.status.phase !== 'ready' || !this.model || text.length > 200) {
      this.output.system(text, guarded); return;
    }
    let canPlayImmediately: boolean;
    try { canPlayImmediately = this.output.unlock(); } catch {
      this.update({ phase: 'error', detail: 'Local audio is unavailable. Using the device voice.' });
      this.output.system(text, guarded); return;
    }
    const model = this.model;
    const key = JSON.stringify([model.identity, guarded.rate, text]);
    let fallbackSpoken = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearDeadline = () => {
      if (timer !== null) clearTimeout(timer);
      if (this.audibleTimer === timer) this.audibleTimer = null;
      timer = null;
    };
    const fallback = () => {
      if (current() && !fallbackSpoken) {
        fallbackSpoken = true;
        // Also invalidate audio awaiting permission/resume, before device speech.
        this.output.cancel();
        this.output.system(text, guarded);
      }
    };
    const fail = () => {
      clearDeadline();
      if (current()) {
        this.update({ phase: 'error', detail: 'Local voice failed. Using the device voice.' });
        fallback();
      }
    };
    const play = async (audio: PhraseAudio) => {
      await this.output.play(audio, { ...guarded, onStart: () => { clearDeadline(); guarded.onStart?.(); } });
      clearDeadline();
    };
    // Includes queue wait and suspended audio: bound time until audible playback.
    timer = setTimeout(() => { clearDeadline(); fallback(); }, PLAYBACK_FALLBACK_MS);
    this.audibleTimer = timer;
    const cached = this.cache.get(key);
    if (cached && canPlayImmediately) {
      // Cached speech need not wait for an obsolete inference/preparation job.
      void play(cached).catch(fail);
      return;
    }
    // iOS requires the first device speech call inside the tap. Inference and
    // resuming a suspended AudioContext can miss it, so speak now and warm audio.
    clearDeadline();
    fallback();
    this.pending = async () => {
      try {
        let audio = this.cache.get(key);
        if (!audio) {
          audio = await model.generate(text, guarded.rate ?? 1);
          this.rememberAudio(key, audio);
        }
        // A late result warms the cache, but must not speak a second time.
        if (current() && !fallbackSpoken) await play(audio);
      } catch { fail(); }
    };
    void this.drain();
  }
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending) { const job = this.pending; this.pending = null; this.queuedCancellation = null; await job(); }
    } finally { this.running = false; }
  }
  dispose(): void {
    this.disposed = true; this.cancelDownload(); this.cancel(); this.cache.clear();
    this.model?.dispose(); this.output.dispose(); this.listeners.clear();
  }
}
