// Service lifecycle — MiniHost orchestration, service registration, startup/stop ordering
//
// Tests the deterministic host mechanics without live external services.
// Live service startup (Qdrant, Cortex Python) is only exercised by
// eval/video-runner/runner.ts. This file verifies the orchestration contract.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MiniHost } from "../../packages/host/src/mini-host.js";
import type { PluginModule } from "../../packages/host/src/mini-host.js";
import type { PluginService, AnyAgentTool } from "@cortex/shared";

// ── Factories ──

function makeMockService(id: string): PluginService & {
  startSpy: ReturnType<typeof vi.fn>;
  stopSpy: ReturnType<typeof vi.fn>;
  startOrder: number[];
  stopOrder: number[];
} {
  const startOrder: number[] = [];
  const stopOrder: number[] = [];
  const startSpy = vi.fn(async () => { startOrder.push(Date.now()); });
  const stopSpy = vi.fn(async () => { stopOrder.push(Date.now()); });

  return {
    id,
    start: startSpy,
    stop: stopSpy,
    startSpy,
    stopSpy,
    startOrder,
    stopOrder,
  };
}

function makeMockTool(name: string): AnyAgentTool {
  return {
    name,
    description: `Mock tool: ${name}`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(async () => JSON.stringify({ ok: true })),
  } as unknown as AnyAgentTool;
}

function makePlugin(
  id: string,
  opts?: {
    services?: PluginService[];
    tools?: AnyAgentTool[];
  },
): PluginModule {
  return {
    id,
    name: `Test Plugin ${id}`,
    register: (api) => {
      for (const svc of opts?.services ?? []) {
        api.registerService(svc);
      }
      for (const tool of opts?.tools ?? []) {
        api.registerTool(tool);
      }
    },
  };
}

// ── Tests ──

describe("MiniHost: plugin registration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "minihost-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadPlugin registers tools that are callable via callTool", async () => {
    const host = new MiniHost({ stateDir: tmpDir });
    const tool = makeMockTool("test_tool");
    await host.loadPlugin(makePlugin("test", { tools: [tool] }));

    const tools = host.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("test_tool");

    const result = await host.callTool("test_tool", { action: "ping" });
    expect(JSON.parse(result)).toEqual({ ok: true });
    expect(tool.execute).toHaveBeenCalled();
  });

  it("callTool throws for unregistered tool name", async () => {
    const host = new MiniHost({ stateDir: tmpDir });
    await expect(host.callTool("nonexistent", {})).rejects.toThrow("Tool not found");
  });

  it("loadPlugin creates per-plugin state directory", async () => {
    const host = new MiniHost({ stateDir: tmpDir });
    await host.loadPlugin(makePlugin("my_plugin"));

    expect(existsSync(join(tmpDir, "my_plugin"))).toBe(true);
  });

  it("loadPlugin provides pluginConfig from host options", async () => {
    const host = new MiniHost({
      stateDir: tmpDir,
      pluginConfigs: { cfg_plugin: { foo: "bar", num: 42 } },
    });

    let receivedConfig: Record<string, unknown> | undefined;
    await host.loadPlugin({
      id: "cfg_plugin",
      name: "Config Plugin",
      register: (api) => {
        receivedConfig = api.pluginConfig as Record<string, unknown>;
      },
    });

    expect(receivedConfig).toEqual({ foo: "bar", num: 42 });
  });
});

describe("MiniHost: service lifecycle ordering", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "minihost-svc-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("startServices calls start() on each service sequentially", async () => {
    const svc1 = makeMockService("svc_a");
    const svc2 = makeMockService("svc_b");
    const callOrder: string[] = [];
    svc1.start = vi.fn(async () => { callOrder.push("a"); });
    svc2.start = vi.fn(async () => { callOrder.push("b"); });

    const host = new MiniHost({ stateDir: tmpDir });
    await host.loadPlugin(makePlugin("test", { services: [svc1, svc2] }));
    await host.startServices();

    expect(callOrder).toEqual(["a", "b"]);
  });

  it("stopServices calls stop() in reverse registration order", async () => {
    const callOrder: string[] = [];
    const svc1 = makeMockService("svc_a");
    const svc2 = makeMockService("svc_b");
    const svc3 = makeMockService("svc_c");
    svc1.stop = vi.fn(async () => { callOrder.push("a"); });
    svc2.stop = vi.fn(async () => { callOrder.push("b"); });
    svc3.stop = vi.fn(async () => { callOrder.push("c"); });

    const host = new MiniHost({ stateDir: tmpDir });
    await host.loadPlugin(makePlugin("test", { services: [svc1, svc2, svc3] }));
    await host.stopServices();

    expect(callOrder).toEqual(["c", "b", "a"]);
  });

  it("startServices propagates service start failure", async () => {
    const svc1 = makeMockService("svc_ok");
    const svc2 = makeMockService("svc_fail");
    svc2.start = vi.fn(async () => { throw new Error("Port 6333 in use"); });

    const host = new MiniHost({ stateDir: tmpDir });
    await host.loadPlugin(makePlugin("test", { services: [svc1, svc2] }));

    await expect(host.startServices()).rejects.toThrow("Port 6333 in use");
    // svc1 was started before svc2 failed
    expect(svc1.startSpy).toHaveBeenCalled();
  });

  it("stopServices tolerates service without stop method", async () => {
    const svcNoStop: PluginService = {
      id: "no_stop",
      start: vi.fn(async () => {}),
      // stop is optional per PluginService interface
    };
    const svcWithStop = makeMockService("with_stop");

    const host = new MiniHost({ stateDir: tmpDir });
    await host.loadPlugin(makePlugin("test", { services: [svcNoStop, svcWithStop] }));

    // Should not throw even though svcNoStop has no stop()
    await expect(host.stopServices()).resolves.toBeUndefined();
    expect(svcWithStop.stopSpy).toHaveBeenCalled();
  });
});

