import { execFile } from "node:child_process";
import { platform } from "node:os";
import type { FrameResult, SnapshotOptions } from "../types.js";
import { splitJpegFrames } from "../frame-extractor.js";
import { resolveFfmpegBin } from "../binary-installer.js";

interface RecordOptions {
  fps?: number;
  resolution?: { width: number; height: number };
  max_frames?: number;
}

interface RecordResult {
  frames: FrameResult[];
  duration_sec: number;
  source_name: string;
}

/** FFmpeg-based video source supporting RTSP, file, webcam, USB, and HLS inputs. */
export class FFmpegSource {
  constructor(
    public readonly name: string,
    public readonly input: string,
  ) {}

  /** Build ffmpeg input args based on the input type. */
  private buildInputArgs(): string[] {
    const args: string[] = [];

    if (this.input === "webcam" || this.input.startsWith("usb:")) {
      const os = platform();
      const deviceIndex = this.input.startsWith("usb:")
        ? this.input.split(":")[1]
        : "0";

      if (os === "darwin") {
        args.push("-f", "avfoundation", "-i", `${deviceIndex}:none`);
      } else {
        args.push("-f", "v4l2", "-i", `/dev/video${deviceIndex}`);
      }
    } else {
      args.push("-i", this.input);
    }

    return args;
  }

  /** Build ffmpeg CLI arguments for a single-frame snapshot. */
  buildSnapshotArgs(options?: SnapshotOptions): string[] {
    const args = this.buildInputArgs();

    // Single frame
    args.push("-frames:v", "1");

    // Resolution — aspect-preserving letterbox (see frame-extractor.ts comment)
    if (options?.resolution) {
      const w = options.resolution.width;
      const h = options.resolution.height;
      args.push("-vf", `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`);
    }

    // Quality
    const q = options?.quality ?? 85;
    args.push("-q:v", String(Math.round((100 - q) / 3.3)));

    // Output to stdout as JPEG
    args.push("-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1");

    return args;
  }

  /** Capture a single frame as base64 JPEG. */
  snapshot(options?: SnapshotOptions): Promise<FrameResult> {
    const args = this.buildSnapshotArgs(options);

    return new Promise((resolve, reject) => {
      execFile(resolveFfmpegBin(), args, { encoding: "buffer", maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err) {
          reject(new Error(`ffmpeg snapshot failed for ${this.name}: ${err.message}`));
          return;
        }
        resolve({
          data: (stdout as unknown as Buffer).toString("base64"),
          timestamp: Date.now(),
          source_name: this.name,
        });
      });
    });
  }

  /** Build ffmpeg CLI arguments for multi-frame recording. */
  buildRecordArgs(durationSec: number, options?: RecordOptions): string[] {
    const args = this.buildInputArgs();

    args.push("-t", String(durationSec));

    if (options?.fps) {
      args.push("-r", String(options.fps));
    }

    if (options?.resolution) {
      const w = options.resolution.width;
      const h = options.resolution.height;
      args.push("-vf", `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`);
    }

    // Output frames as JPEG sequence to stdout
    args.push("-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1");

    return args;
  }

  /** Record multiple frames over a duration period. */
  record(durationSec: number, options?: RecordOptions): Promise<RecordResult> {
    const args = this.buildRecordArgs(durationSec, options);

    return new Promise((resolve, reject) => {
      execFile(
        resolveFfmpegBin(),
        args,
        { encoding: "buffer", maxBuffer: 100 * 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            reject(new Error(`ffmpeg record failed for ${this.name}: ${err.message}`));
            return;
          }

          const fps = options?.fps ?? 30;
          const intervalMs = Math.round(1000 / Math.max(1, fps));
          const startTs = Date.now();
          const frames = splitJpegFrames(stdout as unknown as Buffer).map((buf, idx) => ({
            data: buf.toString("base64"),
            timestamp: startTs + idx * intervalMs,
            source_name: this.name,
          }));
          resolve({
            frames,
            duration_sec: durationSec,
            source_name: this.name,
          });
        },
      );
    });
  }
}
