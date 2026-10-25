import { SpeechEngine, DEFAULT_PHRASES, type ModelStatus } from "./engine";
import { BrowserSpeechOutput } from "./browser-output";
import { KokoroModel } from "./kokoro-model";

const CHOICE_KEY = "sayboard-speech-choice-v1";

// Constructing this service never starts a worker, fetches a model, or synthesizes speech.
export function createLocalSpeech() {
  const engine = new SpeechEngine(
    new BrowserSpeechOutput(),
    typeof Worker !== "undefined" && typeof WebAssembly !== "undefined"
      ? new KokoroModel()
      : undefined,
  );
  try {
    if (localStorage.getItem(CHOICE_KEY) === "model") engine.setMode("model");
  } catch {
    /* Storage can be blocked. */
  }
  function saveChoice(): boolean {
    try {
      localStorage.setItem(CHOICE_KEY, engine.getMode());
      return true;
    } catch {
      return false;
    }
  }
  function mountControls(
    container: HTMLElement,
    getRate: () => number = () => 1,
    getPhrases: () => string[] = () => [],
  ): () => void {
    const section = document.createElement("section");
    section.className = "local-speech-controls";
    const label = document.createElement("label");
    label.textContent = "Voice source";
    const choice = document.createElement("select");
    choice.append(
      new Option("Device voice", "system"),
      new Option("Consistent local voice (Heart, US English)", "model"),
    );
    choice.value = engine.getMode();
    label.append(choice);
    const description = document.createElement("p");
    description.textContent =
      "Optional download: about 93 MB for the fixed voice model, plus about 24 MB of runtime. Load only when you choose. Reloading requires this button again and reuses cached assets where storage allows. Very short words may sound less natural. Device voice speaks immediately until ready and on the first tap of an unprepared phrase. That tap silently prepares local audio for later taps. Prepare phrases for consistent quick speech. Voice source changes save immediately on this device.";
    const licences = document.createElement("a");
    licences.href = "/tts-notices.txt";
    licences.textContent = "Voice software licences";
    licences.target = "_blank";
    licences.rel = "noopener";
    const source = document.createElement("a");
    source.href = "/source/index.html";
    source.textContent = "Frontend and voice source code (GPL)";
    const state = document.createElement("p");
    state.role = "status";
    const load = document.createElement("button");
    load.type = "button";
    load.textContent = "Download / load local voice";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel voice download";
    const feedback = document.createElement("p");
    feedback.role = "status";
    const prepare = document.createElement("button");
    prepare.type = "button";
    prepare.textContent = "Prepare five common phrases";
    const prepareBoard = document.createElement("button");
    prepareBoard.type = "button";
    prepareBoard.textContent = "Prepare board phrases";
    const stopPreparation = document.createElement("button");
    stopPreparation.type = "button";
    stopPreparation.textContent = "Stop phrase preparation";
    stopPreparation.hidden = true;
    const preparation = document.createElement("p");
    preparation.role = "status";
    preparation.textContent =
      "Optional: silently prepare Yes, No, Help, Stop, and I need water. About 22 seconds in our cloud test; your device may take longer. Tapping a word interrupts preparation. Cached audio lasts until this page closes and uses the selected speed.";
    let preparing = false;
    let canPrepare = false;
    async function preparePhrases(phrases: string[], defaults: boolean) {
      preparing = true;
      prepare.disabled = true;
      prepareBoard.disabled = true;
      stopPreparation.hidden = false;
      const bounded = [
        ...new Set(
          phrases
            .map((text) => text.trim())
            .filter((text) => text && text.length <= 200),
        ),
      ].slice(0, 32);
      preparation.textContent = `Preparing phrases: 0 of ${bounded.length}.`;
      const result = await engine.preparePhrases(bounded, getRate(), (done) => {
        preparation.textContent = `Preparing phrases: ${done} of ${bounded.length}.`;
      });
      preparing = false;
      prepare.disabled = !canPrepare;
      prepareBoard.disabled = !canPrepare;
      stopPreparation.hidden = true;
      preparation.textContent = result.cancelled
        ? `Preparation stopped. ${result.prepared} phrases prepared.`
        : defaults
          ? "Five common phrases are ready for quick taps at the selected speed. Changing speed may require new preparation."
          : `${result.prepared} board phrases prepared at the selected speed. Up to 32 phrases share a 12 MB memory cache, about two minutes of speech; larger boards or long phrases may need fresh generation.`;
    }
    prepare.onclick = () => {
      void preparePhrases([...DEFAULT_PHRASES], true);
    };
    prepareBoard.onclick = () => {
      void preparePhrases(getPhrases(), false);
    };
    stopPreparation.onclick = () => {
      engine.cancel();
      preparation.textContent = "Stopping preparation. Words remain available.";
    };
    const persist = () => {
      feedback.textContent = saveChoice()
        ? ""
        : "Voice choice could not be saved on this device.";
    };
    choice.onchange = () => {
      engine.setMode(choice.value === "model" ? "model" : "system");
      persist();
    };
    load.onclick = () => {
      void engine.loadModel();
      choice.value = engine.getMode();
      persist();
    };
    cancel.onclick = () => {
      engine.cancelDownload();
      choice.value = engine.getMode();
      persist();
    };
    const unsubscribe = engine.subscribe((status: ModelStatus) => {
      load.disabled = status.phase === "loading" || status.phase === "ready";
      canPrepare = status.phase === "ready";
      prepare.disabled = preparing || !canPrepare;
      prepareBoard.disabled = preparing || !canPrepare;
      cancel.hidden = status.phase !== "loading";
      switch (status.phase) {
        case "idle":
          state.textContent =
            "Local voice is not loaded. Device voice is available while loading.";
          break;
        case "loading":
          state.textContent = `Loading local voice: ${Math.round(status.progress * 100)}%. Device voice remains available.`;
          break;
        case "ready":
          state.textContent =
            "Local voice ready. Heart, US English. Spoken words and audio stay on this device.";
          break;
        case "error":
        case "unsupported":
          state.textContent = status.detail;
          break;
        default: {
          const unexpected: never = status;
          throw new Error(`Unknown voice state ${unexpected}`);
        }
      }
    });
    section.append(
      label,
      description,
      licences,
      source,
      load,
      cancel,
      state,
      feedback,
      prepare,
      prepareBoard,
      stopPreparation,
      preparation,
    );
    container.append(section);
    return () => {
      if (preparing) engine.cancel();
      unsubscribe();
      section.remove();
    };
  }
  return { engine, mountControls };
}
