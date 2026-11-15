import { describe, it, expect } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { CamToolSchema } from "../schema.js";

describe("CamToolSchema v3 actions", () => {
  it("validates set_sampling action", () => {
    expect(Value.Check(CamToolSchema, { action: "set_sampling", name: "cam1", fps: 5, width: 1920, height: 1080 })).toBe(true);
  });

  it("validates start_recording action", () => {
    expect(Value.Check(CamToolSchema, { action: "start_recording", name: "cam1" })).toBe(true);
  });

  it("validates stop_recording action", () => {
    expect(Value.Check(CamToolSchema, { action: "stop_recording", name: "cam1" })).toBe(true);
  });

  it("validates list_recordings action", () => {
    expect(Value.Check(CamToolSchema, { action: "list_recordings", name: "cam1" })).toBe(true);
  });
});
