import { describe, expect, it } from "vitest";
import { usernamePattern } from "../src/username";

describe("teacher invitation username field", () => {
  it("compiles as a browser pattern and matches the backend username rule", () => {
    // Browsers compile pattern attributes as ^(?:pattern)$ with the v flag
    // and ignore any pattern that fails to compile.
    const pattern = new RegExp(`^(?:${usernamePattern})$`, "v");
    for (const name of ["teacher_1", "Year-3", "a", "ends-", " pasted_1 "])
      expect(pattern.test(name)).toBe(true);
    for (const name of ["two words", "café", "a.b", ""])
      expect(pattern.test(name)).toBe(false);
  });
});
