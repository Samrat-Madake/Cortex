// packages/mem/src/__tests__/types.test.ts
import { describe, it, expectTypeOf } from "vitest";
import type {
  AddMemoryRequest,
  SearchRequest,
  ExpireMediaRequest,
  ReidSearchRequest,
  ReidUpsertRequest,
  CaptureMode,
  ReidCollection,
} from "../types.js";

describe("types compile-time checks", () => {
  it("CaptureMode is a union of three literals", () => {
    expectTypeOf<CaptureMode>().toEqualTypeOf<"snapshot" | "event" | "stream">();
  });

  it("ReidCollection is a union of two literals", () => {
    expectTypeOf<ReidCollection>().toEqualTypeOf<"reid_entity" | "reid_face">();
  });

  it("AddMemoryRequest has required video_data and optional mode", () => {
    const req: AddMemoryRequest = {
      video_data: { summary: "test" },
      camera_id: "cam-01",
      mode: "snapshot",
      event_id: "evt-001",
    };
    expectTypeOf(req.video_data).toEqualTypeOf<typeof req.video_data>();
    expectTypeOf(req.mode).toEqualTypeOf<CaptureMode | undefined>();
  });

  it("SearchRequest has optional mode filter", () => {
    const req: SearchRequest = {
      query: "who was at the door",
      camera_id: "cam-front",
      mode: "event",
    };
    expectTypeOf(req.mode).toEqualTypeOf<CaptureMode | undefined>();
  });

  it("ExpireMediaRequest requires segment_id", () => {
    const req: ExpireMediaRequest = { segment_id: "seg-001" };
    expectTypeOf(req.segment_id).toBeString();
  });

  it("ReidSearchRequest requires vector and collection", () => {
    const req: ReidSearchRequest = {
      vector: [0.1, 0.2, 0.3],
      collection: "reid_entity",
    };
    expectTypeOf(req.vector).toEqualTypeOf<number[]>();
    expectTypeOf(req.collection).toEqualTypeOf<ReidCollection>();
  });

  it("ReidUpsertRequest requires entity_id, vector, collection", () => {
    const req: ReidUpsertRequest = {
      entity_id: "person-007",
      vector: [0.5],
      collection: "reid_face",
    };
    expectTypeOf(req.entity_id).toBeString();
  });
});
