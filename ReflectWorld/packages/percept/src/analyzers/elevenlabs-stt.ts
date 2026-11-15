/**
 * ElevenLabs STT provider — cloud-based speech-to-text with speaker diarization.
 *
 * Calls the ElevenLabs Scribe API (POST /v1/speech-to-text) with diarize=true
 * with word-level timestamps. Voice ranges are merged into one continuous audio
 * window and response timestamps are remapped onto the original segment
 * timeline.
 *
 * Uses the built-in `fetch` API (Node 18+). No additional HTTP dependencies.
 */

import type { SttOutput } from "../types.js";
import type { AudioData } from "@cortex/shared";

// ── Public interface ──

export interface ElevenLabsSttOptions {
  /** ElevenLabs API key. */
  apiKey: string;
  /** Model identifier. Default: "scribe_v1". */
  modelId?: string;
  /** Optional language code (e.g. "en"). Empty/undefined lets ElevenLabs auto-detect. */
  languageCode?: string;
  /** Request timeout in ms. Default: 60_000. */
  timeoutMs?: number;
}

export class ElevenLabsStt {
  private readonly apiKey: string;
  private readonly modelId: string;
  private readonly languageCode?: string;
  private readonly timeoutMs: number;
  private static readonly BASE_URL = "https://api.elevenlabs.io/v1/speech-to-text";

