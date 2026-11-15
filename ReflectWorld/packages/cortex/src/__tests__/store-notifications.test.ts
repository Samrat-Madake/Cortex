import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PipelineStore } from "../store.js";

describe("PipelineStore — notification delivery tracking", () => {
  let store: PipelineStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "store-notif-"));
    store = new PipelineStore(tmpDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("logNotification records delivered=true by default", () => {
    store.logNotification({
      segment_id: "seg_001",
      camera_id: "cam_a",
      type: "alert",
      message: "Break-in detected",
      policy: "smart",
      path: "direct",
    });

    const rows = store.getRecentNotifications("cam_a");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("delivered");
    expect(rows[0]!.delivered).toBe(1);
    expect(rows[0]!.delivery_error).toBeNull();
    expect(rows[0]!.delivery_ms).toBeNull();
  });

  it("logNotification records delivered=false with error", () => {
    store.logNotification({
      segment_id: "seg_002",
      camera_id: "cam_b",
      type: "summary",
      message: "Person at door",
      policy: "always",
      path: "subagent",
      delivered: false,
      delivery_error: "subagent: timeout; fallback: channel offline",
      delivery_ms: 1500,
    });

    const rows = store.getRecentNotifications("cam_b");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.delivered).toBe(0);
    expect(rows[0]!.delivery_error).toBe("subagent: timeout; fallback: channel offline");
    expect(rows[0]!.delivery_ms).toBe(1500);
  });

  it("logNotification records delivery_ms for successful sends", () => {
    store.logNotification({
      segment_id: "seg_003",
      camera_id: "cam_c",
      type: "identify",
      message: "Unknown person",
      policy: "smart",
      path: "subagent",
      delivered: true,
      delivery_ms: 42,
    });

    const rows = store.getRecentNotifications("cam_c");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("delivered");
    expect(rows[0]!.delivered).toBe(1);
    expect(rows[0]!.delivery_ms).toBe(42);
    expect(rows[0]!.delivery_error).toBeNull();
  });

  it("logNotification can create delivery_pending placeholder rows", () => {
    const id = store.logNotification({
      segment_id: "seg_pending",
      camera_id: "cam_pending",
      type: "alert",
      message: "Pending alert",
      policy: "smart",
      path: "direct",
      status: "delivery_pending",
    });

    const rows = store.getRecentNotifications("cam_pending");
    expect(id).toBeGreaterThan(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("delivery_pending");
    expect(rows[0]!.delivered).toBe(0);
    expect(rows[0]!.delivery_error).toBeNull();
    expect(rows[0]!.delivery_ms).toBeNull();
  });

  it("updateNotificationDelivery advances pending rows to failed", () => {
    const id = store.logNotification({
      segment_id: "seg_failed",
      camera_id: "cam_pending",
      type: "summary",
      message: "Pending summary",
      policy: "smart",
      path: "subagent",
      status: "delivery_pending",
    });

    store.updateNotificationDelivery(id, {
      delivered: false,
      delivery_error: "no sessionKey",
      delivery_ms: 12,
    });

    const rows = store.getRecentNotifications("cam_pending");
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.delivered).toBe(0);
    expect(rows[0]!.delivery_error).toBe("no sessionKey");
    expect(rows[0]!.delivery_ms).toBe(12);
  });

  it("updateNotificationDelivery advances pending rows to delivered", () => {
    const id = store.logNotification({
      segment_id: "seg_delivered",
      camera_id: "cam_pending",
      type: "identify",
      message: "Pending identify",
      policy: "smart",
      path: "subagent",
      status: "delivery_pending",
    });

    store.updateNotificationDelivery(id, {
      delivered: true,
      delivery_ms: 18,
    });

    const rows = store.getRecentNotifications("cam_pending");
    expect(rows[0]!.status).toBe("delivered");
    expect(rows[0]!.delivered).toBe(1);
    expect(rows[0]!.delivery_error).toBeNull();
    expect(rows[0]!.delivery_ms).toBe(18);
  });

  it("getRecentNotifications returns delivery fields for multiple entries", () => {
    store.logNotification({
      segment_id: "seg_a",
      camera_id: "cam_x",
      type: "alert",
      message: "msg1",
      policy: "smart",
      path: "direct",
      delivered: true,
      delivery_ms: 10,
    });
    store.logNotification({
      segment_id: "seg_b",
      camera_id: "cam_x",
      type: "summary",
      message: "msg2",
      policy: "smart",
      path: "subagent",
      delivered: false,
      delivery_error: "network error",
      delivery_ms: 500,
    });

    const rows = store.getRecentNotifications("cam_x");
    expect(rows).toHaveLength(2);

    // Most recent first
    const failed = rows.find((r) => r.segment_id === "seg_b")!;
    const success = rows.find((r) => r.segment_id === "seg_a")!;

    expect(failed.delivered).toBe(0);
    expect(failed.status).toBe("failed");
    expect(failed.delivery_error).toBe("network error");
    expect(success.delivered).toBe(1);
    expect(success.status).toBe("delivered");
    expect(success.delivery_error).toBeNull();
  });
});
