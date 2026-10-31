import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type SegmentFingerprint = {
  index: number;
  timestamp: number;
  duration_sec: number;
  event_hint: string | undefined;
  frame_count: number;
  frame_timestamps: number[];
  frame_hashes: string[];
  audio_pcm_bytes: number;
  voice_ranges: unknown[];
};

function usage(): never {
  console.error(
    "Usage: npx tsx scripts/benchmark-segment-fingerprint.ts <repo> <video> <out.json> [fps=2] [framesPerSegment=30] [maxDurationSec=60]",
  );
  process.exit(2);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function repoFile(repo: string, path: string): string {
  return pathToFileURL(join(repo, path)).href;
}

const [repoArg, videoArg, outArg, fpsArg, framesArg, maxDurationArg] = process.argv.slice(2);
if (!repoArg || !videoArg || !outArg) usage();

const repo = resolve(repoArg);
const videoPath = resolve(videoArg);
const outPath = resolve(outArg);
const fps = fpsArg ? Number(fpsArg) : 2;
const framesPerSegment = framesArg ? Number(framesArg) : 30;
const maxDurationSec = maxDurationArg ? Number(maxDurationArg) : 60;

if (!Number.isFinite(fps) || fps <= 0) usage();
if (!Number.isFinite(framesPerSegment) || framesPerSegment <= 0) usage();
if (!Number.isFinite(maxDurationSec) || maxDurationSec <= 0) usage();

async function main(): Promise<void> {
  const cam = await import(repoFile(repo, "packages/cam/index.ts"));
  const frameStream = await import(repoFile(repo, "eval/benchmark/pipeline/frame-stream.ts"));
  const frameExtractor = await import(repoFile(repo, "eval/benchmark/pipeline/frame-extractor.ts"));

  const {
    CamPipeline,
    CompositeSegmenter,
    MotionFilter,
    SileroVad,
    VAD_CHUNK_SIZE,
    getSileroVadModelPath,
    resolveFfmpegBin,
    resolveFfprobeBin,
  } = cam;
  const { streamFrames } = frameStream;
  const { extractAudio } = frameExtractor;

  const ffmpegBin = resolveFfmpegBin();
  const ffprobeBin = resolveFfprobeBin(undefined, ffmpegBin);
  const tempDir = mkdtempSync(join(tmpdir(), "reflectworld-benchmark-fingerprint-"));
  const audioPath = join(tempDir, "audio.pcm");
  const extractedAudio: { buffer: Buffer; startPtsMs: number } | null = await extractAudio(videoPath, audioPath, maxDurationSec, ffmpegBin, ffprobeBin);
  const audioBuffer = extractedAudio?.buffer ?? null;
  const audioStartPtsMs = extractedAudio?.startPtsMs ?? 0;
  const audioSamples = audioBuffer
    ? new Float32Array(audioBuffer.length / 2).map((_, i) => audioBuffer.readInt16LE(i * 2) / 32768)
    : null;

  let vad: any | null = null;
  if (audioBuffer) {
    const candidate = new SileroVad({ modelPath: getSileroVadModelPath(), minSilenceDuration: 0.05 });
    const ok = await candidate.init();
    vad = ok ? candidate : null;
  }

  const motionFilter = new MotionFilter();
  const segments: SegmentFingerprint[] = [];
  const camPipeline = new CamPipeline(
    {
      cameraId: "benchmark-fingerprint",
      mode: "stream",
      onSegment(segment: any) {
        segments.push({
          index: segments.length,
          timestamp: segment.timestamp,
          duration_sec: segment.duration_sec,
          event_hint: segment.event_hint,
          frame_count: segment.frames.length,
          frame_timestamps: segment.frames.map((frame: any) => frame.timestamp),
          frame_hashes: segment.frames.map((frame: any) => sha256(frame.data)),
          audio_pcm_bytes: segment.audio_data?.pcm?.length ?? 0,
          voice_ranges: segment.audio_data?.voice_ranges ?? [],
        });
      },
    },
    { segmenters: [new CompositeSegmenter({ maxFrames: framesPerSegment })] },
  );

  let audioSampleIndex = 0;
  let lastVoiceDetectTimeMs = -Infinity;
  const voiceRecencyMs = 2_000;
  let nextSampleTimeMs = 0;
  let streamedFrames = 0;
  let fedFrames = 0;

  for await (const { jpeg, timestampMs: frameTimeMs } of streamFrames(videoPath, fps, maxDurationSec, 1024, ffmpegBin, undefined, ffprobeBin)) {
    streamedFrames++;
    if (frameTimeMs < nextSampleTimeMs) continue;
    nextSampleTimeMs = frameTimeMs + 1000 / fps;

    if (vad && audioSamples && audioBuffer) {
      const targetSample = Math.floor(((frameTimeMs - audioStartPtsMs) / 1000) * 16000);
      while (audioSampleIndex + VAD_CHUNK_SIZE <= targetSample && audioSampleIndex + VAD_CHUNK_SIZE <= audioSamples.length) {
        const chunkTimeMs = audioStartPtsMs + (audioSampleIndex / 16000) * 1000;
        const chunk = audioSamples.subarray(audioSampleIndex, audioSampleIndex + VAD_CHUNK_SIZE);
        const vadResult = vad.feedChunk(chunk);
        if (vadResult.isSpeaking) lastVoiceDetectTimeMs = chunkTimeMs;
        const voiceSegs = vadResult.segments.map((s: any) => ({ start: s.start, length: s.samples.length }));
        const pcmChunkBuf = Buffer.from(audioBuffer.subarray(audioSampleIndex * 2, (audioSampleIndex + VAD_CHUNK_SIZE) * 2));
        camPipeline.ingestAudio(pcmChunkBuf, voiceSegs, vadResult.segments, vadResult.isSpeaking);
        camPipeline.updateVoiceState(vadResult.isSpeaking, chunkTimeMs);
        audioSampleIndex += VAD_CHUNK_SIZE;
      }
    }

    const latestHasVoice = frameTimeMs - lastVoiceDetectTimeMs < voiceRecencyMs;
    const motionResult = motionFilter.detectWithRatio(jpeg, frameTimeMs);
    await camPipeline.feedFrame(
      {
        data: jpeg.toString("base64"),
        timestamp: frameTimeMs,
        source_name: "benchmark",
      },
      {
        hasMotion: motionResult.motion,
        motionRatio: motionResult.ratio,
        hasVoice: latestHasVoice,
        hasEntity: false,
      },
    );
    fedFrames++;
  }

  if (vad && audioBuffer) {
    const remaining = vad.flush();
    const voiceSegs = remaining.map((s: any) => ({ start: s.start, length: s.samples.length }));
    const tailSampleStart = audioSampleIndex * 2;
    const tailPcm = tailSampleStart < audioBuffer.length
      ? Buffer.from(audioBuffer.subarray(tailSampleStart))
      : Buffer.alloc(0);
    if (tailPcm.length > 0 || voiceSegs.length > 0) {
      camPipeline.ingestAudio(tailPcm, voiceSegs, remaining);
    }
  }
  await camPipeline.forceFlush();

  const output = {
    repo,
    videoPath,
    fps,
    framesPerSegment,
    maxDurationSec,
    streamedFrames,
    fedFrames,
    audioBytes: audioBuffer?.length ?? 0,
    vadEnabled: Boolean(vad),
    segmentCount: segments.length,
    segments,
    hash: sha256(JSON.stringify(segments)),
  };

  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ outPath, segmentCount: segments.length, hash: output.hash }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
