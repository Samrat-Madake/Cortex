import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReflectWorldService } from "../services/reflectworld-service.js";

const ORIGINAL_ENV = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

function serviceEnv(service: ReflectWorldService): Record<string, string> {
  return (service as unknown as { envVars(): Record<string, string> }).envVars();
}

describe("ReflectWorldService env", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("points managed memory webhooks at the current dashboard port", () => {
    delete process.env.MONITOR_WEBHOOK_URL;
    delete process.env.DASHBOARD_PORT;
    delete process.env.MONITOR_PORT;
    process.env.PORT = "3210";

    const service = new ReflectWorldService({
      stateDir: "/tmp/reflectworld-test-state",
      sourceDir: "/tmp/reflectworld-test-mem",
    });

    expect(serviceEnv(service).MONITOR_WEBHOOK_URL).toBe("http://127.0.0.1:3210/api/memory-event");
  });

  it("defaults Python memory storage under the configured home dir", () => {
    delete process.env.STORAGE_PATH;

    const service = new ReflectWorldService({
      homeDir: "/tmp/reflectworld-test-home",
      stateDir: "/tmp/reflectworld-test-state",
      sourceDir: "/tmp/reflectworld-test-mem",
    });

    expect(serviceEnv(service).STORAGE_PATH).toBe("/tmp/reflectworld-test-home/memory-state");
  });

  it("preserves an explicit memory storage path from the environment", () => {
    process.env.STORAGE_PATH = "/tmp/custom-memory-state";

    const service = new ReflectWorldService({
      homeDir: "/tmp/reflectworld-test-home",
      stateDir: "/tmp/reflectworld-test-state",
      sourceDir: "/tmp/reflectworld-test-mem",
    });

    expect(serviceEnv(service).STORAGE_PATH).toBe("/tmp/custom-memory-state");
  });

  it("preserves an explicit memory webhook URL", () => {
    process.env.MONITOR_WEBHOOK_URL = "http://127.0.0.1:3999/custom-memory-event";
    process.env.PORT = "3210";

    const service = new ReflectWorldService({
      stateDir: "/tmp/reflectworld-test-state",
      sourceDir: "/tmp/reflectworld-test-mem",
    });

    expect(serviceEnv(service).MONITOR_WEBHOOK_URL).toBe("http://127.0.0.1:3999/custom-memory-event");
  });

  it("passes the configured qdrant port to managed memory", () => {
    const service = new ReflectWorldService({
      stateDir: "/tmp/reflectworld-test-state",
      sourceDir: "/tmp/reflectworld-test-mem",
      qdrantPort: 6433,
    });

    expect(serviceEnv(service).QDRANT_PORT).toBe("6433");
  });
});

describe("ReflectWorldService startup", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("fails immediately when the managed uv process exits during startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "reflectworld-service-"));
    const homeDir = join(root, "home");
    const sourceDir = join(root, "mem");
    const uvBin = join(homeDir, "bin", "uv");
    mkdirSync(join(homeDir, "bin"), { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "pyproject.toml"), "[project]\nname = \"reflectworld-test\"\n");
    writeFileSync(
      uvBin,
      "#!/bin/sh\necho 'qdrant_client.http.exceptions.ResponseHandlingException: timed out' >&2\nexit 42\n",
    );
    chmodSync(uvBin, 0o755);

    const service = new ReflectWorldService({
      homeDir,
      stateDir: join(root, "state"),
      sourceDir,
      port: 49219,
    });

    const startedAt = Date.now();
    let error: unknown;
    try {
      await service.start();
    } catch (err) {
      error = err;
    } finally {
      await service.stop().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }

    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("ReflectWorld (uv) exited during startup");
    expect(message).toContain("ResponseHandlingException: timed out");
  });
});
