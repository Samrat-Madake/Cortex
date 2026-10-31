import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyOnnxLoadable } from "../binary-installer.js";

describe("verifyOnnxLoadable", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("throws for a non-trivial file that is not a valid ONNX model", async () => {
    dir = mkdtempSync(join(tmpdir(), "onnx-check-"));
    const bogus = join(dir, "bogus.onnx");
    writeFileSync(bogus, Buffer.alloc(200_000, 7)); // right size, wrong content
    await expect(verifyOnnxLoadable(bogus)).rejects.toThrow();
  });
});
