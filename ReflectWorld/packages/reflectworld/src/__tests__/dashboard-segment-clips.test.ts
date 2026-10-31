import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardSegmentClipService } from "../services/dashboard-segment-clips.js";
import type { PipelineStore } from "../store.js";

function makeHeadRequest(): IncomingMessage {
  return { method: "HEAD", headers: {} } as IncomingMessage;
}

function makeResponse(): ServerResponse {
  return {
    destroyed: false,
    writableEnded: false,
    writeHead: vi.fn(),
    end: vi.fn(function end(this: { writableEnded: boolean }) {
      this.writableEnded = true;
    }),
  } as unknown as ServerResponse;
}

function makeService(entry: Record<string, unknown>, recordingsDir: string | null, uploadsDir: string, runFfmpegToFile = vi.fn(async (_args: string[], outputPath: string) => {
  writeFileSync(outputPath, Buffer.from("clip"));
})) {
  return {
    service: new DashboardSegmentClipService({
      store: {
        getBySegmentId: vi.fn(() => entry),
      } as unknown as PipelineStore,
      recordingsDir,
      uploadsDir,
      scopeFromRequest: () => null,
      sourceVisibleToSession: () => true,
      sourceLabels: () => new Map(),
      readSourceConfig: () => null,
      runFfmpegToFile,
    }),
    runFfmpegToFile,
  };
}

describe("DashboardSegmentClipService", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("clips event raw_url mp4s to the segment range", async () => {
    const root = mkdtempSync(join(tmpdir(), "dashboard-event-clip-"));
    tempRoots.push(root);
    const uploadsDir = join(root, "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    const eventPath = join(root, "cam-live_event_20260616120000.mp4");
    writeFileSync(eventPath, Buffer.from("event"));
    const entry = {
      segment_id: "seg-event",
      camera_id: "cam-live",
      raw_url: eventPath,
      segment_start: new Date("2026-06-16T12:00:05").getTime(),
      duration_sec: 4,
      created_at: "2026-06-16T12:00:05.000Z",
    };
    const { service, runFfmpegToFile } = makeService(entry, null, uploadsDir);
    const res = makeResponse();

    await service.handle(makeHeadRequest(), "seg-event", res);

    expect(runFfmpegToFile).toHaveBeenCalledTimes(1);
    const args = runFfmpegToFile.mock.calls[0]![0];
    expect(args).toContain(eventPath);
    expect(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 2)).toEqual(["-ss", "5"]);
    expect(args.slice(args.indexOf("-t"), args.indexOf("-t") + 2)).toEqual(["-t", "4"]);
  });

  it("does not align media-PTS segments against wall-clock event filenames", async () => {
    const root = mkdtempSync(join(tmpdir(), "dashboard-event-pts-"));
    tempRoots.push(root);
    const uploadsDir = join(root, "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    const eventPath = join(root, "cam-live_event_20260616120000.mp4");
    writeFileSync(eventPath, Buffer.from("event"));
    const entry = {
      segment_id: "seg-media-pts",
      camera_id: "cam-live",
      raw_url: eventPath,
      segment_start: 5_000,
      duration_sec: 4,
      created_at: "2026-06-16T12:00:05.000Z",
    };
    const { service, runFfmpegToFile } = makeService(entry, null, uploadsDir);
    const res = makeResponse();

    await service.handle(makeHeadRequest(), "seg-media-pts", res);

    expect(runFfmpegToFile).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      "Content-Type": "video/mp4",
    }));
  });

  it("clips matched event recordings instead of serving the whole event file", async () => {
    const root = mkdtempSync(join(tmpdir(), "dashboard-event-match-"));
    tempRoots.push(root);
    const uploadsDir = join(root, "uploads");
    const cameraDir = join(root, "recordings", "cam-live");
    mkdirSync(uploadsDir, { recursive: true });
    mkdirSync(cameraDir, { recursive: true });
    const eventPath = join(cameraDir, "cam-live_event_20260616120000.mp4");
    writeFileSync(eventPath, Buffer.from("event"));
    const entry = {
      segment_id: "seg-event-match",
      camera_id: "cam-live",
      raw_url: join(root, "recordings", "cam-live"),
      segment_start: new Date("2026-06-16T12:00:07").getTime(),
      duration_sec: 3,
      created_at: "2026-06-16T12:00:07.000Z",
    };
    const { service, runFfmpegToFile } = makeService(entry, join(root, "recordings"), uploadsDir);
    const res = makeResponse();

    await service.handle(makeHeadRequest(), "seg-event-match", res);

    expect(runFfmpegToFile).toHaveBeenCalledTimes(1);
    const args = runFfmpegToFile.mock.calls[0]![0];
    expect(args).toContain(eventPath);
    expect(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 2)).toEqual(["-ss", "7"]);
    expect(args.slice(args.indexOf("-t"), args.indexOf("-t") + 2)).toEqual(["-t", "3"]);
  });
});
