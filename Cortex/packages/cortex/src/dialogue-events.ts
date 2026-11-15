export interface DialogueTarget {
  entity_id?: string;
  target_id?: string;
  type?: string;
  name?: string;
  label?: string;
  ref?: string | number;
  appearance?: string;
}

export interface DialogueEventLine {
  text_start?: number;
  speaker?: string;
  track_id?: string;
  entity_id?: string;
  confidence?: string;
  text?: string;
}

export interface DialogueProjection {
  transcript?: string;
  dialogue?: DialogueEventLine[];
  speech_events_text?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function displayTargetName(target: DialogueTarget | undefined): string | undefined {
  if (!target) return undefined;
  if (target.name) return target.name;
  if (target.label) return target.label;
  if (target.ref !== undefined && target.ref !== null) return String(target.ref);
  const type = cleanString(target.type);
  if (!type) return undefined;
  const appearance = cleanString(target.appearance);
  if (appearance) return `the ${type} with ${appearance}`;
  return type === "person" ? "Person" : type;
}

function speakerNumber(speakerId: unknown, fallbackIndex: number): string {
  if (typeof speakerId === "string") {
    const match = speakerId.match(/(\d+)$/);
    if (match) return `Speaker ${Number(match[1]) + 1}`;
  }
  return `Speaker ${fallbackIndex + 1}`;
}

function formatSpeechTime(seconds: number | undefined): string {
  const safeSeconds = Number.isFinite(seconds) && (seconds ?? 0) >= 0 ? seconds ?? 0 : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remaining = safeSeconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remaining.toFixed(2).padStart(5, "0")}`;
}

function quoteSpeech(text: string): string {
  return text.replace(/"/g, '\\"');
}

export function projectDialogueEvents(raw: unknown, targets: DialogueTarget[] = []): DialogueProjection {
  const dialogue = asRecord(raw);
  if (!dialogue) return {};

  const targetByEntity = new Map<string, DialogueTarget>();
  const targetByTrack = new Map<string, DialogueTarget>();
  for (const target of targets) {
    if (target.entity_id) targetByEntity.set(target.entity_id, target);
    if (target.target_id) targetByTrack.set(target.target_id, target);
  }

  const resolveSpeaker = (entry: Record<string, unknown>, fallbackIndex: number): string => {
    const explicitSpeaker = cleanString(entry.speaker);
    if (explicitSpeaker) return explicitSpeaker;

    const entityId = cleanString(entry.entity_id);
    const trackId = cleanString(entry.track_id);

    const targetName = displayTargetName(
      entityId ? targetByEntity.get(entityId) : undefined,
    ) ?? displayTargetName(
      trackId ? targetByTrack.get(trackId) : undefined,
    );
    if (targetName) return targetName;

    return speakerNumber(entry.speaker_id, fallbackIndex);
  };

  const projection: DialogueProjection = {};
  const transcript = cleanString(dialogue.transcript);
  if (transcript) projection.transcript = transcript;

  if (Array.isArray(dialogue.dialogue)) {
    const lines = dialogue.dialogue
      .map(asRecord)
      .filter((item): item is Record<string, unknown> => Boolean(item))
      .map((item, index): DialogueEventLine => ({
        ...(typeof item.text_start === "number" ? { text_start: item.text_start } : {}),
        speaker: resolveSpeaker(item, index),
        ...(cleanString(item.track_id) ? { track_id: cleanString(item.track_id) } : {}),
        ...(cleanString(item.entity_id) ? { entity_id: cleanString(item.entity_id) } : {}),
        ...(typeof item.confidence === "string" ? { confidence: item.confidence } : {}),
        ...(cleanString(item.text) ? { text: cleanString(item.text) } : {}),
      }))
      .filter((item) => Boolean(item.speaker || item.text));
    if (lines.length > 0) {
      projection.dialogue = lines;
      projection.speech_events_text = `Speech:\n${lines.map((line) => {
        const body = line.text
          ? `${line.speaker} said: "${quoteSpeech(line.text)}"`
          : `${line.speaker} was speaking.`;
        return `- ${formatSpeechTime(line.text_start)}: ${body}`;
      }).join("\n")}`;
    }
  }

  return projection;
}
