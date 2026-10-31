import type { Frame } from "@reflectworld/shared";
import type { CompletionContentPart, CompletionImage } from "./types.js";

interface ContentPartsInput {
  prompt: string;
  frames: Frame[];
  extraImageHeader: string;
  extraImages?: CompletionImage[];
  subjectProposal: boolean;
}

export function buildOrderedContentParts(input: ContentPartsInput): CompletionContentPart[] | undefined {
  const hasFrames = input.frames.length > 0;
  const hasExtraImages = (input.extraImages?.length ?? 0) > 0;
  if (!hasFrames && !hasExtraImages) return undefined;
  return input.subjectProposal
    ? buildSubjectProposalContentParts(input.prompt, input.frames, input.extraImageHeader, input.extraImages)
    : buildSegmentContentParts(input.prompt, input.frames, input.extraImageHeader, input.extraImages, "after_frames");
}

function buildSubjectProposalContentParts(
  prompt: string,
  frames: Frame[],
  extraImageHeader: string,
  extraImages?: CompletionImage[],
): CompletionContentPart[] {
  // Keep these markers aligned with VlmPromptBuilder.buildSubjectProposalPrompt().
  // If the prompt shape changes, tests should catch the fallback ordering below.
  const evidenceMarker = "\n\nCurrent Segment Evidence:\n";
  const taskMarker = "\n\nTask:\n";
  const evidenceIndex = prompt.indexOf(evidenceMarker);
  if (evidenceIndex < 0) {
    return buildSegmentContentParts(prompt, frames, extraImageHeader, extraImages, "before_frames");
  }

  const beforeEvidence = prompt.slice(0, evidenceIndex);
  const evidenceAndRest = prompt.slice(evidenceIndex + 2);
  const taskIndex = evidenceAndRest.indexOf(taskMarker);
  const evidenceSection = taskIndex >= 0 ? evidenceAndRest.slice(0, taskIndex) : evidenceAndRest;
  const taskAndRest = taskIndex >= 0 ? evidenceAndRest.slice(taskIndex + 2) : "";

  const parts: CompletionContentPart[] = [{ type: "text", text: beforeEvidence }];
  parts.push(...extraImageContentParts(extraImageHeader, extraImages));
  parts.push({ type: "text", text: evidenceSection });
  parts.push(...frameContentParts(frames, "Current segment frames"));
  if (taskAndRest.trim()) parts.push({ type: "text", text: taskAndRest });
  return parts;
}

function buildSegmentContentParts(
  prompt: string,
  frames: Frame[],
  extraImageHeader: string,
  extraImages: CompletionImage[] | undefined,
  extraImagesPlacement: "before_frames" | "after_frames",
): CompletionContentPart[] {
  const parts: CompletionContentPart[] = [{ type: "text", text: prompt }];
  if (extraImagesPlacement === "before_frames") parts.push(...extraImageContentParts(extraImageHeader, extraImages));
  parts.push(...frameContentParts(frames, "Current segment frames"));
  if (extraImagesPlacement !== "before_frames") parts.push(...extraImageContentParts(extraImageHeader, extraImages));
  return parts;
}

function extraImageContentParts(header: string, images?: CompletionImage[]): CompletionContentPart[] {
  if (!images?.length) return [];
  const parts: CompletionContentPart[] = [{ type: "text", text: header }];
  for (const image of images) {
    if (image.label?.trim()) parts.push({ type: "text", text: image.label.trim() });
    parts.push({ type: "image", base64: image.base64 });
  }
  return parts;
}

function frameContentParts(frames: Frame[], header: string): CompletionContentPart[] {
  if (frames.length === 0) return [];
  const effectiveHeader = frames.some((frame) => frame.index < 0)
    ? "Reference frame and current segment frames"
    : header;
  const parts: CompletionContentPart[] = [{ type: "text", text: `${effectiveHeader}:` }];
  const highDetail = frames.length === 1;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    parts.push({ type: "text", text: frameLabel(frame, i) });
    parts.push({
      type: "image",
      base64: frame.data,
      ...(highDetail ? { detail: "high" as const } : {}),
    });
  }
  return parts;
}

function frameLabel(frame: Frame, fallbackIndex: number): string {
  if (frame.index < 0) return "Reference frame:";
  const timestamp = Number.isFinite(frame.timestamp) ? `; timestamp_ms=${Math.round(frame.timestamp)}` : "";
  return `Segment frame ${frame.index ?? fallbackIndex}${timestamp}:`;
}
