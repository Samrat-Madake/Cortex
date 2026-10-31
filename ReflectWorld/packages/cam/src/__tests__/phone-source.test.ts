import { describe, it, expect, vi, beforeEach } from "vitest";
import { PhoneSource, checkClawcamInstalled } from "../sources/phone.js";

// Mock child_process
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn((_cmd: string, args: string[]) => {
    // Mock "clawcam --version"
    if (args[0] === "--version") return Buffer.from("1.0.0\n");
    // Mock "clawcam setup"
    if (args[0] === "setup") {
      return Buffer.from(JSON.stringify({
        device: "test-phone",
        nodeId: "abc123",
        securityKey: "key456",
        server: "https://rtc.reflect.world",
        nodeUrl: "https://rtc.reflect.world/node/abc123#key456",
      }));
    }
    // Mock "clawcam device list"
    if (args[0] === "device" && args[1] === "list") {
      return Buffer.from(JSON.stringify([{ name: "test-phone", nodeId: "abc123" }]));
    }
    return Buffer.from("");
  }),
  execFile: vi.fn((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
    // Mock "clawcam snapshot"
    if (args[0] === "snapshot") {
      const outputIdx = args.indexOf("-o");
      const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : "/tmp/snap.jpg";
      cb(null, Buffer.from(outputPath + "\n"), "");
    }
  }),
}));

// Mock fs.readFileSync for reading snapshot JPEG
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])),
  existsSync: vi.fn(() => true),
}));

describe("checkClawcamInstalled", () => {
  it("returns true when clawcam is available", () => {
    expect(checkClawcamInstalled()).toBe(true);
  });
});

describe("PhoneSource", () => {
  let source: PhoneSource;

  beforeEach(() => {
    source = new PhoneSource("my-phone");
  });

  it("has correct name and protocol", () => {
    expect(source.name).toBe("my-phone");
  });

  it("creates device and returns setup info", () => {
    const info = source.createDevice();
    expect(info.nodeUrl).toContain("rtc.reflect.world");
    expect(info.nodeId).toBe("abc123");
  });

  it("snapshot returns FrameResult with base64 data", async () => {
    const result = await source.snapshot();
    expect(result.source_name).toBe("my-phone");
    expect(result.data).toBeTruthy();
    expect(result.timestamp).toBeGreaterThan(0);
  });
});
