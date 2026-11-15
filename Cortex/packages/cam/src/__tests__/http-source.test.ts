import { describe, it, expect, vi } from "vitest";
import { HTTPSource } from "../sources/http.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("HTTPSource", () => {
  it("fetches JPEG and returns base64", async () => {
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeJpeg.buffer),
    });

    const source = new HTTPSource("webcam_jpg", "https://example.com/cam.jpg");
    const result = await source.snapshot();

    expect(result.source_name).toBe("webcam_jpg");
    expect(result.data).toBeTruthy();
    expect(mockFetch).toHaveBeenCalledWith("https://example.com/cam.jpg", expect.any(Object));
  });

  it("throws on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, statusText: "Not Found" });

    const source = new HTTPSource("bad", "https://example.com/404.jpg");
    await expect(source.snapshot()).rejects.toThrow("HTTP 404");
  });
});
