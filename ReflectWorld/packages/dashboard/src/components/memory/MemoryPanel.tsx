import { useState } from "react";
import { Icon } from "../../theme/icons";
import { tokens } from "../../theme/tokens";
import type { DashboardMemoryEventGroup, DashboardMemoryRecord } from "../../types";

interface MemoryPanelProps {
  sceneMemories: DashboardMemoryRecord[];
  eventGroups: DashboardMemoryEventGroup[];
}

type MemoryRange = Pick<
  DashboardMemoryRecord,
  "source_time_label" | "start_ms" | "end_ms" | "timestamp"
>;

function formatMediaTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function normalizeClockToken(raw: string): string {
  const token = raw.trim();
  const match = token.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/);
  if (!match) return token;
  const first = Number(match[1]);
  const second = Number(match[2]);
  const third = match[3] !== undefined ? Number(match[3]) : undefined;
  if (third === undefined) {
    return `${String(first).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
  }
  if (first > 0) {
    return `${String(first).padStart(2, "0")}:${String(second).padStart(2, "0")}:${String(third).padStart(2, "0")}`;
  }
  return `${String(second).padStart(2, "0")}:${String(third).padStart(2, "0")}`;
}

function normalizeSourceTimeLabel(label: string): string {
  const normalized = label.replace(/(\d{1,2}:\d{2}:\d{2})\.\d+/g, "$1");
  const range = normalized.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s*-\s*(\d{1,2}:\d{2}(?::\d{2})?)$/);
  if (range) {
    return `${normalizeClockToken(range[1])} - ${normalizeClockToken(range[2])}`;
  }
  const parts = normalized.split(/\s+-\s+/);
  if (parts.length === 2) {
    return `${normalizeClockToken(parts[0])} - ${normalizeClockToken(parts[1])}`;
  }
  return normalizeClockToken(normalized);
}

function formatTimePoint(ms: number): string {
  if (ms >= 946_684_800_000) {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  return formatMediaTime(ms);
}

export function formatMemoryRange(record: MemoryRange): string {
  if (record.start_ms !== undefined && record.end_ms !== undefined) {
    return `${formatTimePoint(record.start_ms)} - ${formatTimePoint(record.end_ms)}`;
  }
  if (record.start_ms !== undefined) return formatTimePoint(record.start_ms);
  if (record.source_time_label) return normalizeSourceTimeLabel(record.source_time_label);
  return new Date(record.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatTraceRange(record: MemoryRange): string {
  return formatMemoryRange(record).replace(/\s+-\s+/, "\n-\n");
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? normalizeText(value) : null;
}

function titleCaseKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

const semanticFieldLabels: Array<[key: string, label: string]> = [
  ["scene_description", "Scene"],
  ["known_entities", "Known People And Entities"],
  ["daily_routine", "Recurring Patterns"],
  ["anomaly_baseline", "Baseline"],
  ["user_notes", "User Notes"],
];

const semanticSystemFields = new Set([
  "camera_id",
  "user_id",
  "category",
  "data",
  "created_at",
  "updated_at",
  "last_llm_update",
  "last_update_segment_count",
  "last_agent_consult",
  "last_consult_segment_count",
  "consecutive_no_updates",
]);

interface SceneSection {
  key: string;
  label: string;
  body: string;
}

function sectionsFromSemanticFields(data: Record<string, unknown> | undefined): SceneSection[] {
  if (!data) return [];
  const sections: SceneSection[] = [];
  const consumed = new Set<string>();
  for (const [key, label] of semanticFieldLabels) {
    const body = readText(data[key]);
    consumed.add(key);
    if (body) sections.push({ key, label, body });
  }
  for (const [key, value] of Object.entries(data)) {
    if (consumed.has(key) || semanticSystemFields.has(key)) continue;
    const body = readText(value);
    if (body) sections.push({ key, label: titleCaseKey(key), body });
  }
  return sections;
}

function sectionsFromJsonSummary(summary: string): SceneSection[] {
  if (!summary.trim().startsWith("{")) return [];
  try {
    const parsed = JSON.parse(summary) as unknown;
    return isPlainRecord(parsed) ? sectionsFromSemanticFields(parsed) : [];
  } catch {
    return [];
  }
}

function sectionsFromLabeledText(summary: string): SceneSection[] {
  const normalized = normalizeText(summary);
  if (!normalized) return [];

  const labelMap = new Map<string, string>([
    ["scene", "Scene"],
    ["scene description", "Scene"],
    ["known entities", "Known People And Entities"],
    ["known people", "Known People And Entities"],
    ["daily routine", "Recurring Patterns"],
    ["recurring patterns", "Recurring Patterns"],
    ["anomaly baseline", "Baseline"],
    ["baseline", "Baseline"],
    ["user notes", "User Notes"],
  ]);
  const sections: SceneSection[] = [];
  let current: { key: string; label: string; lines: string[] } | null = null;

  for (const line of normalized.split("\n")) {
    const match = line.match(/^\s*(?:#{1,4}\s*)?([A-Za-z][A-Za-z _-]{1,48})\s*:\s*(.*)$/);
    const canonicalLabel = match ? labelMap.get(match[1].replace(/[_-]/g, " ").trim().toLowerCase()) : undefined;
    if (match && canonicalLabel) {
      if (current) {
        const body = normalizeText(current.lines.join("\n"));
        if (body) sections.push({ key: current.key, label: current.label, body });
      }
      current = { key: canonicalLabel.toLowerCase().replace(/\s+/g, "_"), label: canonicalLabel, lines: [] };
      if (match[2].trim()) current.lines.push(match[2]);
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }

  if (current) {
    const body = normalizeText(current.lines.join("\n"));
    if (body) sections.push({ key: current.key, label: current.label, body });
  }
  return sections;
}

function sceneSections(record: DashboardMemoryRecord): SceneSection[] {
  const fromMetadata = sectionsFromSemanticFields(record.metadata);
  if (fromMetadata.length > 0) return fromMetadata;
  const fromJson = sectionsFromJsonSummary(record.summary);
  if (fromJson.length > 0) return fromJson;
  const fromLabeledText = sectionsFromLabeledText(record.summary);
  if (fromLabeledText.length > 0) return fromLabeledText;
  const body = normalizeText(record.summary);
  return body ? [{ key: "profile", label: "Profile", body }] : [];
}

function SectionLabel({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        margin: "10px 0 6px",
        fontSize: 10,
        fontWeight: 500,
        color: tokens.text.muted,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
      }}
    >
      <span>{children}</span>
      {count !== undefined && (
        <span style={{ marginLeft: "auto", color: tokens.text.faint, fontWeight: 500 }}>{count}</span>
      )}
    </div>
  );
}

function MemoryText({ children }: { children: string }) {
  const body = normalizeText(children || "(empty memory)");
  return (
    <div
      style={{
        fontSize: 12,
        lineHeight: 1.55,
        color: tokens.text.secondary,
        background: tokens.bg.inset,
        borderRadius: tokens.radius.md,
        padding: "9px 10px",
        boxShadow: "inset 0 0 0 1px rgba(15,23,42,0.03)",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}
    >
      {body}
    </div>
  );
}

function SceneMemoryContent({ memory }: { memory: DashboardMemoryRecord }) {
  const sections = sceneSections(memory);
  if (sections.length === 0) {
    return <div style={{ fontSize: 12, color: tokens.text.faint, padding: "4px 0" }}>No scene-level memory yet.</div>;
  }
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {sections.map((section) => (
        <div
          key={section.key}
          style={{
            background: tokens.bg.inset,
            borderRadius: tokens.radius.md,
            padding: "9px 10px",
            boxShadow: "inset 0 0 0 1px rgba(15,23,42,0.03)",
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 500,
              color: tokens.text.muted,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              marginBottom: 5,
            }}
          >
            {section.label}
          </div>
          <div
            style={{
              fontSize: 12,
              lineHeight: 1.55,
              color: tokens.text.secondary,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {section.body}
          </div>
        </div>
      ))}
    </div>
  );
}

function SceneUnderstanding({ memories }: { memories: DashboardMemoryRecord[] }) {
  const [open, setOpen] = useState(memories.length > 0);
  const latest = memories[0];
  return (
    <div
      style={{
        borderRadius: tokens.radius.lg,
        background: "rgba(255,255,255,0.78)",
        boxShadow: "0 0 0 1px rgba(31,45,71,0.06)",
        marginBottom: 10,
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={{
          width: "100%",
          border: "none",
          background: "transparent",
          padding: "11px 12px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
          fontFamily: "inherit",
          color: tokens.text.primary,
          textAlign: "left",
        }}
      >
        <Icon name="sparkle" size={15} color={tokens.semantic.purple} />
        <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "-0.2px" }}>Scene Understanding</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: tokens.text.faint }}>{memories.length}</span>
      </button>
      {open && (
        <div style={{ padding: "0 12px 12px" }}>
          {latest ? (
            <SceneMemoryContent memory={latest} />
          ) : (
            <div style={{ fontSize: 12, color: tokens.text.faint, padding: "4px 0" }}>
              No scene-level memory yet.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EventMemoryCard({ group, eventNumber }: { group: DashboardMemoryEventGroup; eventNumber: number }) {
  const [open, setOpen] = useState(false);
  const anchor = group.schemas[0] ?? group.traces[0];
  const eventRange: MemoryRange | null = anchor ? {
    timestamp: anchor.timestamp,
    start_ms: group.start_ms,
    end_ms: group.end_ms,
    source_time_label: group.start_ms === undefined ? anchor.source_time_label : undefined,
  } : null;
  const subtitle = group.title !== "Event Memory" ? group.title : null;
  return (
    <div
      style={{
        borderRadius: tokens.radius.lg,
        background: tokens.bg.surface,
        boxShadow: tokens.shadow.card,
        marginBottom: 8,
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={{
          width: "100%",
          border: "none",
          background: "transparent",
          padding: "11px 12px",
          display: "grid",
          gridTemplateColumns: "1fr auto",
          gap: 8,
          cursor: "pointer",
          fontFamily: "inherit",
          textAlign: "left",
        }}
      >
        <span style={{ minWidth: 0 }}>
          <span
            style={{
              display: "block",
              fontSize: 13,
              fontWeight: 800,
              color: tokens.text.primary,
              letterSpacing: "-0.2px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            Event {eventNumber}
          </span>
          {subtitle && (
            <span
              style={{
                display: "block",
                marginTop: 3,
                fontSize: 11,
                color: tokens.text.secondary,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {subtitle}
            </span>
          )}
          {eventRange && (
            <span style={{ display: "block", marginTop: 3, fontSize: 10, color: tokens.text.faint }}>
              {formatMemoryRange(eventRange)}
            </span>
          )}
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 10,
            fontWeight: 750,
            color: tokens.text.muted,
            background: tokens.bg.inset,
            borderRadius: tokens.radius.pill,
            padding: "4px 8px",
            alignSelf: "start",
          }}
        >
          {group.schemas.length + group.traces.length}
        </span>
      </button>
      {open && (
        <div style={{ padding: "0 12px 12px", borderTop: "1px solid rgba(15,23,42,0.05)" }}>
          <SectionLabel count={group.schemas.length}>Event Summary</SectionLabel>
          {group.schemas.length > 0 ? (
            <div style={{ display: "grid", gap: 6 }}>
              {group.schemas.map((record) => (
                <MemoryText key={record.memory_id}>{record.summary}</MemoryText>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: tokens.text.faint }}>No episodic schema for this event yet.</div>
          )}

          <SectionLabel count={group.traces.length}>Trace</SectionLabel>
          {group.traces.length > 0 ? (
            <div style={{ display: "grid", gap: 6 }}>
              {group.traces.map((record) => (
                <div
                  key={record.memory_id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "46px 1fr",
                    gap: 8,
                    alignItems: "start",
                    fontSize: 12,
                    color: tokens.text.secondary,
                    padding: "7px 0",
                    borderBottom: "1px solid rgba(15,23,42,0.04)",
                  }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      lineHeight: 1.2,
                      color: tokens.text.faint,
                      whiteSpace: "pre-line",
                      overflowWrap: "anywhere",
                      paddingTop: 1,
                    }}
                  >
                    {formatTraceRange(record)}
                  </span>
                  <span style={{ lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                    {normalizeText(record.summary || "(empty memory)")}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: tokens.text.faint }}>No trace memories for this event yet.</div>
          )}
        </div>
      )}
    </div>
  );
}

export function MemoryPanel({ sceneMemories, eventGroups }: MemoryPanelProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          fontSize: 15,
          fontWeight: 700,
          color: tokens.text.primary,
          letterSpacing: "-0.35px",
          marginBottom: 8,
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexShrink: 0,
        }}
      >
        Memory
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: tokens.text.muted,
            background: tokens.bg.inset,
            padding: "3px 9px",
            borderRadius: tokens.radius.pill,
          }}
        >
          {eventGroups.length}
        </span>
      </div>
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "2px 4px 4px 2px",
          margin: "-2px -4px -4px -2px",
        }}
      >
        <SceneUnderstanding memories={sceneMemories} />
        {eventGroups.length === 0 && (
          <div style={{ color: tokens.text.muted, fontSize: 13, padding: 16, textAlign: "center" }}>
            No event memories yet.
          </div>
        )}
        {eventGroups.map((group, index) => (
          <EventMemoryCard key={group.event_id} group={group} eventNumber={index + 1} />
        ))}
      </div>
    </div>
  );
}
