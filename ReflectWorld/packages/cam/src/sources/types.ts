import type { FrameResult, SnapshotOptions } from "../types.js";

/** Unified source interface — all source implementations must satisfy this. */
export interface Source {
  readonly name: string;
  snapshot(options?: SnapshotOptions): Promise<FrameResult>;
}
