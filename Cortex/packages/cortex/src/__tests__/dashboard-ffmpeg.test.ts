import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { DashboardServer } from "../services/dashboard-server.js";

const mockSpawn = vi.mocked(spawn);

function makeResponse(): ServerResponse {
  const res = new EventEmitter() as ServerResponse;
  Object.assign(res, {
    destroyed: false,
    writableEnded: false,
  });
  return res;
}

function makeFakeProcess(options?: { exitOnSigterm?: boolean }) {
  const exitOnSigterm = options?.exitOnSigterm ?? true;
  const proc = new EventEmitter() as any;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn((signal?: NodeJS.Signals) => {
    if (signal === "SIGTERM" && exitOnSigterm) {
      queueMicrotask(() => {
        proc.signalCode = "SIGTERM";
        proc.emit("close", null, "SIGTERM");
      });
    }
    if (signal === "SIGKILL") {
      queueMicrotask(() => {
        proc.signalCode = "SIGKILL";
        proc.emit("close", null, "SIGKILL");
      });
    }
    return true;
  });
  return proc;
}

describe("DashboardServer ffmpeg jobs", () => {
  let tmpRoot = "";
  let previousMaxJobs: string | undefined;
  let previousMaxQueue: string | undefined;

  beforeEach(() => {
    mockSpawn.mockReset();
    previousMaxJobs = process.env.DASHBOARD_MAX_FFMPEG_JOBS;
    previousMaxQueue = process.env.DASHBOARD_MAX_FFMPEG_QUEUE;
    tmpRoot = mkdtempSync(join(tmpdir(), "cortex-dashboard-ffmpeg-"));
  });

  afterEach(() => {
    if (previousMaxJobs == null) delete process.env.DASHBOARD_MAX_FFMPEG_JOBS;
    else process.env.DASHBOARD_MAX_FFMPEG_JOBS = previousMaxJobs;
    if (previousMaxQueue == null) delete process.env.DASHBOARD_MAX_FFMPEG_QUEUE;
    else process.env.DASHBOARD_MAX_FFMPEG_QUEUE = previousMaxQueue;
    rmSync(tmpRoot, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("terminates ffmpeg when the client disconnects during generation", async () => {
    vi.useFakeTimers();
    const proc = makeFakeProcess({ exitOnSigterm: false });
    mockSpawn.mockReturnValue(proc);
    const server = new DashboardServer({ distDir: "/nonexistent", uploadsDir: tmpRoot });
    const res = makeResponse();

    const job = (server as any).runFfmpegToFile(["-i", "in.mp4", "out.mp4"], join(tmpRoot, "out.mp4"), "preview", res);
    const rejection = expect(job).rejects.toThrow("client disconnected");
    await Promise.resolve();
    res.emit("close");
    await vi.advanceTimersByTimeAsync(3_000);

    await rejection;
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("uses an explicit mp4 muxer for browser preview temp files", async () => {
    const sourcePath = join(tmpRoot, "source.mp4");
    writeFileSync(sourcePath, "source");
    mockSpawn.mockImplementation((_cmd, args) => {
      const proc = makeFakeProcess();
      const ffmpegArgs = args as string[];
      const formatIndex = ffmpegArgs.indexOf("-f");
      expect(formatIndex).toBeGreaterThan(-1);
      expect(ffmpegArgs[formatIndex + 1]).toBe("mp4");
      const outputPath = ffmpegArgs[ffmpegArgs.length - 1];
      expect(outputPath).toMatch(/\.browser-h264\.mp4\..+\.tmp$/);
      writeFileSync(outputPath, "preview");
      queueMicrotask(() => proc.emit("close", 0, null));
      return proc;
    });
    const server = new DashboardServer({ distDir: "/nonexistent", uploadsDir: tmpRoot });

    const previewPath = await (server as any).ensurePreviewVideo("upload/source.mp4", sourcePath);

    expect(previewPath).toMatch(/upload_source\.mp4\.browser-h264\.mp4$/);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("limits concurrent ffmpeg jobs", async () => {
    process.env.DASHBOARD_MAX_FFMPEG_JOBS = "1";
    process.env.DASHBOARD_MAX_FFMPEG_QUEUE = "2";
    const firstProc = makeFakeProcess();
    const secondProc = makeFakeProcess();
    mockSpawn
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const server = new DashboardServer({ distDir: "/nonexistent", uploadsDir: tmpRoot });

    const first = (server as any).runFfmpegToFile(["first"], join(tmpRoot, "first.mp4"), "first");
    const second = (server as any).runFfmpegToFile(["second"], join(tmpRoot, "second.mp4"), "second");

    await Promise.resolve();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const firstRejection = expect(first).rejects.toThrow("ffmpeg first failed");
    firstProc.emit("close", 1, null);
    await firstRejection;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    const secondRejection = expect(second).rejects.toThrow("ffmpeg second failed");
    secondProc.emit("close", 1, null);
    await secondRejection;
  });

  it("rejects ffmpeg jobs when the wait queue is full", async () => {
    process.env.DASHBOARD_MAX_FFMPEG_JOBS = "1";
    process.env.DASHBOARD_MAX_FFMPEG_QUEUE = "1";
    const firstProc = makeFakeProcess();
    const secondProc = makeFakeProcess();
    mockSpawn
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const server = new DashboardServer({ distDir: "/nonexistent", uploadsDir: tmpRoot });

    const first = (server as any).runFfmpegToFile(["first"], join(tmpRoot, "first.mp4"), "first");
    const second = (server as any).runFfmpegToFile(["second"], join(tmpRoot, "second.mp4"), "second");
    const third = (server as any).runFfmpegToFile(["third"], join(tmpRoot, "third.mp4"), "third");

    await expect(third).rejects.toThrow("queue full");
    await Promise.resolve();
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const firstRejection = expect(first).rejects.toThrow("ffmpeg first failed");
    firstProc.emit("close", 1, null);
    await firstRejection;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    const secondRejection = expect(second).rejects.toThrow("ffmpeg second failed");
    secondProc.emit("close", 1, null);
    await secondRejection;
  });

  it("removes queued ffmpeg jobs when the client disconnects before a slot opens", async () => {
    process.env.DASHBOARD_MAX_FFMPEG_JOBS = "1";
    process.env.DASHBOARD_MAX_FFMPEG_QUEUE = "2";
    const firstProc = makeFakeProcess();
    const secondProc = makeFakeProcess();
    mockSpawn
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const server = new DashboardServer({ distDir: "/nonexistent", uploadsDir: tmpRoot });
    const queuedRes = makeResponse();

    const first = (server as any).runFfmpegToFile(["first"], join(tmpRoot, "first.mp4"), "first");
    const queued = (server as any).runFfmpegToFile(["queued"], join(tmpRoot, "queued.mp4"), "queued", queuedRes);
    const queuedRejection = expect(queued).rejects.toThrow("client disconnected");
    await Promise.resolve();
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    queuedRes.emit("close");
    await queuedRejection;

    const firstRejection = expect(first).rejects.toThrow("ffmpeg first failed");
    firstProc.emit("close", 1, null);
    await firstRejection;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("terminates active jobs and rejects queued jobs on dashboard stop", async () => {
    process.env.DASHBOARD_MAX_FFMPEG_JOBS = "1";
    process.env.DASHBOARD_MAX_FFMPEG_QUEUE = "2";
    const firstProc = makeFakeProcess({ exitOnSigterm: false });
    mockSpawn.mockReturnValueOnce(firstProc);
    const server = new DashboardServer({ distDir: "/nonexistent", uploadsDir: tmpRoot });

    const first = (server as any).runFfmpegToFile(["first"], join(tmpRoot, "first.mp4"), "first");
    const queued = (server as any).runFfmpegToFile(["queued"], join(tmpRoot, "queued.mp4"), "queued");
    const firstRejection = expect(first).rejects.toThrow("ffmpeg first failed");
    const queuedRejection = expect(queued).rejects.toThrow("dashboard stopped");
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));

    server.stop();
    expect(firstProc.kill).toHaveBeenCalledWith("SIGTERM");
    firstProc.emit("close", null, "SIGTERM");

    await queuedRejection;
    await firstRejection;
  });
});
