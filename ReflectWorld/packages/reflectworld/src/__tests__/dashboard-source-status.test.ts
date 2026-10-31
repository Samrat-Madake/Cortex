import { describe, expect, it } from "vitest";
import { DashboardSourceStatusService } from "../services/dashboard-source-status.js";
import type { ActiveSourceStatus } from "@reflectworld/shared";

function makeService(sources: ActiveSourceStatus[], streams: Record<string, unknown> | null) {
  return new DashboardSourceStatusService({
    sessionEnabled: () => false,
    getActiveSources: () => sources,
    getAnalysisStatus: () => ({ active: [], recent: [] }),
    sourceVisibleToSession: () => true,
    getGo2rtcStreams: async () => streams,
    readGo2rtcStreamHealth: (_streams, sourceId) => {
      const active = Boolean(_streams?.[sourceId]);
      return {
        active,
        producers: active ? 1 : 0,
        consumers: 0,
        bytesIn: active ? 1024 : 0,
        bytesOut: 0,
      };
    },
    store: null,
    uploadsDir: "/tmp/uploads",
    fixtureVideosDir: null,
  });
}

describe("DashboardSourceStatusService", () => {
  it("recovers sticky reconnecting status when live media is ready", async () => {
    const source: ActiveSourceStatus = {
      source_id: "cam-live",
      source_name: "cam-live",
      input: "rtsp://example/cam-live",
      protocol: "rtsp",
      status: "active",
      created_at: 1,
    };
    const service = makeService([source], { "cam-live": { producers: [{ url: "rtsp://example/cam-live" }] } });

    service.setOverride("cam-live", {
      ...source,
      status: "reconnecting",
      last_error: "Reconnecting stream",
      updated_at: 2,
    });

    const [visible] = await service.visibleSourceStatuses();

    expect(visible?.display_status).toBe("active");
    expect(visible?.status).toBe("active");
    expect(visible?.media_status).toBe("live_ready");
    expect(visible?.last_error).toBeUndefined();
  });
});
