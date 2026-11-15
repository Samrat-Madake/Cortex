import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEnableLevel1 } from "../enable-level1.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

describe("runEnableLevel1", () => {
  let packageDir: string;

  beforeEach(() => {
    packageDir = mkdtempSync(join(tmpdir(), "cortex-enable-level1-"));
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({
      name: "cortex-consumer",
      version: "1.0.0",
    }, null, 2) + "\n");
    vi.mocked(execFileSync).mockReturnValue(`${packageDir}\n`);
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(packageDir, { recursive: true, force: true });
  });

  it("preserves bundled native peer ranges without changing a dry-run project", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const before = readFileSync(join(packageDir, "package.json"), "utf8");

    await runEnableLevel1(["--package-dir", packageDir, "--dry-run", "--with-stt"]);

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain(
      "Dependencies: onnxruntime-node@^1.24.3 sharp@^0.34.5 sherpa-onnx-node",
    );
    expect(output).toContain("Command: npm install");
    expect(readFileSync(join(packageDir, "package.json"), "utf8")).toBe(before);
    expect(execFileSync).toHaveBeenCalledOnce();
    expect(execFileSync).toHaveBeenCalledWith(
      "npm",
      ["prefix"],
      { cwd: packageDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("accepts a package directory reached through a symbolic link", async () => {
    const aliasRoot = mkdtempSync(join(tmpdir(), "cortex-enable-level1-alias-"));
    const packageAlias = join(aliasRoot, "project");
    try {
      symlinkSync(packageDir, packageAlias, process.platform === "win32" ? "junction" : "dir");

      await expect(runEnableLevel1([
        "--package-dir",
        packageAlias,
        "--dry-run",
      ])).resolves.toBeUndefined();
      expect(execFileSync).toHaveBeenCalledWith(
        "npm",
        ["prefix"],
        { cwd: packageAlias, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } finally {
      rmSync(aliasRoot, { recursive: true, force: true });
    }
  });

  it("persists the security override and native dependencies in the target project", async () => {
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({
      name: "cortex-consumer",
      version: "1.0.0",
      overrides: {
        ws: "8.18.0",
        "onnxruntime-node": { existing: "preserved" },
      },
    }, null, 2) + "\n");

    await runEnableLevel1(["--package-dir", packageDir]);

    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    expect(manifest.overrides).toEqual({
      ws: "8.18.0",
      "onnxruntime-node": { existing: "preserved", "adm-zip": "0.6.0" },
    });
    expect(manifest.dependencies).toEqual({
      "onnxruntime-node": "^1.24.3",
      sharp: "^0.34.5",
    });
    expect(execFileSync).toHaveBeenCalledWith(
      "npm",
      ["install"],
      { cwd: packageDir, stdio: "inherit" },
    );
  });

  it("does not replace an existing adm-zip override", async () => {
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({
      name: "cortex-consumer",
      overrides: { "onnxruntime-node": { "adm-zip": "0.5.16" } },
    }, null, 2) + "\n");

    await expect(runEnableLevel1(["--package-dir", packageDir])).rejects.toThrow(
      "Cannot replace existing onnxruntime-node > adm-zip override",
    );
    expect(execFileSync).toHaveBeenCalledOnce();
  });

  it("restores package.json when npm install fails", async () => {
    const packageJsonPath = join(packageDir, "package.json");
    const before = readFileSync(packageJsonPath, "utf8");
    vi.mocked(execFileSync)
      .mockReturnValueOnce(`${packageDir}\n`)
      .mockImplementationOnce(() => {
        throw new Error("install failed");
      });

    await expect(runEnableLevel1(["--package-dir", packageDir])).rejects.toThrow("install failed");
    expect(readFileSync(packageJsonPath, "utf8")).toBe(before);
  });

  it("writes the override at the npm root while saving dependencies to a workspace", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "cortex-workspace-"));
    const workspacePackage = join(workspaceRoot, "packages", "app");
    try {
      writeFileSync(join(workspaceRoot, "package.json"), JSON.stringify({
        name: "cortex-workspace",
        private: true,
        workspaces: ["packages/*"],
        overrides: { ws: "8.18.0" },
      }, null, 2) + "\n");
      mkdirSync(workspacePackage, { recursive: true });
      writeFileSync(join(workspacePackage, "package.json"), JSON.stringify({
        name: "cortex-app",
        version: "1.0.0",
      }, null, 2) + "\n");
      vi.mocked(execFileSync).mockReturnValue(`${workspaceRoot}\n`);

      await runEnableLevel1(["--package-dir", workspacePackage]);

      const rootManifest = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf8"));
      expect(rootManifest.overrides).toEqual({
        ws: "8.18.0",
        "onnxruntime-node": { "adm-zip": "0.6.0" },
      });
      expect(rootManifest.dependencies).toEqual({ "onnxruntime-node": "^1.24.3" });
      const workspaceManifest = JSON.parse(readFileSync(join(workspacePackage, "package.json"), "utf8"));
      expect(workspaceManifest.dependencies).toEqual({
        "onnxruntime-node": "^1.24.3",
        sharp: "^0.34.5",
      });
      expect(execFileSync).toHaveBeenCalledWith(
        "npm",
        ["install"],
        { cwd: workspaceRoot, stdio: "inherit" },
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("restores both workspace manifests when npm install fails", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "cortex-workspace-rollback-"));
    const workspacePackage = join(workspaceRoot, "packages", "app");
    mkdirSync(workspacePackage, { recursive: true });
    const rootPackageJsonPath = join(workspaceRoot, "package.json");
    const workspacePackageJsonPath = join(workspacePackage, "package.json");
    writeFileSync(rootPackageJsonPath, JSON.stringify({
      name: "cortex-workspace",
      private: true,
      workspaces: ["packages/*"],
    }, null, 2) + "\n");
    writeFileSync(workspacePackageJsonPath, JSON.stringify({
      name: "cortex-app",
      version: "1.0.0",
    }, null, 2) + "\n");
    const rootBefore = readFileSync(rootPackageJsonPath, "utf8");
    const workspaceBefore = readFileSync(workspacePackageJsonPath, "utf8");

    try {
      vi.mocked(execFileSync)
        .mockReturnValueOnce(`${workspaceRoot}\n`)
        .mockImplementationOnce(() => {
          writeFileSync(workspacePackageJsonPath, "{}\n");
          throw new Error("workspace install failed");
        });

      await expect(runEnableLevel1(["--package-dir", workspacePackage])).rejects.toThrow(
        "workspace install failed",
      );
      expect(readFileSync(rootPackageJsonPath, "utf8")).toBe(rootBefore);
      expect(readFileSync(workspacePackageJsonPath, "utf8")).toBe(workspaceBefore);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
