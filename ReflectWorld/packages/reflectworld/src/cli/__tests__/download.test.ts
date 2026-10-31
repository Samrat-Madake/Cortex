import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractZipMember, sha256File, verifyModelFile } from "../download.js";

function hasZip(): boolean {
  try {
    execFileSync("zip", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("verifyModelFile", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });
  const mkFile = (bytes: number, fill = 7): string => {
    dir = mkdtempSync(join(tmpdir(), "verify-"));
    const p = join(dir, "model.onnx");
    writeFileSync(p, Buffer.alloc(bytes, fill));
    return p;
  };

  it("passes a non-trivial file whose sha256 matches", () => {
    const p = mkFile(200_000);
    expect(() => verifyModelFile(p, sha256File(p))).not.toThrow();
    expect(existsSync(p)).toBe(true);
  });

  it("passes a non-trivial file when no sha256 is provided", () => {
    const p = mkFile(200_000);
    expect(() => verifyModelFile(p)).not.toThrow();
    expect(existsSync(p)).toBe(true);
  });

  it("deletes the file and throws on sha256 mismatch", () => {
    const p = mkFile(200_000);
    expect(() => verifyModelFile(p, "0".repeat(64))).toThrow(/sha256 mismatch/);
    expect(existsSync(p)).toBe(false);
  });

  it("deletes the file and throws when truncated (<100KB)", () => {
    const p = mkFile(1_000);
    expect(() => verifyModelFile(p)).toThrow(/truncated/);
    expect(existsSync(p)).toBe(false);
  });

  it("throws when the file is missing entirely", () => {
    dir = mkdtempSync(join(tmpdir(), "verify-"));
    expect(() => verifyModelFile(join(dir, "nope.onnx"))).toThrow();
  });
});

describe("extractZipMember", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it.skipIf(!hasZip())("extracts a nested member and renames it to the target filename", () => {
    dir = mkdtempSync(join(tmpdir(), "zip-"));
    const nested = join(dir, "20230831", "rtmpose_onnx", "ckpt");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "end2end.onnx"), Buffer.from("hello-onnx-bytes"));
    const zipPath = join(dir, "pack.zip");
    execFileSync("zip", ["-q", "-r", zipPath, "20230831"], { cwd: dir });

    const out = join(dir, "rtmpose-s.onnx");
    extractZipMember(zipPath, "20230831/rtmpose_onnx/ckpt/end2end.onnx", out);

    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8")).toBe("hello-onnx-bytes");
  });
});
