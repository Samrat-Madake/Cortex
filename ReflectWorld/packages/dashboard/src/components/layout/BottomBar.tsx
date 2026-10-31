import { useState, useRef, useEffect } from "react";
import { Icon } from "../../theme/icons";
import { tokens } from "../../theme/tokens";
import type { Segment } from "../../hooks/useSegments";
import type { MonitorEvent } from "../../types";

interface BottomBarProps {
  events: MonitorEvent[];
  segments?: Segment[];
}

type NetworkStatus = {
  label: "Waiting" | "Excellent" | "Good" | "Fair" | "Slow";
  color: string;
  background: string;
  description: string;
  ttftMs?: number;
  sampleCount: number;
};

export function BottomBar({ events, segments = [] }: BottomBarProps) {
  const [openPopover, setOpenPopover] = useState<"services" | "models" | "network" | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Latest service health event
  const serviceHealth = findLatest(events, "system:service_health");
  const services: Record<string, string> = (serviceHealth?.data.services as Record<string, string>) ?? {};
  const serviceEntries = displayServiceEntries(services);
  const runtimeIssues = collectRuntimeIssues(events);
  const serviceDotColor = serviceEntries.some((entry) => !isHealthyStatus(entry.status)) || runtimeIssues.some((issue) => issue.status === "down")
    ? tokens.semantic.red
    : runtimeIssues.length > 0 ? tokens.semantic.amber : tokens.semantic.green;

  // Latest active models event
  const activeModels = findLatest(events, "system:active_models");
  const modelList: string[] = Array.isArray(activeModels?.data.models) ? (activeModels.data.models as string[]) : [];
  const modelEntries = displayModelEntries(modelList);

  // Latest pipeline metrics for backlog health.
  const backlogMetrics = findLatest(events, "system:pipeline_metrics", (event) => event.data.metric_type === "perception_backlog");
  const queueOverflow = findLatest(events, "system:queue_overflow");
  const backlogTotal = typeof backlogMetrics?.data.total_backlog === "number" ? backlogMetrics.data.total_backlog : 0;
  const skippedTotal = typeof backlogMetrics?.data.skipped_total === "number" ? backlogMetrics.data.skipped_total : 0;
  const rejectedTotal = typeof backlogMetrics?.data.rejected_total === "number"
    ? backlogMetrics.data.rejected_total
    : typeof queueOverflow?.data.dropped_total === "number" ? queueOverflow.data.dropped_total : 0;
  const degraded = backlogMetrics?.data.degraded === true || rejectedTotal > 0 || skippedTotal > 0;
  const networkStatus = networkStatusFromTtft(collectRecentTtftMs(segments, events));

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpenPopover(null);
    }
    if (openPopover) document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [openPopover]);

  return (
    <div
      ref={wrapRef}
      style={{
        background: "rgba(255,255,255,0.78)",
        boxShadow: "0 -1px 0 rgba(31,45,71,0.08)",
        padding: "0 18px",
        flexShrink: 0,
        zIndex: 90,
        backdropFilter: "blur(18px)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 20, height: 34 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, position: "relative" }}>
          <PopoverButton
            label="Services"
            badge={`${serviceEntries.filter((entry) => isHealthyStatus(entry.status)).length}/${serviceEntries.length || "—"}`}
            active={openPopover === "services"}
            onClick={() => setOpenPopover(s => (s === "services" ? null : "services"))}
            dot
            dotColor={serviceDotColor}
          />
          {openPopover === "services" && (
            <Popover title="Service Status">
              {serviceEntries.length === 0 && <div style={{ fontSize: 12, color: tokens.text.muted }}>No data</div>}
              {serviceEntries.map(({ label, status }) => (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", fontSize: 12, color: tokens.text.secondary }}>
                  <span
                    style={{
                      width: 7, height: 7, borderRadius: "50%",
                      background: isHealthyStatus(status) ? tokens.semantic.green : tokens.semantic.red,
                    }}
                  />
                  <span style={{ flex: 1 }}>{label}</span>
                  <span style={{ fontSize: 10, color: tokens.text.faint }}>{displayStatus(status)}</span>
                </div>
              ))}
              {runtimeIssues.length > 0 && (
                <div style={{ borderTop: "1px solid rgba(31,45,71,0.08)", marginTop: 7, paddingTop: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: tokens.text.primary, marginBottom: 4 }}>Runtime Issues</div>
                  {runtimeIssues.map((issue) => (
                    <div key={issue.statusKey} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "5px 0" }}>
                      <span style={{ width: 7, height: 7, marginTop: 4, flexShrink: 0, borderRadius: "50%", background: issue.status === "down" ? tokens.semantic.red : tokens.semantic.amber }} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12, color: tokens.text.secondary }}>
                          {issue.capability}{issue.sourceLabel ? ` · ${issue.sourceLabel}` : ""}
                        </div>
                        <div style={{ fontSize: 10, lineHeight: 1.4, color: tokens.text.muted }}>{issue.summary}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Popover>
          )}

          <PopoverButton
            label="Models"
            icon="cube"
            badge={`${modelEntries.length} active`}
            active={openPopover === "models"}
            onClick={() => setOpenPopover(s => (s === "models" ? null : "models"))}
          />
          {openPopover === "models" && (
            <Popover title="Analysis Capabilities">
              {modelEntries.length === 0 && <div style={{ fontSize: 12, color: tokens.text.muted }}>No data</div>}
              {modelEntries.map(label => (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", fontSize: 12, color: tokens.text.secondary }}>
                  <span style={{ flex: 1 }}>{label}</span>
                  <span
                    style={{
                      fontSize: 10, fontWeight: 500, padding: "1px 6px",
                      borderRadius: tokens.radius.pill,
                      background: "rgba(34,197,94,0.1)", color: tokens.semantic.green,
                    }}
                  >on</span>
                </div>
              ))}
            </Popover>
          )}
          {degraded && (
            <span
              title={`Perception backlog ${backlogTotal}, skipped ${skippedTotal}, rejected ${rejectedTotal}`}
              style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                padding: "4px 9px", borderRadius: tokens.radius.pill,
                background: "rgba(245,158,11,0.13)",
                color: "#a16207", fontSize: 11, fontWeight: 800,
              }}
            >
              <span style={{ width: 0, height: 0, borderLeft: "5px solid transparent", borderRight: "5px solid transparent", borderBottom: "9px solid #f59e0b" }} />
              Degraded
            </span>
          )}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14, position: "relative" }}>
          <button
            type="button"
            onClick={() => setOpenPopover(s => (s === "network" ? null : "network"))}
            title={networkStatus.description}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              padding: 0,
              border: "none",
              cursor: "pointer",
              borderRadius: "50%",
              background: networkStatus.background,
              color: networkStatus.color,
              boxShadow: openPopover === "network" ? `0 0 0 2px ${networkStatus.background}` : "none",
            }}
          >
            <Icon name="network" size={17} />
          </button>
          {openPopover === "network" && (
            <Popover title="VLM Response Status" align="right">
              <div style={{ display: "grid", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: tokens.text.secondary }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: networkStatus.color }} />
                  <span style={{ flex: 1 }}>Current</span>
                  <span style={{ color: networkStatus.color, fontWeight: 800 }}>{networkStatus.label}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: tokens.text.secondary }}>
                  <span style={{ flex: 1 }}>Recent TTFT</span>
                  <span style={{ color: tokens.text.primary, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
                    {networkStatus.ttftMs === undefined ? "No data" : formatTtftSeconds(networkStatus.ttftMs)}
                  </span>
                </div>
                <div style={{ fontSize: 11, lineHeight: 1.45, color: tokens.text.muted }}>
                  Based on recent VLM TTFT: the time from sending a segment to receiving the first model token.
                  {networkStatus.sampleCount > 0 ? ` Median of ${networkStatus.sampleCount} recent sample${networkStatus.sampleCount === 1 ? "" : "s"}.` : ""}
                </div>
                <div style={{ display: "grid", gap: 4, fontSize: 11, color: tokens.text.secondary }}>
                  <ThresholdRow color="#15803d" label="Excellent" value="≤ 2s" />
                  <ThresholdRow color={tokens.semantic.green} label="Good" value="≤ 4s" />
                  <ThresholdRow color={tokens.semantic.amber} label="Fair" value="≤ 7s" />
                  <ThresholdRow color={tokens.semantic.red} label="Slow" value="> 7s" />
                </div>
              </div>
            </Popover>
          )}
        </div>
      </div>
    </div>
  );
}

