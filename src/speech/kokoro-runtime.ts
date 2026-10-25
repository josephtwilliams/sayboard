// Native module imports do not go through the worker's fetch wrapper. Preload
// the same URL used by ONNX so runtime syntax/network failures are classified
// separately from corrupt model files. The browser reuses its module record.
export async function loadRuntimeModule(url: string): Promise<void> {
  const module = await import(/* @vite-ignore */ url);
  if (typeof module.default !== "function")
    throw new Error("Invalid speech runtime module");
}
