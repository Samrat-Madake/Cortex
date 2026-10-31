import { describe, it, expect, beforeEach, vi } from "vitest";
import { SourceManager } from "../source-manager.js";

// Mock fs for persistence
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  unlinkSync: vi.fn(),
}));

describe("SourceManager", () => {
  let mgr: SourceManager;

  beforeEach(() => {
    mgr = new SourceManager("/tmp/test-sources");
  });

  it("adds a source with auto-detected protocol", () => {
    const cfg = mgr.addSource("rtsp://192.168.1.100/stream", "front_door");
    expect(cfg.id).toBe("front_door");
    expect(cfg.name).toBe("front_door");
    expect(cfg.protocol).toBe("ffmpeg");
  });

  it("generates ASCII-safe id from unicode name", () => {
    const unicodeName = "\u{1F4F7}";
    const cfg = mgr.addSource("rtsp://192.168.1.100/stream", unicodeName);
    expect(cfg.name).toBe(unicodeName);
    expect(cfg.id).toMatch(/^cam_\d+$/);
    expect(mgr.getSource(unicodeName)).toBe(cfg);
    expect(mgr.getSource(cfg.id)).toBe(cfg);
  });

  it("resolveId finds by name or id", () => {
    const cfg = mgr.addSource("rtsp://192.168.1.100/stream", "my cam");
    expect(mgr.resolveId("my cam")).toBe(cfg.id);
    expect(mgr.resolveId(cfg.id)).toBe(cfg.id);
    expect(mgr.resolveId("nope")).toBeNull();
  });

  it("auto-generates name if not provided", () => {
    const cfg = mgr.addSource("rtsp://192.168.1.100/stream");
    expect(cfg.name).toMatch(/^source_/);
  });

  it("lists all sources", () => {
    mgr.addSource("rtsp://192.168.1.100/stream", "cam1");
    mgr.addSource("https://example.com/cam.jpg", "cam2");
    const list = mgr.listSources();
    expect(list).toHaveLength(2);
  });

  it("removes a source", () => {
    mgr.addSource("rtsp://192.168.1.100/stream", "cam1");
    mgr.removeSource("cam1");
    expect(mgr.listSources()).toHaveLength(0);
  });

  it("throws on duplicate name", () => {
    mgr.addSource("rtsp://192.168.1.100/stream", "cam1");
    expect(() => mgr.addSource("rtsp://192.168.1.200/stream", "cam1")).toThrow("already exists");
  });

  it("gets source by name", () => {
    mgr.addSource("rtsp://192.168.1.100/stream", "cam1");
    const cfg = mgr.getSource("cam1");
    expect(cfg).toBeTruthy();
    expect(cfg!.input).toBe("rtsp://192.168.1.100/stream");
  });

  it("returns null for unknown source", () => {
    expect(mgr.getSource("nonexistent")).toBeNull();
  });
});
