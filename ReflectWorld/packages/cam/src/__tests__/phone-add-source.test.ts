import { describe, it, expect, vi } from "vitest";
import { executeCamAction, type CamToolDeps } from "../tool.js";
import type { SourceManager } from "../source-manager.js";
import type { Go2rtcManager } from "../go2rtc-manager.js";
import type { RecordManager } from "../record-manager.js";
import type { FrameExtractor } from "../frame-extractor.js";

// Mock clawcam CLI
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn((_cmd: string, args: string[]) => {
    if (args[0] === "--version") return Buffer.from("1.0.0\n");
    if (args[0] === "setup") {
      return Buffer.from(JSON.stringify({
        device: "my-phone",
        nodeId: "abc123",
        securityKey: "key456",
        server: "https://rtc.reflect.world",
        nodeUrl: "https://rtc.reflect.world/node/abc123#key456",
      }));
    }
    return Buffer.from("");
  }),
  execFile: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => "{}"),
  unlinkSync: vi.fn(),
}));

const mockGo2rtc = {
  addStream: vi.fn().mockResolvedValue(undefined),
  removeStream: vi.fn().mockResolvedValue(undefined),
  captureFrame: vi.fn().mockResolvedValue(Buffer.from([0xff, 0xd8])),
} as unknown as Go2rtcManager;

const mockRecordManager = {
  startRecording: vi.fn(),
  stopRecording: vi.fn().mockReturnValue(true),
  listRecordings: vi.fn().mockReturnValue([]),
} as unknown as RecordManager;

const mockFrameExtractor = {
  startExtraction: vi.fn(),
  stopExtraction: vi.fn().mockReturnValue(true),
  isExtracting: vi.fn().mockReturnValue(false),
} as unknown as FrameExtractor;

describe("add_source phone", () => {
  it("returns nodeUrl when adding a phone source", async () => {
    const mockManager = {
      addSource: vi.fn().mockReturnValue({
        name: "my-phone",
        input: "phone",
        protocol: "phone",
        created_at: Date.now(),
      }),
      getSource: vi.fn().mockReturnValue(null),
      resolveId: vi.fn().mockReturnValue(null),
    } as unknown as SourceManager;

    const result = await executeCamAction(
      "add_source",
      { source: "phone", name: "my-phone" },
      { sourceManager: mockManager, go2rtc: mockGo2rtc, recordManager: mockRecordManager, frameExtractor: mockFrameExtractor },
    );

    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.phone_setup).toBeDefined();
    expect(parsed.phone_setup.nodeUrl).toContain("rtc.reflect.world");
  });
});
