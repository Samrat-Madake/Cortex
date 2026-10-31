import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mockHome = vi.hoisted(() => ({ value: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => mockHome.value || actual.homedir(),
  };
});

import { resolveCliConfig, resolveHomeDir } from "../config.js";

describe("CLI config", () => {
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  let tmpRoot = "";

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "reflectworld-cli-config-"));
    mockHome.value = join(tmpRoot, "home");
    mkdirSync(mockHome.value, { recursive: true });
    process.chdir(tmpRoot);

    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    delete process.env.REFLECTWORLD_HOME;
    delete process.env.REFLECTWORLD_STATE_DIR;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    mockHome.value = "";
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("resolves default runtime directories", () => {
    const config = resolveCliConfig([]);

    expect(config.homeDir).toBe(join(mockHome.value, ".reflectworld"));
    expect(config.stateDir).toBe(join(process.cwd(), ".reflectworld-state"));
    expect(process.env.REFLECTWORLD_HOME).toBe(config.homeDir);
    expect(process.env.REFLECTWORLD_STATE_DIR).toBe(config.stateDir);
  });

  it("resolves explicit runtime directories from CLI args", () => {
    const homeDir = join(tmpRoot, "explicit-home");
    const stateDir = join(tmpRoot, "explicit-state");

    const config = resolveCliConfig(["--home-dir", homeDir, "--state-dir", stateDir, "--port", "4123"]);

    expect(config.homeDir).toBe(homeDir);
    expect(config.stateDir).toBe(stateDir);
    expect(config.port).toBe(4123);
    expect(process.env.REFLECTWORLD_HOME).toBe(homeDir);
    expect(process.env.REFLECTWORLD_STATE_DIR).toBe(stateDir);
    expect(process.env.PORT).toBe("4123");
  });

  it("resolves setup home directory", () => {
    const homeDir = resolveHomeDir([]);

    expect(homeDir).toBe(join(mockHome.value, ".reflectworld"));
    expect(process.env.REFLECTWORLD_HOME).toBe(homeDir);
  });
});
