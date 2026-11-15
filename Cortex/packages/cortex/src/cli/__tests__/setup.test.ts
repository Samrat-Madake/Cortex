import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Mock all network / heavy IO so runSetup's orchestration can be exercised offline. ──
// Every acquisition writes a valid-size (>100KB) fake file; verifyModelFile is size-only
// here (the real sha behaviour is unit-tested in download.test.ts).

vi.mock("../download.js", async () => {
  const { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const big = () => Buffer.alloc(200_000, 1);
  return {
    downloadAndExtractBinary: vi.fn(async (_url: string, binDir: string, filename: string) => {
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, filename), big());
    }),
    downloadFile: vi.fn(async (_url: string, dest: string) => {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, big());
    }),
    extractZipMember: vi.fn((_zip: string, _member: string, dest: string) => {
      writeFileSync(dest, big());
    }),
    verifyModelFile: vi.fn((path: string) => {
      if (!existsSync(path) || statSync(path).size < 100_000) {
        if (existsSync(path)) unlinkSync(path);
        throw new Error("missing or truncated");
      }
    }),
    ensureDir: (d: string) => mkdirSync(d, { recursive: true }),
  };
});

// A convert produces a file tagged with a marker so the mocked verifyOnnxLoadable can
// tell a real (converted) ONNX from a bogus pre-placed one.
const ONNX_MARKER = "VALIDONNX";

vi.mock("../model-converter.js", async () => {
  const { writeFileSync } = await import("node:fs");
  return {
    convertModel: vi.fn((_model: unknown, dest: string) => {
      writeFileSync(dest, Buffer.concat([Buffer.from("VALIDONNX"), Buffer.alloc(200_000, 1)]));
    }),
  };
});

vi.mock("../python-env.js", () => ({ copyServices: vi.fn() }));

