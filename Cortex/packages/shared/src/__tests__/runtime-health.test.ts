import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeHealthReporter,
  subscribeRuntimeHealth,
} from "../runtime-health.js";

describe("runtime health reporter", () => {
  it("delivers ordered observations while a Dashboard observer is installed", async () => {
    const observer = vi.fn();
    const unsubscribe = subscribeRuntimeHealth(observer);
    const reporter = createRuntimeHealthReporter("test");

    reporter.observe({ component: "memory_search", operation: "search", status: "down", code: "request_failed" });
    reporter.observe({ component: "memory_search", operation: "search", status: "ok" });
    await Promise.resolve();

    expect(observer).toHaveBeenCalledTimes(2);
    expect(observer.mock.calls[0]![0]).toMatchObject({ producer: "test", sequence: 1, status: "down" });
    expect(observer.mock.calls[1]![0]).toMatchObject({ producer: "test", sequence: 2, status: "ok" });
    unsubscribe();
  });

  it("does not let observer failures escape into the observed operation", async () => {
    const unsubscribe = subscribeRuntimeHealth(() => { throw new Error("observer failed"); });
    const reporter = createRuntimeHealthReporter("test");

    expect(() => reporter.observe({ component: "vlm", operation: "analyze", status: "down" })).not.toThrow();
    await Promise.resolve();
    unsubscribe();
  });

  it("does no queued work while no Dashboard observer is installed", async () => {
    const reporter = createRuntimeHealthReporter("test");
    reporter.observe({ component: "vlm", operation: "analyze", status: "down" });

    const observer = vi.fn();
    const unsubscribe = subscribeRuntimeHealth(observer);
    reporter.observe({ component: "vlm", operation: "analyze", status: "ok" });
    await Promise.resolve();

    expect(observer).toHaveBeenCalledOnce();
    expect(observer.mock.calls[0]![0]).toMatchObject({ sequence: 1, status: "ok" });
    unsubscribe();
  });
});
