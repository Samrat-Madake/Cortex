import { describe, it, expect } from "vitest";
import type { Source } from "../sources/types.js";
import { FFmpegSource } from "../sources/ffmpeg.js";
import { HTTPSource } from "../sources/http.js";
import { PhoneSource } from "../sources/phone.js";

describe("Source interface", () => {
  it("FFmpegSource satisfies Source interface", () => {
    const source: Source = new FFmpegSource("test", "rtsp://localhost/stream");
    expect(source.name).toBe("test");
    expect(typeof source.snapshot).toBe("function");
  });

  it("HTTPSource satisfies Source interface", () => {
    const source: Source = new HTTPSource("test", "https://example.com/cam.jpg");
    expect(source.name).toBe("test");
    expect(typeof source.snapshot).toBe("function");
  });

  it("PhoneSource satisfies Source interface", () => {
    const source: Source = new PhoneSource("test-phone");
    expect(source.name).toBe("test-phone");
    expect(typeof source.snapshot).toBe("function");
  });
});
