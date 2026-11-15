import { describe, it, expect, afterEach } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Import directly — resolvers read process.env on each call, not at module load
import { resolveCortexHome, resolveCortexStateDir, canonicalize } from "../paths.js";

describe("canonicalize", () => {
  it("expands ~ to homedir", () => {
    expect(canonicalize("~/foo")).toBe(join(homedir(), "foo"));
  });

  it("resolves relative paths to absolute", () => {
    const result = canonicalize("relative/path");
    expect(result).toMatch(/^\//);
    expect(result).toMatch(/relative\/path$/);
  });

  it("leaves absolute paths unchanged", () => {
    expect(canonicalize("/absolute/path")).toBe("/absolute/path");
  });
});

describe("resolveCortexHome", () => {
  const origHome = process.env.CORTEX_HOME;

  afterEach(() => {
    if (origHome === undefined) delete process.env.CORTEX_HOME;
    else process.env.CORTEX_HOME = origHome;
  });

  it("returns ~/.cortex by default", () => {
    delete process.env.CORTEX_HOME;
    const result = resolveCortexHome();
    expect(result).toBe(join(homedir(), ".cortex"));
  });

  it("respects CORTEX_HOME env var", () => {
    process.env.CORTEX_HOME = "/tmp/test-home";
    expect(resolveCortexHome()).toBe("/tmp/test-home");
  });

  it("expands ~ in env var", () => {
    process.env.CORTEX_HOME = "~/custom-cortex";
    expect(resolveCortexHome()).toBe(join(homedir(), "custom-cortex"));
  });
});

describe("resolveCortexStateDir", () => {
  const origState = process.env.CORTEX_STATE_DIR;

  afterEach(() => {
    if (origState === undefined) delete process.env.CORTEX_STATE_DIR;
    else process.env.CORTEX_STATE_DIR = origState;
  });

  it("returns .cortex-state relative to cwd by default", () => {
    delete process.env.CORTEX_STATE_DIR;
    const result = resolveCortexStateDir();
    expect(result).toBe(resolve(process.cwd(), ".cortex-state"));
  });

  it("respects CORTEX_STATE_DIR env var", () => {
    process.env.CORTEX_STATE_DIR = "/tmp/test-state";
    expect(resolveCortexStateDir()).toBe("/tmp/test-state");
  });
});
