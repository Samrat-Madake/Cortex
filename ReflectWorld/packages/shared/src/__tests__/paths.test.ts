import { describe, it, expect, afterEach } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Import directly — resolvers read process.env on each call, not at module load
import { resolveReflectWorldHome, resolveReflectWorldStateDir, canonicalize } from "../paths.js";

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

describe("resolveReflectWorldHome", () => {
  const origHome = process.env.REFLECTWORLD_HOME;

  afterEach(() => {
    if (origHome === undefined) delete process.env.REFLECTWORLD_HOME;
    else process.env.REFLECTWORLD_HOME = origHome;
  });

  it("returns ~/.reflectworld by default", () => {
    delete process.env.REFLECTWORLD_HOME;
    const result = resolveReflectWorldHome();
    expect(result).toBe(join(homedir(), ".reflectworld"));
  });

  it("respects REFLECTWORLD_HOME env var", () => {
    process.env.REFLECTWORLD_HOME = "/tmp/test-home";
    expect(resolveReflectWorldHome()).toBe("/tmp/test-home");
  });

  it("expands ~ in env var", () => {
    process.env.REFLECTWORLD_HOME = "~/custom-reflectworld";
    expect(resolveReflectWorldHome()).toBe(join(homedir(), "custom-reflectworld"));
  });
});

describe("resolveReflectWorldStateDir", () => {
  const origState = process.env.REFLECTWORLD_STATE_DIR;

  afterEach(() => {
    if (origState === undefined) delete process.env.REFLECTWORLD_STATE_DIR;
    else process.env.REFLECTWORLD_STATE_DIR = origState;
  });

  it("returns .reflectworld-state relative to cwd by default", () => {
    delete process.env.REFLECTWORLD_STATE_DIR;
    const result = resolveReflectWorldStateDir();
    expect(result).toBe(resolve(process.cwd(), ".reflectworld-state"));
  });

  it("respects REFLECTWORLD_STATE_DIR env var", () => {
    process.env.REFLECTWORLD_STATE_DIR = "/tmp/test-state";
    expect(resolveReflectWorldStateDir()).toBe("/tmp/test-state");
  });
});