function findLatest(events: MonitorEvent[], type: string, predicate?: (event: MonitorEvent) => boolean): MonitorEvent | undefined {
  return events.find(e => e.type === type && (!predicate || predicate(e)));
}

function collectRecentTtftMs(segments: Segment[], events: MonitorEvent[]): number[] {
  const fromSegments = segments
    .flatMap((segment) => isPositiveNumber(segment.vlm_ttft_ms) ? [segment.vlm_ttft_ms] : [])
    .slice(0, 8);
  if (fromSegments.length > 0) return fromSegments;

  return events
    .flatMap((event) => {
      if (event.type !== "system:pipeline_trace") return [];
      const latencies = event.data.latencies;
      if (!latencies || typeof latencies !== "object" || Array.isArray(latencies)) return [];
      const ttft = (latencies as Record<string, unknown>).vlm_ttft_ms;
      return isPositiveNumber(ttft) ? [ttft] : [];
    })
    .slice(0, 8);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function networkStatusFromTtft(values: number[]): NetworkStatus {
  const ttftMs = median(values);
  if (ttftMs === undefined) {
    return {
      label: "Waiting",
      color: tokens.text.faint,
      background: tokens.bg.inset,
      description: "Waiting for recent VLM response timing.",
      sampleCount: 0,
    };
  }
  if (ttftMs <= 2000) {
    return {
      label: "Excellent",
      color: "#15803d",
      background: "rgba(21,128,61,0.12)",
      description: `Recent VLM TTFT ${formatTtftSeconds(ttftMs)}. Responses are starting almost immediately.`,
      ttftMs,
      sampleCount: values.length,
    };
  }
  if (ttftMs <= 4000) {
    return {
      label: "Good",
      color: tokens.semantic.green,
      background: "rgba(34,197,94,0.11)",
      description: `Recent VLM TTFT ${formatTtftSeconds(ttftMs)}. Responses are starting quickly.`,
      ttftMs,
      sampleCount: values.length,
    };
  }
  if (ttftMs <= 7000) {
    return {
      label: "Fair",
      color: "#a16207",
      background: "rgba(245,158,11,0.13)",
      description: `Recent VLM TTFT ${formatTtftSeconds(ttftMs)}. Responses are usable but slower than usual.`,
      ttftMs,
      sampleCount: values.length,
    };
  }
  return {
    label: "Slow",
    color: tokens.semantic.red,
    background: "rgba(239,68,68,0.11)",
    description: `Recent VLM TTFT ${formatTtftSeconds(ttftMs)}. Responses are starting slowly; video cards may queue.`,
    ttftMs,
    sampleCount: values.length,
  };
}

function formatTtftSeconds(ms: number): string {
  if (ms >= 10_000) return `${Math.round(ms / 1000)}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function ThresholdRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: color }} />
      <span style={{ flex: 1 }}>{label}</span>
      <span style={{ color: tokens.text.faint, fontWeight: 700 }}>{value}</span>
    </div>
  );
}

function isHealthyStatus(status: string): boolean {
  return status === "healthy" || status === "ok" || status === "running";
}

function displayStatus(status: string): string {
  if (isHealthyStatus(status)) return "Ready";
  if (status === "starting" || status === "pending") return "Starting";
  if (status === "stopped") return "Stopped";
  return "Error";
}

function displayServiceEntries(services: Record<string, string>): Array<{ label: string; status: string }> {
  const merged = new Map<string, string>();
  for (const [name, status] of Object.entries(services)) {
    const label = displayServiceName(name);
    const previous = merged.get(label);
    if (!previous || (isHealthyStatus(previous) && !isHealthyStatus(status))) {
      merged.set(label, status);
    }
  }
  return Array.from(merged.entries())
    .map(([label, status]) => ({ label, status }))
    .sort((a, b) => serviceSortRank(a.label) - serviceSortRank(b.label) || a.label.localeCompare(b.label));
}

function displayServiceName(raw: string): string {
  const name = raw.toLowerCase();
  if (name.includes("reflect") || name.includes("host")) return "ReflectWorld";
  if (name.includes("database") || name.includes("sqlite") || name.includes("qdrant") || name.includes("memory") || name.includes("db")) return "Database";
  if (name.includes("go2rtc") || name.includes("stream") || name.includes("rtsp") || name.includes("video")) return "Video Stream";
  if (name.includes("monitor") || name.includes("dashboard")) return "Monitor";
  return toDisplayLabel(raw);
}

function serviceSortRank(label: string): number {
  if (label === "ReflectWorld") return 0;
  if (label === "Database") return 1;
  if (label === "Video Stream") return 2;
  if (label === "Monitor") return 3;
  return 10;
}

function displayModelEntries(models: string[]): string[] {
  const labels = new Set<string>();
  for (const model of models) {
    labels.add(displayModelName(model));
  }
  return Array.from(labels).sort((a, b) => modelSortRank(a) - modelSortRank(b) || a.localeCompare(b));
}

type RuntimeIssue = {
  statusKey: string;
  capability: string;
  summary: string;
  status: "degraded" | "down";
  observedAt: number;
  sourceLabel?: string;
};

function collectRuntimeIssues(events: MonitorEvent[]): RuntimeIssue[] {
  const sourceLabels = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "dashboard:source_state" || event.data.op === "remove") continue;
    const sourceId = typeof event.data.source_id === "string" ? event.data.source_id : event.camera_id;
    const label = typeof event.data.label === "string"
      ? event.data.label
      : typeof event.data.source_name === "string" ? event.data.source_name : undefined;
    if (sourceId && label) sourceLabels.set(sourceId, label);
  }
  const grouped = new Map<string, RuntimeIssue>();
  for (const event of events) {
    if (event.type !== "system:component_status") continue;
    const status = event.data.status;
    if (status !== "degraded" && status !== "down") continue;
    const capability = typeof event.data.capability === "string" ? event.data.capability : "Runtime capability";
    const sourceId = typeof event.data.source_id === "string" ? event.data.source_id : event.camera_id;
    const issue: RuntimeIssue = {
      statusKey: typeof event.data.status_key === "string" ? event.data.status_key : `${capability}:${event.timestamp}`,
      capability,
      summary: typeof event.data.summary === "string" ? event.data.summary : `${capability} encountered an error.`,
      status,
      observedAt: typeof event.data.observed_at === "number" ? event.data.observed_at : event.timestamp,
      ...(sourceId && sourceLabels.has(sourceId) ? { sourceLabel: sourceLabels.get(sourceId) } : {}),
    };
    const groupKey = `${capability}|${sourceId ?? "global"}`;
    const previous = grouped.get(groupKey);
    if (!previous || issue.status === "down" || issue.observedAt > previous.observedAt) grouped.set(groupKey, issue);
  }
  return Array.from(grouped.values())
    .sort((a, b) => (a.status === b.status ? b.observedAt - a.observedAt : a.status === "down" ? -1 : 1));
}

function displayModelName(raw: string): string {
  const name = raw.toLowerCase();
  if (name.includes("reid") || name.includes("identity") || name.includes("face")) return "Identity Recognition";
  if (name.includes("detect") || name.includes("yolo") || name.includes("object") || name.includes("person_present")) return "Object Detection";
  if (name.includes("vlm") || name.includes("llm") || name.includes("gpt") || name.includes("qwen") || name.includes("gemini") || name.includes("multimodal")) return "Multimodal Analysis";
  if (name.includes("stt") || name.includes("speech") || name.includes("audio") || name.includes("whisper") || name.includes("eleven")) return "Speech Recognition";
  if (name.includes("embed")) return "Semantic Search";
  return toDisplayLabel(raw);
}

function modelSortRank(label: string): number {
  if (label === "Identity Recognition") return 0;
  if (label === "Object Detection") return 1;
  if (label === "Multimodal Analysis") return 2;
  if (label === "Speech Recognition") return 3;
  if (label === "Semantic Search") return 4;
  return 10;
}

function toDisplayLabel(raw: string): string {
  return raw
    .replace(/[_:/.-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function PopoverButton({ label, badge, active, onClick, icon, dot, dotColor = tokens.semantic.green }: { label: string; badge: string; active: boolean; onClick: () => void; icon?: "cube"; dot?: boolean; dotColor?: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 5,
        padding: "4px 10px", borderRadius: tokens.radius.pill,
        fontSize: 11, fontWeight: 800, cursor: "pointer", border: "none",
        background: active ? tokens.accent.soft : tokens.bg.inset,
        color: active ? tokens.accent.base : tokens.text.secondary,
      }}
    >
      {dot && <span style={{ width: 6, height: 6, borderRadius: "50%", background: dotColor }} />}
      {icon && <Icon name={icon} size={14} />}
      {label} <span style={{ fontSize: 11, color: tokens.text.faint }}>{badge}</span>
    </button>
  );
}

function Popover({ title, children, align = "left" }: { title: string; children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <div
      style={{
        position: "absolute", bottom: "calc(100% + 8px)",
        ...(align === "right" ? { right: 0 } : { left: 0 }),
        minWidth: 240, background: tokens.bg.surface,
        borderRadius: tokens.radius.lg,
        boxShadow: `${tokens.shadow.elevated}, 0 16px 40px rgba(0,0,0,0.1)`,
        padding: 12, zIndex: 300,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: tokens.text.primary, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}
