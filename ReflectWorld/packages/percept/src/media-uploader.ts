// packages/percept/src/media-uploader.ts
import type { MediaUrls } from "@reflectworld/shared";

/**
 * Abstraction for saving perception media artefacts (keyframes, GIF, crops).
 *
 * In production, backed by PipelineStore (local files + SQLite).
 * The interface is kept simple so tests can provide a mock.
 */
export interface MediaSaver {
  saveMedia(
    cameraId: string,
    segmentId: string,
    mediaType: "raw" | "keyframe" | "gif" | "crop",
    data: Buffer,
    suffix?: string,
  ): string;
}

/**
 * Uploads perception media artefacts to local storage via MediaSaver.
 *
 * File layout (managed by PipelineStore):
 *   {mediaDir}/{cameraId}/keyframe/{segmentId}_{index}.jpg
 *   {mediaDir}/{cameraId}/gif/{segmentId}.gif
 *   {mediaDir}/{cameraId}/crop/{segmentId}_{entityId}.jpg
 */
export class MediaUploader {
  private saver: MediaSaver;

  constructor(saver: MediaSaver) {
    this.saver = saver;
  }

  /** Save a keyframe JPEG. Returns the local file path. */
  saveKeyframe(
    cameraId: string,
    segmentId: string,
    frameIndex: number,
    buffer: Buffer,
  ): string {
    return this.saver.saveMedia(cameraId, segmentId, "keyframe", buffer, String(frameIndex));
  }

  /** Save a GIF. Returns the local file path. */
  saveGif(cameraId: string, segmentId: string, buffer: Buffer): string {
    return this.saver.saveMedia(cameraId, segmentId, "gif", buffer);
  }

  /** Save an entity crop JPEG. Returns the local file path. */
  saveCrop(
    cameraId: string,
    segmentId: string,
    entityId: string,
    buffer: Buffer,
  ): string {
    return this.saver.saveMedia(cameraId, segmentId, "crop", buffer, entityId);
  }

  /**
   * Builds a MediaUrls object from individual paths.
   */
  static buildMediaUrls(options: {
    rawPath: string;
    gifPath?: string;
    keyframePaths?: string[];
    cropPaths?: string[];
  }): MediaUrls {
    return {
      raw: options.rawPath,
      gif: options.gifPath,
      keyframes: options.keyframePaths ?? [],
      crops: options.cropPaths ?? [],
    };
  }
}