describe("MiniHost: stop and restart recovery", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "minihost-restart-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("services can be stopped and restarted", async () => {
    const callLog: string[] = [];
    const svc = makeMockService("svc_restart");
    svc.start = vi.fn(async () => { callLog.push("start"); });
    svc.stop = vi.fn(async () => { callLog.push("stop"); });

    const host = new MiniHost({ stateDir: tmpDir });
    await host.loadPlugin(makePlugin("test", { services: [svc] }));

    await host.startServices();
    await host.stopServices();
    await host.startServices();

    expect(callLog).toEqual(["start", "stop", "start"]);
  });

  it("tools remain callable after stop + restart cycle", async () => {
    const tool = makeMockTool("resilient_tool");
    const svc = makeMockService("svc_cycle");

    const host = new MiniHost({ stateDir: tmpDir });
    await host.loadPlugin(makePlugin("test", { tools: [tool], services: [svc] }));

    await host.startServices();
    const r1 = await host.callTool("resilient_tool", { seq: 1 });
    expect(JSON.parse(r1)).toEqual({ ok: true });

    await host.stopServices();

    // Tool itself doesn't depend on service lifecycle in MiniHost
    const r2 = await host.callTool("resilient_tool", { seq: 2 });
    expect(JSON.parse(r2)).toEqual({ ok: true });

    await host.startServices();
    const r3 = await host.callTool("resilient_tool", { seq: 3 });
    expect(JSON.parse(r3)).toEqual({ ok: true });

    expect(tool.execute).toHaveBeenCalledTimes(3);
  });

  it("stopServices continues stopping remaining services when one fails", async () => {
    const callLog: string[] = [];
    const svcBad = makeMockService("svc_bad_stop");
    const svcGood = makeMockService("svc_good_stop");
    svcBad.stop = vi.fn(async () => { throw new Error("Cannot stop cleanly"); });
    svcGood.stop = vi.fn(async () => { callLog.push("good_stopped"); });

    const host = new MiniHost({ stateDir: tmpDir });
    await host.loadPlugin(makePlugin("test", { services: [svcGood, svcBad] }));

    // stopServices iterates in reverse: svcBad stops first (throws),
    // but svcGood should STILL get its stop() called (error isolation).
    await expect(host.stopServices()).rejects.toThrow("failed to stop");
    expect(callLog).toEqual(["good_stopped"]); // svcGood DID stop
  });

  it("stopServices throws AggregateError with all failures collected", async () => {
    const svc1 = makeMockService("svc_fail_1");
    const svc2 = makeMockService("svc_fail_2");
    svc1.stop = vi.fn(async () => { throw new Error("Fail 1"); });
    svc2.stop = vi.fn(async () => { throw new Error("Fail 2"); });

    const host = new MiniHost({ stateDir: tmpDir });
    await host.loadPlugin(makePlugin("test", { services: [svc1, svc2] }));

    try {
      await host.stopServices();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      expect((err as AggregateError).errors).toHaveLength(2);
    }
  });
});

describe("MiniHost: multi-plugin isolation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "minihost-multi-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("tools from different plugins coexist and are callable", async () => {
    const host = new MiniHost({ stateDir: tmpDir });

    await host.loadPlugin(makePlugin("plugin_a", {
      tools: [makeMockTool("tool_a")],
    }));
    await host.loadPlugin(makePlugin("plugin_b", {
      tools: [makeMockTool("tool_b")],
    }));

    const tools = host.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["tool_a", "tool_b"]);

    await expect(host.callTool("tool_a", {})).resolves.toBeDefined();
    await expect(host.callTool("tool_b", {})).resolves.toBeDefined();
  });

  it("services from multiple plugins all receive start/stop calls", async () => {
    const svcA = makeMockService("svc_a");
    const svcB = makeMockService("svc_b");

    const host = new MiniHost({ stateDir: tmpDir });
    await host.loadPlugin(makePlugin("plugin_a", { services: [svcA] }));
    await host.loadPlugin(makePlugin("plugin_b", { services: [svcB] }));

    await host.startServices();
    expect(svcA.startSpy).toHaveBeenCalledOnce();
    expect(svcB.startSpy).toHaveBeenCalledOnce();

    await host.stopServices();
    expect(svcA.stopSpy).toHaveBeenCalledOnce();
    expect(svcB.stopSpy).toHaveBeenCalledOnce();
  });
});
