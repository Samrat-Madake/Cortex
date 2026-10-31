import { describe, expect, it } from "vitest";
import { MODELS, resolveModelPlan } from "../manifest.js";

const names = (level: number, env: NodeJS.ProcessEnv = {}): string[] =>
  resolveModelPlan(level, env).map((m) => m.filename);

describe("resolveModelPlan — level gating", () => {
  it("Level 0 installs only the always-on model", () => {
    expect(names(0)).toEqual(["silero_vad.onnx"]);
  });

  it("Level 1 adds the required L1 perception models, not the optional body models", () => {
    const plan = names(1);
    expect(plan).toContain("silero_vad.onnx");
    expect(plan).toContain("yolo26m.onnx");
    expect(plan).toContain("retinaface-resnet50.onnx");
    expect(plan).toContain("w600k_mbf.onnx");
    // Optional body models (level 1 + gatedBy) must NOT be included without their gate
    expect(plan).not.toContain("clip-reid-vitb.onnx");
    expect(plan).not.toContain("rtmpose-s.onnx");
  });

  it("optional (gated) models are never selected by level alone", () => {
    for (const level of [0, 1, 2]) {
      expect(names(level)).not.toContain("clip-reid-vitb.onnx");
      expect(names(level)).not.toContain("rtmpose-s.onnx");
    }
  });
});

describe("resolveModelPlan — conditional gates", () => {
  it("body-reid gate pulls in clip-reid and rtmpose when enabled", () => {
    const plan = names(1, { REFLECTWORLD_BODY_REID_ENABLED: "true" });
    expect(plan).toContain("clip-reid-vitb.onnx");
    expect(plan).toContain("rtmpose-s.onnx");
  });

  it("body-reid models stay out when the gate value is not exactly 'true'", () => {
    expect(names(1, { REFLECTWORLD_BODY_REID_ENABLED: "false" })).not.toContain("clip-reid-vitb.onnx");
    expect(names(1, { REFLECTWORLD_BODY_REID_ENABLED: "1" })).not.toContain("clip-reid-vitb.onnx");
    expect(names(1, {})).not.toContain("rtmpose-s.onnx");
  });

  it("body-reid gate does NOT pull optional models into Level 0 (no L0 pollution)", () => {
    // Optional body models sit at level 1 with a gate, so a Level-0 install stays clean
    // even when the body-reid toggle is on — matching the L0 "no extra download" promise.
    const plan = names(0, { REFLECTWORLD_BODY_REID_ENABLED: "true" });
    expect(plan).toEqual(["silero_vad.onnx"]);
    expect(plan).not.toContain("clip-reid-vitb.onnx");
    expect(plan).not.toContain("rtmpose-s.onnx");
    expect(plan).not.toContain("yolo26m.onnx");
  });
});

describe("restricted models require license acceptance", () => {
  it("every AGPL / non-commercial model carries a license string", () => {
    const restricted = ["yolo26m.onnx", "retinaface-resnet50.onnx", "w600k_mbf.onnx", "clip-reid-vitb.onnx", "rtmpose-s.onnx"];
    for (const f of restricted) {
      const m = MODELS.find((x) => x.filename === f)!;
      expect(m.license, `${f} must declare a license (gates acceptance)`).toBeTruthy();
    }
  });

  it("license-clean models (MIT direct download) carry no license gate", () => {
    const silero = MODELS.find((x) => x.filename === "silero_vad.onnx")!;
    expect(silero.license).toBeUndefined();
  });
});

describe("model acquisition recipes are well-formed", () => {
  it("every model has exactly one acquisition method (url | archive | convert)", () => {
    for (const m of MODELS) {
      const methods = [m.url, m.archive, m.convert].filter(Boolean).length;
      expect(methods, `${m.filename} must have exactly one acquisition method`).toBe(1);
    }
  });

  it("convert recipes carry a script, weightFile, and exactly one weight source", () => {
    for (const m of MODELS) {
      if (!m.convert) continue;
      expect(m.convert.script, `${m.filename} convert.script`).toMatch(/^export_.*\.py$/);
      expect(m.convert.weightFile, `${m.filename} convert.weightFile`).toBeTruthy();
      expect(m.license, `${m.filename} must declare a license`).toBeTruthy();
      const sources = [m.convert.ultralytics, m.convert.gdriveId].filter(Boolean).length;
      expect(sources, `${m.filename} needs exactly one weight source`).toBe(1);
    }
  });

  it("archive recipes carry a url and a member path", () => {
    for (const m of MODELS) {
      if (!m.archive) continue;
      expect(m.archive.url, `${m.filename} archive.url`).toMatch(/^https?:\/\//);
      expect(m.archive.member, `${m.filename} archive.member`).toBeTruthy();
    }
  });

  it("gated models declare an env condition", () => {
    for (const m of MODELS) {
      if (!m.gatedBy) continue;
      expect(m.gatedBy.env).toBeTruthy();
      expect(m.gatedBy.equals).toBeTruthy();
    }
  });

  it("filenames are unique", () => {
    const files = MODELS.map((m) => m.filename);
    expect(new Set(files).size).toBe(files.length);
  });
});
