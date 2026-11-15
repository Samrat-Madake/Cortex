import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Go2rtcManager } from "../go2rtc-manager.js";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(true),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { spawn } from "node:child_process";
const mockSpawn = vi.mocked(spawn);
const mockWriteFileSync = vi.mocked(writeFileSync);

function makeFakeProcess(options?: { exitOnSigterm?: boolean }) {
  const exitOnSigterm = options?.exitOnSigterm ?? true;
  const proc = new EventEmitter() as any;
  proc.pid = 12345;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = vi.fn((signal?: NodeJS.Signals) => {
    if (signal === "SIGTERM" && exitOnSigterm) {
      queueMicrotask(() => {
        proc.signalCode = "SIGTERM";
        proc.emit("exit", null, "SIGTERM");
      });
    }
    if (signal === "SIGKILL") {
      queueMicrotask(() => {
        proc.signalCode = "SIGKILL";
        proc.emit("exit", null, "SIGKILL");
      });
    }
    return true;
  });
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

describe("Go2rtcManager", () => {
  let manager: Go2rtcManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new Go2rtcManager({ binPath: "/usr/bin/go2rtc" });
  });

  afterEach(async () => {
    await manager.stop().catch(() => {});
  });

  it("starts go2rtc subprocess", async () => {
    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as any);
    mockFetch
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    await manager.start();

    expect(mockSpawn).toHaveBeenCalledWith(
      "/usr/bin/go2rtc",
      expect.arrayContaining(["-config"]),
      expect.any(Object),
    );
    expect(manager.mode).toBe("managed");
  });

  it("writes localhost-only go2rtc listeners by default", async () => {
    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as any);
    mockFetch
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    await manager.start();

    const config = String(mockWriteFileSync.mock.calls[0]?.[1] ?? "");
    expect(config).toContain('  listen: "127.0.0.1:1984"');
    expect(config).toContain('  listen: "127.0.0.1:8554"');
    expect(config).toContain('  listen: "127.0.0.1:8555"');
    expect(config).not.toContain('listen: ":1984"');
  });

  it("allows explicitly exposing go2rtc listeners", async () => {
    manager = new Go2rtcManager({ binPath: "/usr/bin/go2rtc", listenAddr: "0.0.0.0" });
    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as any);
    mockFetch
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    await manager.start();

    const config = String(mockWriteFileSync.mock.calls[0]?.[1] ?? "");
    expect(config).toContain('  listen: "0.0.0.0:1984"');
    expect(config).toContain('  listen: "0.0.0.0:8554"');
    expect(config).toContain('  listen: "0.0.0.0:8555"');
  });

  it("reuses an externally running go2rtc instance", async () => {
    const warnings = vi.fn();
    manager = new Go2rtcManager({ binPath: "/usr/bin/go2rtc", onWarning: warnings });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    await manager.start();

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(manager.mode).toBe("external");
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("Reusing an already-running external go2rtc"));
  });

  it("does not warn when explicitly configured for public go2rtc listeners", async () => {
    const warnings = vi.fn();
    manager = new Go2rtcManager({ binPath: "/usr/bin/go2rtc", listenAddr: "0.0.0.0", onWarning: warnings });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    await manager.start();

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(manager.mode).toBe("external");
    expect(warnings).not.toHaveBeenCalled();
  });

  it("fails closed when external reuse is disabled", async () => {
    manager = new Go2rtcManager({ binPath: "/usr/bin/go2rtc", reuseExternal: false });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    await expect(manager.start()).rejects.toThrow("external reuse is disabled");

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(manager.mode).toBe("stopped");
  });

  it("stop kills the subprocess", async () => {
    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as any);
    mockFetch
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    await manager.start();
    await manager.stop();

    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(manager.mode).toBe("stopped");
  });

  it("escalates to SIGKILL when a failed start leaves go2rtc running", async () => {
    vi.useFakeTimers();
    try {
      const proc = makeFakeProcess({ exitOnSigterm: false });
      mockSpawn.mockReturnValue(proc as any);
      mockFetch.mockResolvedValue({ ok: false, json: async () => ({}) });

      const started = manager.start();
      const rejection = expect(started).rejects.toThrow("go2rtc did not become healthy");
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(3_000);

      await rejection;
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
      expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
      expect(manager.mode).toBe("stopped");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop does not kill an external go2rtc instance", async () => {
    manager = new Go2rtcManager({ binPath: "/usr/bin/go2rtc", onWarning: vi.fn() });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    await manager.start();
    await manager.stop();

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(manager.mode).toBe("stopped");
  });

  it("isRunning returns false before start", () => {
    expect(manager.isRunning).toBe(false);
  });

  it("addStream calls go2rtc REST API", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    await manager.addStream("cam1", ["rtsp://192.168.1.100/stream"]);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/streams"),
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("removeStream calls DELETE", async () => {
    mockFetch.mockResolvedValue({ ok: true });

    await manager.removeStream("cam1");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/streams?name=cam1"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("listStreams calls GET", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ cam1: { producers: [] } }),
    });

    const streams = await manager.listStreams();
    expect(streams).toHaveProperty("cam1");
  });

  it("captureFrame fetches JPEG from frame API", async () => {
    const jpegData = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => jpegData.buffer,
    });

    const frame = await manager.captureFrame("cam1");
    expect(Buffer.isBuffer(frame)).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/frame.jpeg?src=cam1"),
    );
  });

  it("captureFrame passes width and height params", async () => {
    const jpegData = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => jpegData.buffer,
    });

    await manager.captureFrame("cam1", 640, 480);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("w=640"),
    );
  });

  it("isHealthy returns true when API responds", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    expect(await manager.isHealthy()).toBe(true);
  });

  it("isHealthy returns false on network error", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await manager.isHealthy()).toBe(false);
  });
});