  constructor(options: ElevenLabsSttOptions) {
    this.apiKey = options.apiKey;
    this.modelId = options.modelId ?? "scribe_v1";
    this.languageCode = options.languageCode?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  /**
   * Transcribe raw PCM audio (s16le, 16 kHz mono) with speaker diarization.
   * Wraps the PCM buffer in a minimal WAV header before uploading.
   */
  async transcribe(audioBuffer: Buffer, sampleRate: number = 16000): Promise<SttOutput> {
    const wavBuffer = wrapPcmAsWav(audioBuffer, sampleRate, 1);
    return this.transcribeWav(wavBuffer);
  }

  /**
   * Transcribe from AudioData (continuous PCM with voice ranges).
   * Merges all voice ranges into one continuous audio window and remaps
   * response timestamps back to the segment-local audio timeline.
   */
  async transcribeAudioData(audioData: AudioData): Promise<SttOutput> {
    const window = mergedVoiceWindow(audioData.voice_ranges);
    if (!window) {
      return { transcript: "", segments: [] };
    }
    const pcmSlice = slicePcmRange(audioData.pcm, window.startMs, window.endMs);
    if (pcmSlice.length < MIN_AUDIO_BYTES) {
      return { transcript: "", segments: [] };
    }
    const wavBuffer = wrapPcmAsWav(pcmSlice, SAMPLE_RATE, 1);
    return this.transcribeWav(wavBuffer, {
      offsetMs: window.startMs,
      fallbackStartMs: window.startMs,
      fallbackEndMs: window.endMs,
    });
  }

  // ── Private ──

  private async transcribeWav(
    wavBuffer: Buffer,
    timing: {
      offsetMs?: number;
      fallbackStartMs?: number;
      fallbackEndMs?: number;
    } = {},
  ): Promise<SttOutput> {
    const formBoundary = `----ElevenLabsBoundary${Date.now()}`;
    const formBody = buildMultipartBody(
      formBoundary,
      wavBuffer,
      this.modelId,
      this.languageCode,
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(ElevenLabsStt.BASE_URL, {
        method: "POST",
        headers: {
          "xi-api-key": this.apiKey,
          "Content-Type": `multipart/form-data; boundary=${formBoundary}`,
        },
        body: formBody,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "(no body)");
      throw new Error(
        `ElevenLabs STT API error: status=${response.status} body=${errorText.slice(0, 500)}`,
      );
    }

    const result: ElevenLabsResponse = await response.json() as ElevenLabsResponse;
    return formatDialogueToSttOutput(result, timing);
  }
}

// ── ElevenLabs response types ──

interface ElevenLabsWord {
  text: string;
  /** Word type: "word" or "spacing". */
  type?: string;
  /** Speaker ID from diarization (e.g. "speaker_0"). */
  speaker_id?: string;
  /** Start time in seconds. */
  start?: number;
  /** End time in seconds. */
  end?: number;
}

interface ElevenLabsSegment {
  text?: string;
  speaker_id?: string;
  speaker?: string;
  start?: number;
  end?: number;
}

interface ElevenLabsResponse {
  text?: string;
  segments?: ElevenLabsSegment[];
  words?: ElevenLabsWord[];
  language_code?: string;
  language_probability?: number;
}

// ── Dialogue formatting — ported from Python _format_dialogue_with_timestamps ──

/** Time gap threshold (seconds) that forces a new dialogue line. */
const NEW_LINE_GAP_SEC = 2.0;
/** Sample rate for converting seconds → sample indices in SttOutput. */
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const MIN_AUDIO_MS = 100;
const MIN_AUDIO_BYTES = Math.ceil(MIN_AUDIO_MS / 1000 * SAMPLE_RATE) * BYTES_PER_SAMPLE;

interface DialogueLine {
  speaker: string;
  text: string;
  startTime: number;
  endTime: number;
}

/**
 * Group words by speaker and time proximity, producing dialogue lines.
 * Faithfully ports the Python `_format_dialogue_with_timestamps` logic:
 * - Skip spacing words (type === "spacing"); insert a space in current text.
 * - Start a new line when speaker changes or time gap > 2 s.
 */
function groupWordsIntoLines(words: ElevenLabsWord[]): DialogueLine[] {
  const lines: DialogueLine[] = [];
  let currentSpeaker: string | undefined;
  let currentText = "";
  let currentStart: number | undefined;
  let currentEnd: number | undefined;

  for (const word of words) {
    if (word.type === "spacing") {
      if (currentText) {
        currentText += " ";
      }
      continue;
    }

    const wordText = word.text ?? "";
    const speakerId = word.speaker_id ?? "unknown";
    const start = word.start ?? 0;
    const end = word.end ?? 0;

    const speakerChanged = currentSpeaker !== speakerId;
    const gapExceeded =
      currentStart !== undefined &&
      currentEnd !== undefined &&
      start - currentEnd > NEW_LINE_GAP_SEC;

    if (speakerChanged || gapExceeded) {
      // Flush current line
      if (currentSpeaker !== undefined && currentText.trim()) {
        lines.push({
          speaker: currentSpeaker,
          text: currentText.trim(),
          startTime: currentStart!,
          endTime: currentEnd!,
        });
      }
      // Start new line
      currentSpeaker = speakerId;
      currentText = wordText;
      currentStart = start;
      currentEnd = end;
    } else {
      // Continue current line
      currentText += wordText;
      currentEnd = end;
    }
  }

  // Flush last line
  if (currentSpeaker !== undefined && currentText.trim()) {
    lines.push({
      speaker: currentSpeaker,
      text: currentText.trim(),
      startTime: currentStart!,
      endTime: currentEnd!,
    });
  }

  return lines;
}

/**
 * Convert ElevenLabs API response into our SttOutput format.
 * Each dialogue line becomes one SttOutput segment with speaker ID populated.
 */
function formatDialogueToSttOutput(
  result: ElevenLabsResponse,
  timing: {
    offsetMs?: number;
    fallbackStartMs?: number;
    fallbackEndMs?: number;
  } = {},
): SttOutput {
  const offsetSec = (timing.offsetMs ?? 0) / 1000;
  if (result.segments?.length) {
    const segments: SttOutput["segments"] = [];
    for (const segment of result.segments) {
      const text = segment.text?.trim();
      if (!text) continue;
      const startSec = offsetSec + (segment.start ?? 0);
      const endSec = offsetSec + (segment.end ?? segment.start ?? 0);
      segments.push({
        start: Math.round(startSec * SAMPLE_RATE),
        end: Math.round(endSec * SAMPLE_RATE),
        text,
        speaker: segment.speaker_id ?? segment.speaker,
        latency_ms: 0,
      });
    }
    return {
      transcript: segments.map((segment) => segment.text).join(" "),
      segments,
    };
  }

  if (!result.words?.length) {
    const text = result.text?.trim() ?? "";
    return {
      transcript: text,
      segments: text && timing.fallbackStartMs !== undefined && timing.fallbackEndMs !== undefined
        ? [{
            start: Math.round(timing.fallbackStartMs / 1000 * SAMPLE_RATE),
            end: Math.round(timing.fallbackEndMs / 1000 * SAMPLE_RATE),
            text,
            latency_ms: 0,
          }]
        : [],
    };
  }

  const lines = groupWordsIntoLines(result.words);
  const segments: SttOutput["segments"] = lines.map((line) => ({
    start: Math.round((offsetSec + line.startTime) * SAMPLE_RATE),
    end: Math.round((offsetSec + line.endTime) * SAMPLE_RATE),
    text: line.text,
    speaker: line.speaker,
    latency_ms: 0, // API latency tracked at call level, not per-segment
  }));

  const transcript = lines.map((l) => l.text).join(" ");
  return { transcript, segments };
}

// ── WAV header helper ──

/**
 * Wrap raw PCM (s16le) data in a minimal 44-byte WAV header.
 * ElevenLabs API expects a WAV file upload, not bare PCM.
 */
export function wrapPcmAsWav(
  pcm: Buffer,
  sampleRate: number = 16000,
  channels: number = 1,
): Buffer {
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;
  const headerSize = 44;

  const header = Buffer.alloc(headerSize);
  // RIFF header
  header.write("RIFF", 0);
  header.writeUInt32LE(headerSize - 8 + dataSize, 4); // file size - 8
  header.write("WAVE", 8);
  // fmt sub-chunk
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // sub-chunk size (PCM = 16)
  header.writeUInt16LE(1, 20); // audio format (1 = PCM)
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  // data sub-chunk
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

// ── Multipart form-data builder (no external deps) ──

/**
 * Build a multipart/form-data body buffer for the ElevenLabs API.
 * Fields: file (WAV blob), model_id, optional language_code, diarize=true, timestamps_granularity=word.
 */
function buildMultipartBody(
  boundary: string,
  wavBuffer: Buffer,
  modelId: string,
  languageCode?: string,
): Buffer {
  const crlf = "\r\n";
  const parts: Buffer[] = [];

  // File field
  parts.push(
    Buffer.from(
      `--${boundary}${crlf}` +
      `Content-Disposition: form-data; name="file"; filename="audio.wav"${crlf}` +
      `Content-Type: audio/wav${crlf}${crlf}`,
    ),
  );
  parts.push(wavBuffer);
  parts.push(Buffer.from(crlf));

  // model_id field
  parts.push(
    Buffer.from(
      `--${boundary}${crlf}` +
      `Content-Disposition: form-data; name="model_id"${crlf}${crlf}` +
      `${modelId}${crlf}`,
    ),
  );

  if (languageCode) {
    parts.push(
      Buffer.from(
        `--${boundary}${crlf}` +
        `Content-Disposition: form-data; name="language_code"${crlf}${crlf}` +
        `${languageCode}${crlf}`,
      ),
    );
  }

  // diarize field
  parts.push(
    Buffer.from(
      `--${boundary}${crlf}` +
      `Content-Disposition: form-data; name="diarize"${crlf}${crlf}` +
      `true${crlf}`,
    ),
  );

  // timestamps_granularity field
  parts.push(
    Buffer.from(
      `--${boundary}${crlf}` +
      `Content-Disposition: form-data; name="timestamps_granularity"${crlf}${crlf}` +
      `word${crlf}`,
    ),
  );

  // Closing boundary
  parts.push(Buffer.from(`--${boundary}--${crlf}`));

  return Buffer.concat(parts);
}

function mergedVoiceWindow(ranges: AudioData["voice_ranges"]): { startMs: number; endMs: number } | undefined {
  if (!ranges.length) return undefined;
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = 0;
  for (const range of ranges) {
    startMs = Math.min(startMs, Math.max(0, range.start_ms));
    endMs = Math.max(endMs, Math.max(0, range.end_ms));
  }
  if (!Number.isFinite(startMs) || endMs <= startMs) return undefined;
  return { startMs, endMs };
}

function slicePcmRange(pcm: Buffer, startMs: number, endMs: number): Buffer {
  const startByte = Math.min(
    pcm.length,
    Math.floor(startMs / 1000 * SAMPLE_RATE) * BYTES_PER_SAMPLE,
  );
  const endByte = Math.min(
    pcm.length,
    Math.ceil(endMs / 1000 * SAMPLE_RATE) * BYTES_PER_SAMPLE,
  );
  return pcm.subarray(startByte, endByte);
}
