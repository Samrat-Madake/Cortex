import { useEffect, useState } from "react";
import { Icon, type IconName } from "../../theme/icons";
import { tokens } from "../../theme/tokens";
import type { Segment } from "../../hooks/useSegments";
import { GifThumb } from "../shared/GifThumb";
import { SegmentDetail } from "./SegmentDetail";

interface SegmentCardProps {
  segment: Segment;
  selected: boolean;
  dimmed: boolean;
  expanded: boolean;
  allowAnimatedPreview: boolean;
  onClick: () => void;
  /** Resolve an entity_id to a display name; forwarded to `SegmentDetail`. */
  getEntityName?: (entity_id: string) => string;
}

/** Category-tag aggregation — mirrors prototype `.stag` entries. */
interface CategoryTag {
  icon: IconName;
  key: string;
  label: string;
}

type SegmentMeta =
  | { kind: "category"; key: string; icon: IconName; label: string }
  | { kind: "text"; key: string; label: string; tone?: "alert" | "rule" | "muted" }
  | { kind: "icon"; key: string; icon: IconName; title: string; tone?: "alert" | "rule" | "muted" };

type PreviewTitleTone = "processing" | "watching" | "queued" | "skipped";

function aggregateCategories(targets: Segment["targets"]): CategoryTag[] {
  const counts = { person: 0, pet: 0 };
  for (const t of targets) {
    const type = t.type.toLowerCase();
    if (type === "person" || type === "human") counts.person += 1;
    else if (type === "dog" || type === "cat" || type === "animal" || type === "pet") counts.pet += 1;
  }
  const tags: CategoryTag[] = [];
  if (counts.person > 0) tags.push({ icon: "person", key: "person", label: "People" });
  if (counts.pet > 0) tags.push({ icon: "pet", key: "pet", label: "Animals" });
  return tags;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatMediaTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatSegmentClock(segment: Segment, ms: number): string {
  const mode = segment.display_time_mode ?? (segment.is_media_source ? "media" : "wall_clock");
  return mode === "media" ? formatMediaTime(ms) : formatTime(ms);
}

function usesMediaTimeline(segment: Segment): boolean {
  return segment.display_time_mode === "media" || segment.is_media_source;
}

function formatAriaTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatSegmentAriaTime(segment: Segment): string {
  const mode = segment.display_time_mode ?? (segment.is_media_source ? "media" : "wall_clock");
  const start = segment.display_start_time ?? segment.start_time;
  return mode === "media" ? formatMediaTime(start) : formatAriaTime(start);
}

function formatDurationSeconds(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded < 60) return `${rounded}s`;
  return `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
}

function formatDuration(segment: Segment): string {
  if (segment.vlm_model === "watching-preview") {
    if (usesMediaTimeline(segment)) {
      const displayStart = segment.display_start_time ?? segment.start_time;
      const displayEnd = segment.display_end_time ?? segment.end_time;
      const mediaDurationSec = Math.max(0, (displayEnd - displayStart) / 1000);
      return formatDurationSeconds(Math.max(1, mediaDurationSec));
    }
    const elapsedMs = Date.now() - segment.start_time;
    return formatDurationSeconds(Math.max(1, elapsedMs / 1000));
  }
  if (segment.is_static && segment.merged_count > 1) return `${segment.merged_count} merged`;
  if (segment.duration_sec > 0) return formatDurationSeconds(segment.duration_sec);
  return "snapshot";
}

function formatSegmentInterval(segment: Segment): string {
  if (segment.is_static || segment.duration_sec <= 0) return "snapshot";
  const start = formatSegmentClock(segment, segment.display_start_time ?? segment.start_time);
  const end = formatSegmentClock(segment, segment.display_end_time ?? segment.end_time);
  if (start === end) return start;
  return `${start} - ${end}`;
}

function formatEventTitle(segment: Segment, tags: CategoryTag[]): string {
  if (segment.is_static) return "Static Scene";
  if (segment.notification_fired) return "Notified Event";
  const primary = tags[0]?.key;
  if (primary === "person") return "Person Activity";
  if (primary === "pet") return "Animal Activity";
  if (primary === "car") return "Vehicle Activity";
  return "Activity";
}

function formatPreviewTitle(segment: Segment): string | null {
  if (segment.vlm_model === "watching-preview") return "Watching";
  if (segment.vlm_model === "queued-preview") return "Waiting for analysis";
  if (segment.vlm_model === "processing-preview") return "Analyzing...";
  if (segment.vlm_model === "backlog-skip" || segment.analysis_status === "skipped") return "Skipped";
  return null;
}

/**
 * Segment card — clickable summary entry in the center column.
 * Styled per prototype `.seg` / `.seg-body` / `.seg-info`.
 */
export function SegmentCard({ segment, selected, dimmed, expanded, allowAnimatedPreview, onClick, getEntityName }: SegmentCardProps) {
  const [, setNowTick] = useState(0);
  const isWatchingPreview = segment.vlm_model === "watching-preview";
  const isProcessingPreview = segment.vlm_model === "processing-preview";
  const isSkipped = segment.vlm_model === "backlog-skip" || segment.analysis_status === "skipped";
  useEffect(() => {
    if (segment.vlm_model !== "watching-preview" && segment.vlm_model !== "processing-preview") return;
    const timer = window.setInterval(() => setNowTick(Date.now()), segment.vlm_model === "processing-preview" ? 180 : 1000);
    return () => window.clearInterval(timer);
  }, [segment.vlm_model, segment.segment_id]);

  const wavePhase = Date.now() % 1600;
  const waveX = `${Math.round((wavePhase / 1600) * 200)}%`;
  const tags = aggregateCategories(segment.targets);
  const isPartial = segment.is_partial || segment.analysis_status === "partial";
  const clickable = !isPartial;
  const showThumb = !expanded;
  const hasPolicyPrompt = Boolean(segment.segment_policy_prompt);
  const collapsedHeight = 86;
  const thumbSize = 78;
  const previewTitle = formatPreviewTitle(segment);
  const eventTitle = previewTitle ?? segment.title?.trim() ?? formatEventTitle(segment, tags);
  const durationLabel = formatDuration(segment);
  const statusColor = segment.security_risk
    ? tokens.semantic.red
    : segment.vlm_model === "processing-preview"
      ? tokens.semantic.amber
    : isSkipped
      ? tokens.text.faint
    : segment.triggered_rules.length > 0 || segment.notification_fired
      ? tokens.semantic.amber
      : isPartial
        ? tokens.text.faint
      : segment.is_static
        ? tokens.text.faint
        : tokens.semantic.green;
  const metadata: SegmentMeta[] = [
    ...tags.map(tag => ({ kind: "category" as const, key: tag.key, icon: tag.icon, label: tag.label })),
    ...(segment.is_static ? [{ kind: "text" as const, key: "static", label: "static", tone: "muted" as const }] : []),
    ...(segment.triggered_rules.length > 0 ? [{ kind: "icon" as const, key: "triggered-rule", icon: "cube" as const, title: "Rule matched", tone: "rule" as const }] : []),
    ...(hasPolicyPrompt ? [{ kind: "icon" as const, key: "adaptive-prompt", icon: "sparkle" as const, title: "Adaptive Prompt", tone: "rule" as const }] : []),
    ...(segment.notification_fired ? [{ kind: "icon" as const, key: "notify", icon: "alert" as const, title: "Notification sent", tone: "alert" as const }] : []),
  ];
  const previewTitleTone: PreviewTitleTone | null = segment.vlm_model === "processing-preview"
    ? "processing"
    : segment.vlm_model === "watching-preview"
      ? "watching"
      : segment.vlm_model === "queued-preview"
        ? "queued"
        : isSkipped
          ? "skipped"
          : null;
  const renderTitle = () => {
    if (!previewTitleTone) {
      return (
        <span style={{ fontSize: 13, fontWeight: 700, color: tokens.text.primary, letterSpacing: "-0.15px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {eventTitle}
        </span>
      );
    }
    const toneStyles: Record<PreviewTitleTone, { color: string; background: string; shimmer: string }> = {
      processing: {
        color: "#0f172a",
        background: "rgba(255,255,255,0.72)",
        shimmer: "linear-gradient(90deg, rgba(56,189,248,0.18), rgba(167,139,250,0.34), rgba(245,158,11,0.24), rgba(34,197,94,0.22), rgba(56,189,248,0.18))",
      },
      watching: {
        color: "#075985",
        background: "rgba(236,254,255,0.78)",
        shimmer: "linear-gradient(90deg, rgba(14,165,233,0.08), rgba(34,211,238,0.26), rgba(20,184,166,0.12), rgba(14,165,233,0.08))",
      },
      queued: {
        color: tokens.text.muted,
        background: tokens.bg.inset,
        shimmer: "linear-gradient(90deg, rgba(148,163,184,0.08), rgba(148,163,184,0.16), rgba(148,163,184,0.08))",
      },
      skipped: {
        color: tokens.text.faint,
        background: tokens.bg.inset,
        shimmer: "linear-gradient(90deg, rgba(148,163,184,0.05), rgba(148,163,184,0.12), rgba(148,163,184,0.05))",
      },
    };
    const style = toneStyles[previewTitleTone];
    return (
      <span
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          minWidth: 0,
          maxWidth: "100%",
          padding: "4px 9px",
          borderRadius: tokens.radius.pill,
          overflow: "hidden",
          fontSize: 11,
          fontWeight: 800,
          color: style.color,
          background: style.background,
          boxShadow: "inset 0 0 0 1px rgba(15,23,42,0.08)",
          whiteSpace: "nowrap",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            background: style.shimmer,
            backgroundSize: "220% 100%",
            backgroundPosition: `${waveX} 0`,
          }}
        />
        <span style={{ position: "relative", overflow: "hidden", textOverflow: "ellipsis" }}>{eventTitle}</span>
      </span>
    );
  };

  // Outer <article> owns the card chrome (shadow, selected ring, dimmed
  // opacity). The inner <button> is a transparent hit target so users can
  // freely interact with nested controls inside <SegmentDetail> without
  // accidentally triggering the parent.
  const outerStyle: React.CSSProperties = {
    background: selected
      ? "linear-gradient(180deg, #ffffff, #f8fbff)"
      : tokens.bg.surface,
    borderRadius: tokens.radius.lg,
    marginBottom: 8,
    boxShadow: selected ? tokens.shadow.selected : tokens.shadow.card,
    transition: "box-shadow 0.2s, opacity 0.2s, transform 0.2s, background 0.2s",
    overflow: "hidden",
    opacity: dimmed ? 0.22 : 1,
    pointerEvents: "auto",
    display: "block",
    position: "relative",
  };

  const buttonStyle: React.CSSProperties = {
    background: "transparent",
    cursor: clickable ? "pointer" : "default",
    width: "100%",
    textAlign: "left",
    border: "none",
    padding: 0,
    color: "inherit",
    fontFamily: "inherit",
    display: "block",
  };

  const body = (
    <div
      style={{
        display: showThumb ? "grid" : "block",
        gridTemplateColumns: showThumb ? `${collapsedHeight}px minmax(0, 1fr)` : undefined,
        alignItems: "stretch",
        gap: showThumb ? 0 : undefined,
        minHeight: showThumb ? collapsedHeight : undefined,
        height: showThumb ? collapsedHeight : undefined,
      }}
    >
      {isWatchingPreview && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            height: 3,
            background: "linear-gradient(90deg, rgba(14,165,233,0.22), rgba(34,211,238,0.95), rgba(20,184,166,0.22))",
            backgroundSize: "220% 100%",
            backgroundPosition: `${waveX} 0`,
            boxShadow: "0 0 14px rgba(34,211,238,0.32)",
            opacity: 0.92,
            pointerEvents: "none",
          }}
        />
      )}
      {isProcessingPreview && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            height: 3,
            background: "linear-gradient(90deg, #38bdf8 0%, #a78bfa 28%, #f59e0b 55%, #22c55e 78%, #38bdf8 100%)",
            backgroundSize: "220% 100%",
            backgroundPosition: `${waveX} 0`,
            boxShadow: "0 0 16px rgba(56,189,248,0.42)",
            opacity: 0.95,
            pointerEvents: "none",
          }}
        />
      )}
      {showThumb && (
        <div
          style={{
            height: "100%",
            width: collapsedHeight,
            position: "relative",
            background: tokens.bg.surface,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 4,
            boxSizing: "border-box",
          }}
        >
          <GifThumb
            gif_url={allowAnimatedPreview ? segment.gif_url : null}
            keyframe_url={segment.keyframe_url}
            width={thumbSize}
            height={thumbSize}
            alt={`${segment.source_label} preview`}
            objectFit="cover"
            objectPosition="center center"
            borderRadius={tokens.radius.lg}
          />
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              background: "linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,0) 70%, rgba(15,23,42,0.04))",
              boxShadow: "inset -1px 0 0 rgba(15,23,42,0.06)",
              pointerEvents: "none",
            }}
          />
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              left: 9,
              bottom: 9,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              maxWidth: thumbSize - 10,
              padding: "2px 6px",
              borderRadius: tokens.radius.pill,
              background: "rgba(15,23,42,0.72)",
              color: "#fff",
              fontSize: 9,
              fontWeight: 750,
              letterSpacing: "0.01em",
              pointerEvents: "none",
            }}
          >
            <Icon name="play" size={9} color="#fff" />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{durationLabel}</span>
          </div>
        </div>
      )}
      <div
        style={{
          minWidth: 0,
          padding: "7px 10px 6px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-start",
          gap: 4,
        }}
      >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minWidth: 0 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0, flex: 1 }}>
              <span
                aria-hidden="true"
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: isWatchingPreview ? "#22d3ee" : statusColor,
                  boxShadow: isWatchingPreview
                    ? "0 0 0 3px rgba(34,211,238,0.16), 0 0 14px rgba(34,211,238,0.48)"
                    : isProcessingPreview
                    ? `0 0 0 3px ${statusColor}24, 0 0 16px ${statusColor}88`
                    : `0 0 0 3px ${statusColor}20`,
                  transform: isWatchingPreview || isProcessingPreview
                    ? `scale(${1 + Math.sin((wavePhase / 1600) * Math.PI * 2) * (isWatchingPreview ? 0.12 : 0.18)})`
                    : undefined,
                  flexShrink: 0,
                }}
              />
              {renderTitle()}
            </span>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "flex-end",
                gap: 6,
                minWidth: 0,
                flexShrink: 0,
              }}
            >
              {metadata.map((item, index) => (
                <span
                  key={`${item.key}-${index}`}
                  aria-label={item.kind === "category" ? item.label : item.kind === "icon" ? item.title : item.label}
                  title={item.kind === "category" ? item.label : item.kind === "icon" ? item.title : item.label}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    minWidth: 0,
                    fontSize: 10,
                    fontWeight: 650,
                    color: item.kind === "category"
                      ? tokens.text.secondary
                      : item.tone === "alert"
                      ? tokens.semantic.amber
                      : item.tone === "rule"
                        ? tokens.semantic.purple
                        : item.tone === "muted"
                          ? tokens.text.faint
                          : tokens.text.muted,
                    whiteSpace: "nowrap",
                  }}
                >
                  {item.kind === "category" ? (
                    <Icon name={item.icon} size={12} color="currentColor" />
                  ) : item.kind === "icon" ? (
                    <Icon name={item.icon} size={13} color="currentColor" />
                  ) : (
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{item.label}</span>
                  )}
                </span>
              ))}
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 500,
                  color: tokens.text.faint,
                  whiteSpace: "nowrap",
                }}
              >
                {formatSegmentInterval(segment)}
              </span>
            </span>
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              alignItems: "center",
              fontSize: 13,
              color: segment.is_static ? tokens.text.muted : tokens.text.primary,
              lineHeight: 1.32,
              overflow: "hidden",
            }}
          >
            <span
              style={{
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {segment.summary}
            </span>
          </div>
      </div>
      </div>
  );

  // Static segments render as a plain article (not clickable, no inner button).
  if (!clickable) {
    return <article style={outerStyle}>{body}</article>;
  }

  return (
    <article style={outerStyle}>
      <button
        type="button"
        onClick={onClick}
        aria-pressed={selected}
        aria-expanded={expanded}
        aria-label={`Segment at ${formatSegmentAriaTime(segment)}`}
        style={buttonStyle}
      >
        {body}
      </button>
      {expanded && <SegmentDetail segment={segment} getEntityName={getEntityName} />}
    </article>
  );
}
