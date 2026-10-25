import { expect, it } from "vitest";
import { loadRuntimeModule } from "../src/speech/kokoro-runtime";

const moduleUrl = (source: string) =>
  `data:text/javascript,${encodeURIComponent(source)}`;

it("loads a native runtime module with its expected factory", async () => {
  await expect(
    loadRuntimeModule(moduleUrl("export default function () {}")),
  ).resolves.toBeUndefined();
});

it.each([
  "<!doctype html><html>Blocked</html>",
  "/* filter page */ <html>Blocked</html>",
  "export default function () {",
  "const interruptedBeforeExport = true;",
  "export default {};",
])("rejects a malformed runtime module: %s", async (source) => {
  await expect(loadRuntimeModule(moduleUrl(source))).rejects.toBeInstanceOf(
    Error,
  );
});
