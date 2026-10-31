// SRT subtitle parser and segment slicer for benchmark pipeline.
// Converts external .srt files into SttOutput compatible with @reflectworld/percept pipeline.

import { readFileSync } from "node:fs";
import type { SttOutput } from "@reflectworld/percept";

export interface SrtEntry {
  startMs: number;
  endMs: number;
  text: string;
}

const SAMPLE_RATE = 16000;

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
};

function isNoiseOnly(text: string): boolean {
  const stripped = text.trim();
  if (/^\[[^\]]*\]$/.test(stripped)) return true;
  if (/^\([^)]*\)$/.test(stripped)) return true;
  if (/^[♪♫\s]+$/.test(stripped)) return true;
  if (/^♪.*♪$/.test(stripped) && !/[a-zA-Z]{3,}/.test(stripped.replace(/♪/g, ""))) return true;
  return false;
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, "");
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&\w+;/g, (match) => HTML_ENTITIES[match] ?? match);
}

function parseTimestamp(raw: string): number {
  const ts = raw.trim().split(/\s/)[0]!;
  const match = ts.match(/^(\d+):(\d+):(\d+)[,.](\d+)$/);
  if (!match) return NaN;
  const h = Number(match[1]);
  const m = Number(match[2]);
  const s = Number(match[3]);
  const ms = Number(match[4]!.padEnd(3, "0").slice(0, 3));
  return h * 3600000 + m * 60000 + s * 1000 + ms;
}

export function parseSrt(content: string): SrtEntry[] {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.trim()) return [];

  const entries: SrtEntry[] = [];
  const blocks = normalized.trim().split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 2) continue;

    const tsLineIdx = lines.findIndex((l) => l.includes(" --> "));
    if (tsLineIdx < 0) continue;

    const tsParts = lines[tsLineIdx]!.split(" --> ");
    if (tsParts.length < 2) continue;

    const startMs = parseTimestamp(tsParts[0]!);
    const endMs = parseTimestamp(tsParts[1]!);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (endMs <= startMs) continue;

    const rawText = lines
      .slice(tsLineIdx + 1)
      .map((l) => decodeHtmlEntities(stripHtml(l)).trim())
      .filter(Boolean)
      .join(" ");

    if (!rawText) continue;
    if (isNoiseOnly(rawText)) continue;

    entries.push({ startMs, endMs, text: rawText });
  }

  return entries;
}

export function loadSrtFile(filePath: string): SrtEntry[] {
  const content = readFileSync(filePath, "utf-8");
  return parseSrt(content);
}

export function sliceSrtToSttOutput(
  entries: SrtEntry[],
  segmentStartMs: number,
  segmentEndMs: number,
): SttOutput {
  const owned = entries.filter(
    (e) => e.startMs >= segmentStartMs && e.startMs < segmentEndMs,
  );

  if (owned.length === 0) {
    return { transcript: "", segments: [] };
  }

  const segments: SttOutput["segments"] = [];

  for (const e of owned) {
    const relStartMs = Math.max(0, e.startMs - segmentStartMs);
    const relEndMs = Math.min(segmentEndMs, e.endMs) - segmentStartMs;
    if (relEndMs <= relStartMs) continue;
    segments.push({
      start: Math.round(relStartMs / 1000 * SAMPLE_RATE),
      end: Math.round(relEndMs / 1000 * SAMPLE_RATE),
      text: e.text,
      latency_ms: 0,
    });
  }

  const transcript = segments.map((s) => s.text).join(" ");
  return { transcript, segments };
}