vi.mock("@cortex/percept", async () => {
  const { mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  return {
    setupSttModels: vi.fn(async (dir: string) => {
      mkdirSync(join(dir, "sherpa-onnx-moonshine-tiny-en-int8"), { recursive: true });
      return { moonshine: join(dir, "sherpa-onnx-moonshine-tiny-en-int8") };
    }),
    verifyOnnxLoadable: vi.fn(async (modelPath: string) => {
      const { readFileSync } = await import("node:fs");
      if (readFileSync(modelPath).subarray(0, 9).toString() !== "VALIDONNX") {
        throw new Error("not a loadable ONNX (mock)");
      }
      return true;
    }),
  };
});

import { runSetup } from "../setup.js";
import { convertModel } from "../model-converter.js";
import { downloadAndExtractBinary, downloadFile, extractZipMember } from "../download.js";
import { setupSttModels } from "@cortex/percept";

const ENV_KEYS = ["STT_PROVIDER", "CORTEX_BODY_REID_ENABLED", "CORTEX_HOME", "CORTEX_STATE_DIR"];

describe("runSetup orchestration", () => {
  let home = "";
  let modelsDir = "";
  const originalCwd = process.cwd();
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    home = realpathSync(mkdtempSync(join(tmpdir(), "rw-setup-")));
    modelsDir = join(home, "models");
    process.chdir(home); // avoid loading a repo .env via dotenv.config()
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("Level 1 with --accept-model-licenses acquires all L1 models via the right branches", async () => {
    await runSetup(["--level", "1", "--yes", "--accept-model-licenses", "--home-dir", home]);

    for (const f of ["silero_vad.onnx", "yolo26m.onnx", "retinaface-resnet50.onnx", "w600k_mbf.onnx"]) {
      expect(existsSync(join(modelsDir, f)), `${f} should be installed`).toBe(true);
    }
    // direct (silero), convert (yolo + retinaface), archive (arcface)
    expect(vi.mocked(downloadFile).mock.calls.some(([, dest]) => String(dest).endsWith("silero_vad.onnx"))).toBe(true);
    const converted = vi.mocked(convertModel).mock.calls.map(([m]) => (m as { filename: string }).filename);
    expect(converted).toContain("yolo26m.onnx");
    expect(converted).toContain("retinaface-resnet50.onnx");
    expect(vi.mocked(extractZipMember).mock.calls.some(([, , dest]) => String(dest).endsWith("w600k_mbf.onnx"))).toBe(true);
  });

  it("Level 1 without license acceptance (non-interactive) skips restricted models and stays at L0", async () => {
    await runSetup(["--level", "1", "--yes", "--home-dir", home]);

    expect(existsSync(join(modelsDir, "silero_vad.onnx"))).toBe(true); // license-clean, still installed
    for (const f of ["yolo26m.onnx", "retinaface-resnet50.onnx", "w600k_mbf.onnx"]) {
      expect(existsSync(join(modelsDir, f)), `${f} should be skipped without license acceptance`).toBe(false);
    }
    expect(vi.mocked(convertModel)).not.toHaveBeenCalled();
  });

  it("re-verifies an already-present file and re-acquires it when invalid", async () => {
    mkdirSync(modelsDir, { recursive: true });
    // pre-place a truncated (invalid) silero file
    writeFileSync(join(modelsDir, "silero_vad.onnx"), Buffer.alloc(1_000));

    await runSetup(["--level", "0", "--yes", "--home-dir", home]);

    // the bad file was dropped and re-downloaded to a valid size
    expect(vi.mocked(downloadFile).mock.calls.some(([, dest]) => String(dest).endsWith("silero_vad.onnx"))).toBe(true);
    expect(statSync(join(modelsDir, "silero_vad.onnx")).size).toBeGreaterThanOrEqual(100_000);
  });

  it("replaces an already-present incompatible Qdrant binary", async () => {
    const binDir = join(home, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "qdrant"), Buffer.from("#!/bin/sh\nexit 1\n"));
    chmodSync(join(binDir, "qdrant"), 0o755);

    await runSetup(["--level", "0", "--yes", "--home-dir", home]);

    expect(vi.mocked(downloadAndExtractBinary).mock.calls.some(([, , filename]) => filename === "qdrant")).toBe(true);
    expect(statSync(join(binDir, "qdrant")).size).toBeGreaterThanOrEqual(100_000);
  });

  it("keeps an already-present runnable Qdrant binary", async () => {
    const binDir = join(home, "bin");
    const qdrantPath = join(binDir, "qdrant");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(qdrantPath, Buffer.from("#!/bin/sh\necho 'qdrant 1.17.1'\n"));
    chmodSync(qdrantPath, 0o755);

    await runSetup(["--level", "0", "--yes", "--home-dir", home]);

    expect(vi.mocked(downloadAndExtractBinary).mock.calls.some(([, , filename]) => filename === "qdrant")).toBe(false);
    expect(readFileSync(qdrantPath, "utf8")).toContain("qdrant 1.17.1");
  });

  it("removes a half-written file when a download fails (no false 'installed')", async () => {
    // silero (the only L0 model) leaves a partial file, then the download throws
    vi.mocked(downloadFile).mockImplementationOnce(async (_url: string, dest: string) => {
      writeFileSync(dest, Buffer.alloc(50_000)); // truncated partial
      throw new Error("network interrupted");
    });

    // L0 can no longer be satisfied → setup must fail loudly, not silently "complete"
    await expect(runSetup(["--level", "0", "--yes", "--home-dir", home])).rejects.toThrow();
    expect(existsSync(join(modelsDir, "silero_vad.onnx"))).toBe(false);
  });

  it("removes a half-extracted file when an archive extraction fails", async () => {
    // arcface (archive) leaves a partial file, then extraction throws
    vi.mocked(extractZipMember).mockImplementationOnce((_zip: string, _member: string, dest: string) => {
      writeFileSync(dest, Buffer.alloc(50_000)); // partial
      throw new Error("corrupt archive");
    });

    await runSetup(["--level", "1", "--yes", "--accept-model-licenses", "--home-dir", home]);

    // the half-extracted file must not survive to be trusted by the final gate
    expect(existsSync(join(modelsDir, "w600k_mbf.onnx"))).toBe(false);
  });

  it("structurally re-validates an already-present converted ONNX and re-converts a corrupt one", async () => {
    mkdirSync(modelsDir, { recursive: true });
    // A corrupt but >100KB yolo26m.onnx (convert models have no fixed sha to catch it).
    writeFileSync(join(modelsDir, "yolo26m.onnx"), Buffer.alloc(200_000, 9));

    await runSetup(["--level", "1", "--yes", "--accept-model-licenses", "--home-dir", home]);

    // the structurally-invalid file was dropped and re-converted
    const converted = vi.mocked(convertModel).mock.calls.map(([m]) => (m as { filename: string }).filename);
    expect(converted).toContain("yolo26m.onnx");
    // the final file is the valid (marked) conversion output, not the corrupt one
    expect(readFileSync(join(modelsDir, "yolo26m.onnx")).subarray(0, 9).toString()).toBe(ONNX_MARKER);
  });

  it("installs Moonshine into modelsDir (matching runtime lookup) only when STT_PROVIDER=moonshine", async () => {
    process.env.STT_PROVIDER = "moonshine";
    await runSetup(["--level", "0", "--yes", "--home-dir", home]);

    expect(vi.mocked(setupSttModels)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setupSttModels).mock.calls[0]![0]).toBe(modelsDir);
  });

  it("does not install Moonshine when STT is disabled or ElevenLabs", async () => {
    process.env.STT_PROVIDER = "elevenlabs";
    await runSetup(["--level", "0", "--yes", "--home-dir", home]);
    expect(vi.mocked(setupSttModels)).not.toHaveBeenCalled();
  });

  it("the Level-0 upgrade hint tells the user to accept model licenses", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let output = "";
    try {
      await runSetup(["--level", "0", "--yes", "--home-dir", home]);
      output = log.mock.calls.map((c) => c.join(" ")).join("\n");
    } finally {
      log.mockRestore();
    }
    expect(output).toContain("setup --level 1");
    expect(output).toContain("--accept-model-licenses");
  });
});
