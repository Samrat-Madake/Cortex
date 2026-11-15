import { useState } from "react";
import { Icon, type IconName } from "../../theme/icons";
import { tokens } from "../../theme/tokens";
import type { Segment, SegmentTarget } from "../../hooks/useSegments";
import { TargetRow } from "./TargetRow";

interface SegmentDetailProps {
  segment: Segment;
  /** Resolve an entity_id to its display name (e.g. "Person A"). Optional. */
  getEntityName?: (entity_id: string) => string;
}

/** Map a VLM-reported target type string to our icon sprite. */
function iconForType(type: string): IconName {
  const t = type.toLowerCase();
  if (t === "person" || t === "human") return "person";
  if (t === "dog" || t === "cat" || t === "animal" || t === "pet") return "pet";
  if (t === "vehicle" || t === "car" || t === "truck" || t === "van") return "car";
  return "cube";
}

function targetDisplayName(t: SegmentTarget, getEntityName?: (id: string) => string): string {
  if (t.label) return t.label;
  if (t.name) return t.name;
  if (t.person_name) return t.person_name;
  if (t.identity) return t.identity;
  if (t.subject_index) return `${capitalize(t.type || "object")} ${t.subject_index}`;
  if (t.entity_id) return getEntityName ? getEntityName(t.entity_id) : "Unknown";
  if (t.target_id) return capitalize(t.type) || "Unknown";
  return capitalize(t.type) || "Unknown";
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function toMediaUrl(absPath: string | undefined | null): string | null {
  if (!absPath) return null;
  const marker = "/media/";
  const idx = absPath.indexOf(marker);
  if (idx < 0) return null;
  return `/media/${absPath.slice(idx + marker.length)}`;
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

function formatSegmentInterval(segment: Segment): string {
  if (segment.is_static || segment.duration_sec <= 0) return "snapshot";
  const start = formatSegmentClock(segment, segment.display_start_time ?? segment.start_time);
  const end = formatSegmentClock(segment, segment.display_end_time ?? segment.end_time);
  if (start === end) return start;
  return `${start} - ${end}`;
}

function formatDuration(segment: Segment): string {
  if (segment.is_static && segment.merged_count > 1) return `${segment.merged_count} merged`;
  if (segment.duration_sec > 0) {
    const rounded = Math.round(segment.duration_sec);
    if (rounded < 60) return `${rounded}s`;
    return `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
  }
  return "snapshot";
}

function formatDialogueTimestamp(segment: Segment, seconds: number | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
  return formatSegmentClock(segment, (segment.display_start_time ?? segment.start_time) + Math.round(seconds * 1000));
}

function speakerDisplayName(
  segment: Segment,
  line: Segment["dialogue"][number],
  lineIndex: number,
  getEntityName?: (id: string) => string,
): string {
  if (line.speaker) return line.speaker;
  if (line.entity_id && getEntityName) return getEntityName(line.entity_id);
  return `Speaker ${lineIndex + 1}`;
}

/**
 * Expanded segment content rendered below a `SegmentCard` when selected.
 * Matches the prototype's `.seg-det` block.
 */
export function SegmentDetail({ segment, getEntityName }: SegmentDetailProps) {
  const [showPolicyPrompt, setShowPolicyPrompt] = useState(false);
  const hasRules = segment.triggered_rules.length > 0;
  const ruleLabels = segment.triggered_rule_labels.filter(Boolean);
  const displayedRules = ruleLabels.length > 0 ? ruleLabels : segment.triggered_rules;
  const hasNotifications = segment.notification_fired && segment.notification_reasons.length > 0;
  const hasDialogue = Boolean(
    segment.dialogue.length > 0,
  );
  const targetsWithCrop = segment.targets
    .map((target, index) => ({ target, index, cropUrl: toMediaUrl(target.crop_path) }))
    .filter((item): item is { target: SegmentTarget; index: number; cropUrl: string } => Boolean(item.cropUrl));
  return (
    <div
      style={{
        padding: "12px",
        borderTop: "1px solid rgba(31,45,71,0.07)",
        background: "linear-gradient(180deg, rgba(246,248,252,0.5), rgba(255,255,255,0.9))",
      }}
    >
      <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
        <div
          style={{
            width: 216,
            height: 136,
            borderRadius: tokens.radius.md,
            background: tokens.bg.videoFrame,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            position: "relative",
            boxShadow: "0 12px 24px -18px rgba(3,9,24,0.85)",
          }}
        >
          {segment.clip_url ? (
            <video
              src={segment.clip_url}
              poster={segment.keyframe_url ?? undefined}
              controls
              preload="none"
              style={{
                width: "100%",
                height: "100%",
                objectFit: "contain",
                background: tokens.bg.videoFrame,
                borderRadius: tokens.radius.md,
              }}
            />
          ) : (
            <>
              {segment.keyframe_url && (
                <img
                  src={segment.keyframe_url}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "cover", opacity: 0.72 }}
                />
              )}
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "rgba(0,0,0,0.3)",
                }}
              >
                <Icon name="play" size={32} color="#fff" />
              </div>
            </>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: tokens.text.secondary, lineHeight: 1.68 }}>
            {segment.detailed_summary || segment.summary}
          </div>
        </div>
      </div>

      {hasDialogue && (
        <>
          <DetLabel>Dialogue</DetLabel>
          <div
            style={{
              padding: "9px 10px",
              borderRadius: tokens.radius.md,
              background: "rgba(255,255,255,0.78)",
              color: tokens.text.secondary,
              fontSize: 11,
              lineHeight: 1.55,
              boxShadow: "inset 0 0 0 1px rgba(31,45,71,0.05)",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {segment.dialogue.slice(0, 6).map((line, index) => {
                const speaker = speakerDisplayName(segment, line, index, getEntityName);
                const timestamp = formatDialogueTimestamp(segment, line.text_start);
                return (
                  <div key={`${line.text_start ?? index}-${line.text ?? ""}`}>
                    <span style={{ color: tokens.text.muted }}>
                      {timestamp ? `${timestamp} · ` : ""}{speaker}
                    </span>
                    {line.text && <span>{`: ${line.text}`}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      <DetLabel>Detected Entity</DetLabel>
      {targetsWithCrop.length === 0 ? (
        <div style={{ fontSize: 11, color: tokens.text.faint, fontStyle: "italic", padding: "4px 0" }}>
          No visual entity in this segment.
        </div>
      ) : (
        targetsWithCrop.map(({ target: t, index: i, cropUrl }) => {
          return (
            <TargetRow
              key={t.entity_id ?? t.ref ?? t.target_id ?? `${t.type}-${i}`}
              thumb_url={cropUrl}
              image_is_crop={true}
              bbox={t.bbox}
              face_bbox={t.face_bbox}
              display_name={targetDisplayName(t, getEntityName)}
              behavior={t.behavior || undefined}
              appearance={t.appearance || undefined}
              identified={Boolean(t.entity_id || t.ref !== undefined || t.has_name)}
              icon={iconForType(t.type)}
            />
          );
        })
      )}

      {hasNotifications && <DetLabel>Notifications</DetLabel>}
      {hasNotifications && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {segment.notification_reasons.map((reason, index) => (
            <SurfaceReason key={`${reason}-${index}`} tone="alert" icon="eye" label={reason} />
          ))}
        </div>
      )}
      {hasRules && (
        <div style={{ marginTop: hasNotifications ? 8 : 0 }}>
          <DetLabel>Triggered Rules</DetLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {displayedRules.map((rule, index) => (
              <SurfaceReason key={`${rule}-${index}`} tone="rule" icon="cube" label={rule} />
            ))}
          </div>
        </div>
      )}

      {segment.segment_policy_prompt && (
        <>
          <DetLabel>Adaptive Prompt</DetLabel>
          <button
            type="button"
            onClick={() => setShowPolicyPrompt((value) => !value)}
            style={{
              border: "none",
              borderRadius: tokens.radius.pill,
              padding: "7px 10px",
              background: tokens.bg.elevated,
              color: tokens.text.secondary,
              cursor: "pointer",
              fontFamily: tokens.font.sans,
              fontSize: 11,
              fontWeight: 700,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              boxShadow: tokens.shadow.border,
            }}
          >
            <Icon name="cube" size={13} color="currentColor" />
            {showPolicyPrompt ? "Hide adaptive prompt" : "Show adaptive prompt"}
          </button>
          {showPolicyPrompt && (
            <pre
              style={{
                margin: "8px 0 0",
                padding: "10px 12px",
                borderRadius: tokens.radius.md,
                background: tokens.bg.inset,
                color: tokens.text.secondary,
                fontFamily: "'SFMono-Regular', Consolas, monospace",
                fontSize: 11,
                lineHeight: 1.55,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                boxShadow: "inset 0 0 0 1px rgba(31,45,71,0.05)",
              }}
            >
              {segment.segment_policy_prompt}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

function DetLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 600,
        color: tokens.text.muted,
        textTransform: "uppercase",
        letterSpacing: "0.03em",
        margin: "8px 0 6px",
      }}
    >
      {children}
    </div>
  );
}

function SurfaceReason({
  tone,
  icon,
  label,
}: {
  tone: "alert" | "rule";
  icon: IconName;
  label: string;
}) {
  const isAlert = tone === "alert";
  return (
    <div
      style={{
        padding: "8px 10px",
        background: isAlert ? tokens.semantic.amberSoft : tokens.semantic.purpleSoft,
        borderRadius: tokens.radius.md,
        fontSize: 11,
        color: isAlert ? tokens.semantic.amber : tokens.semantic.purple,
        lineHeight: 1.5,
        display: "flex",
        alignItems: "flex-start",
        gap: 6,
      }}
    >
      <Icon name={icon} size={14} color={isAlert ? tokens.semantic.amber : tokens.semantic.purple} />
      <span>{label}</span>
    </div>
  );
}
