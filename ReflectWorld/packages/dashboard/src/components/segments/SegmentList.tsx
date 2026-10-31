import { useMemo } from "react";
import { AnimatePresence, motion } from "motion/react";
import { tokens, getCameraColor } from "../../theme/tokens";
import type { Segment } from "../../hooks/useSegments";
import type { Selection } from "../../types";
import { SegmentCard } from "./SegmentCard";
import { DateSeparator, TimelineCell } from "./Timeline";
import { FilterBar } from "../shared/FilterBar";

interface SegmentListProps {
  segments: Segment[];
  selection: Selection;
  /** When true, each segment row is prefixed with a timeline cell. */
  timelineEnabled: boolean;
  onSelectSegment: (segment_id: string) => void;
  /** Clear current filter (e.g. when the user clicks the ✕). */
  onClearFilter: () => void;
  /** Right-side slot — typically the Entities toggle button. */
  rightSlot?: React.ReactNode;
  /** Resolve entity_id to a display name for segment detail rendering. */
  getEntityName?: (entity_id: string) => string;
  /** Resolve the current filter label to show in the FilterBar. */
  filterLabel?: string;
  /** User-facing label for the selected source; avoids exposing internal ids. */
  sourceLabel?: string;
}

function isMatch(seg: Segment, selection: Selection): boolean {
  switch (selection.kind) {
    case "none":
      return true;
    case "segment":
      return seg.segment_id === selection.segment_id;
    case "entity":
      return seg.entity_ids.includes(selection.entity_id);
    case "rule":
      return seg.triggered_rules.includes(selection.rule_id);
  }
}

function canExpandSegment(segment: Segment): boolean {
  return segment.timeline_type === "segment"
    && segment.analysis_status !== "partial"
    && segment.is_partial !== true;
}

function isProcessingPreview(segment: Segment): boolean {
  return segment.vlm_model === "processing-preview";
}

function isCompletedSegment(segment: Segment): boolean {
  return segment.timeline_type === "segment"
    && segment.is_partial !== true
    && segment.analysis_status !== "partial"
    && segment.analysis_status !== "skipped"
    && segment.vlm_model !== "watching-preview"
    && segment.vlm_model !== "queued-preview"
    && segment.vlm_model !== "processing-preview";
}

function formatDateLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatTimeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatMediaTimeLabel(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function usesMediaTimeline(segment: Segment): boolean {
  return segment.display_time_mode === "media" || segment.is_media_source;
}

function displayTimeMs(segment: Segment): number {
  return segment.display_start_time ?? segment.start_time;
}

function displayTimeLabel(segment: Segment): string {
  const ms = displayTimeMs(segment);
  return usesMediaTimeline(segment) ? formatMediaTimeLabel(ms) : formatTimeLabel(ms);
}

function formatDurationLabel(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  const secs = rounded % 60;
  if (minutes <= 0) return `${secs}s`;
  if (secs === 0) return `${minutes}m`;
  return `${minutes}m ${secs}s`;
}

function dayKey(ms: number): string {
  // Local-date key (YYYY-MM-DD) so DST transitions are handled correctly.
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function segmentGroupKey(segment: Segment): string {
  if (usesMediaTimeline(segment)) return `media:${segment.camera_id}`;
  return dayKey(segment.start_time);
}

function segmentGroupLabel(segment: Segment): string {
  if (usesMediaTimeline(segment)) return segment.source_label || segment.camera_id;
  return formatDateLabel(segment.start_time);
}

interface RenderEntry {
  type: "segment";
  segment: Segment;
  selected: boolean;
  dimmed: boolean;
  expanded: boolean;
  /** Show a time label in the timeline cell. True for top-of-minute rows. */
  showTimeLabel: boolean;
}

interface SeparatorEntry {
  type: "separator";
  key: string;
  label: string;
}

type ListEntry = RenderEntry | SeparatorEntry;

const listMotionTransition = {
  layout: { duration: 0.16, ease: "easeOut" as const },
  opacity: { duration: 0.12 },
  y: { duration: 0.12, ease: "easeOut" as const },
};

function AnimatedListItem({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={listMotionTransition}
      style={{ position: "relative" }}
    >
      {children}
    </motion.div>
  );
}

function StaticGapRow({ segment, dimmed }: { segment: Segment; dimmed: boolean }) {
  return (
    <div
      aria-label={`Static scene for ${formatDurationLabel(segment.duration_sec)}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        minHeight: 34,
        margin: "4px 0 8px",
        opacity: dimmed ? 0.32 : 0.76,
        color: tokens.text.muted,
        fontSize: 11,
        fontWeight: 650,
        letterSpacing: "-0.08px",
      }}
    >
      <span style={{ flex: 1, height: 1, background: "rgba(138,150,170,0.22)" }} />
      <span style={{ whiteSpace: "nowrap" }}>
        ··· Static Scene · {formatDurationLabel(segment.duration_sec)}
        {segment.merged_count > 1 ? ` · ${segment.merged_count} segments` : ""}
      </span>
      <span style={{ flex: 1, height: 1, background: "rgba(138,150,170,0.22)" }} />
    </div>
  );
}

function MomentPill({
  label,
  count,
  active = false,
  tone,
}: {
  label: string;
  count: number;
  active?: boolean;
  tone?: "alert";
}) {
  const isAlert = tone === "alert";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "6px 10px",
        borderRadius: tokens.radius.pill,
        fontSize: 11,
        fontWeight: 700,
        background: active ? tokens.accent.soft : isAlert ? tokens.semantic.amberSoft : tokens.bg.inset,
        color: active ? tokens.accent.base : isAlert ? tokens.semantic.amber : tokens.text.secondary,
        boxShadow: active ? "inset 0 0 0 1px rgba(47,109,246,0.08)" : "none",
      }}
    >
      {label}
      <span style={{ color: active || isAlert ? "currentColor" : tokens.text.faint }}>{count}</span>
    </span>
  );
}

/**
 * Main segment column. Renders:
 * - Column header (icon + title + count + optional right slot)
 * - FilterBar (active when `selection.kind !== "none"`)
 * - Scrollable list with optional timeline column
 * - Cross-day date separators in timeline mode
 *
 * Filter behavior: preserve original order; filtering only changes
 * highlight/expansion and dims non-matching rows.
 */
export function SegmentList({
  segments,
  selection,
  timelineEnabled,
  onSelectSegment,
  onClearFilter,
  rightSlot,
  getEntityName,
  filterLabel,
  sourceLabel,
}: SegmentListProps) {
  const animatedPreviewSegmentIds = useMemo(() => {
    const ids = new Set<string>();
    const latestProcessing = segments.find(isProcessingPreview);
    if (latestProcessing?.gif_url) ids.add(latestProcessing.segment_id);

    let completedCount = 0;
    for (const segment of segments) {
      if (completedCount >= 3) break;
      if (!segment.gif_url || !isCompletedSegment(segment)) continue;
      ids.add(segment.segment_id);
      completedCount += 1;
    }
    return ids;
  }, [segments]);

  const entries = useMemo<ListEntry[]>(() => {
    const visible: RenderEntry[] = [];
    const filterActive = selection.kind !== "none";

    // Precompute which rows should display a time label (first segment per minute).
    const minuteBucketFirstIndex = new Map<number, number>();
    segments.forEach((s, idx) => {
      const minute = Math.floor(displayTimeMs(s) / 60_000);
      if (!minuteBucketFirstIndex.has(minute)) minuteBucketFirstIndex.set(minute, idx);
    });

    segments.forEach((segment, idx) => {
      const match = isMatch(segment, selection);
      const minute = Math.floor(displayTimeMs(segment) / 60_000);
      // Rule selection highlights + expands every matching segment simultaneously
      // (plan §7: "Click a rule → multi-select all triggered segments").
      // Segment selection highlights/expands exactly one. Entity / none selection
      // leave `selected` + `expanded` off and rely on dimming for focus.
      const isSingleSegmentPick =
        selection.kind === "segment" && selection.segment_id === segment.segment_id;
      const isRuleHit = selection.kind === "rule" && match;
      const highlighted = isSingleSegmentPick || isRuleHit;
      const entry: RenderEntry = {
        type: "segment",
        segment,
        selected: highlighted,
        dimmed: filterActive && !match,
        expanded: highlighted && canExpandSegment(segment),
        showTimeLabel: minuteBucketFirstIndex.get(minute) === idx,
      };
      visible.push(entry);
    });

    // Insert cross-day date separators only when timeline is enabled AND no filter
    // is active. When filtering we want a clean two-bucket layout.
    if (!timelineEnabled || filterActive) {
      return visible;
    }

    const out: ListEntry[] = [];
    let lastKey: string | null = null;
    for (const entry of visible) {
      const key = segmentGroupKey(entry.segment);
      if (lastKey !== null && key !== lastKey) {
        out.push({
          type: "separator",
          key: `sep-${entry.segment.segment_id}`,
          label: segmentGroupLabel(entry.segment),
        });
      }
      lastKey = key;
      out.push(entry);
    }
    return out;
  }, [segments, selection, timelineEnabled]);

  const filterActive = selection.kind !== "none";
  const peopleCount = segments.filter(s =>
    s.targets.some(t => t.type === "person" || t.type === "human"),
  ).length;
  const alertCount = segments.filter(s => s.notification_fired || s.triggered_rules.length > 0).length;
  const latestDayLabel = segments[0]
    ? usesMediaTimeline(segments[0])
      ? sourceLabel ?? segments[0].source_label
      : dayKey(segments[0].start_time) === dayKey(Date.now())
        ? "today"
        : formatDateLabel(segments[0].start_time)
    : "waiting";

  return (
    <div
      style={{
        flex: 1,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        padding: "14px 14px 12px",
        minWidth: 0,
      }}
    >
      {/* Column header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexShrink: 0, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0, flex: "1 1 auto" }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: tokens.text.primary, letterSpacing: "-0.35px" }}>
            Moments
          </span>
          <span
            title={latestDayLabel}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: tokens.text.faint,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {latestDayLabel}
          </span>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <MomentPill active label="All" count={segments.length} />
          <MomentPill label="Person" count={peopleCount} />
          {alertCount > 0 && <MomentPill label="Alerts" count={alertCount} tone="alert" />}
          {rightSlot}
        </div>
      </div>

      {/* Filter bar — visibility toggled so layout height stays stable. */}
      <FilterBar
        label={filterLabel ?? ""}
        onClear={onClearFilter}
        visible={filterActive && Boolean(filterLabel)}
      />

      {/* Scroll area */}
      <div style={{ flex: 1, overflowY: "auto", padding: "2px 3px 4px" }}>
        <div style={{ maxWidth: timelineEnabled ? 620 : undefined, margin: timelineEnabled ? "0 auto" : undefined }}>
          {entries.length === 0 && (
            <div style={{ color: tokens.text.muted, fontSize: 13, padding: 16, textAlign: "center" }}>
              Awaiting segments...
            </div>
          )}
          <AnimatePresence initial={false}>
            {entries.map(entry => {
              if (entry.type === "separator") {
                return (
                  <AnimatedListItem key={entry.key}>
                    <DateSeparator label={entry.label} />
                  </AnimatedListItem>
                );
              }
              const { segment, selected, dimmed, expanded, showTimeLabel } = entry;
              const key = `${segment.timeline_type}-${segment.segment_id}`;
              if (segment.timeline_type === "static_gap") {
                const gap = <StaticGapRow segment={segment} dimmed={dimmed} />;
                if (!timelineEnabled) {
                  return <AnimatedListItem key={key}>{gap}</AnimatedListItem>;
                }
                return (
                  <AnimatedListItem key={key}>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "56px 1fr",
                        alignItems: "center",
                      }}
                    >
                      <TimelineCell
                        color={getCameraColor(segment.camera_id)}
                        isStatic
                        ruleTriggered={false}
                        timeLabel={
                          showTimeLabel
                            ? displayTimeLabel(segment)
                            : ""
                        }
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>{gap}</div>
                    </div>
                  </AnimatedListItem>
                );
              }
              const card = (
                <SegmentCard
                  segment={segment}
                  selected={selected}
                  dimmed={dimmed}
                  expanded={expanded}
                  allowAnimatedPreview={animatedPreviewSegmentIds.has(segment.segment_id)}
                  onClick={() => onSelectSegment(segment.segment_id)}
                  getEntityName={getEntityName}
                />
              );
              if (!timelineEnabled) {
                return <AnimatedListItem key={key}>{card}</AnimatedListItem>;
              }
              return (
                <AnimatedListItem key={key}>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "56px 1fr",
                      alignItems: "start",
                    }}
                  >
                    <TimelineCell
                      color={getCameraColor(segment.camera_id)}
                      isStatic={segment.is_static}
                      ruleTriggered={segment.triggered_rules.length > 0}
                      timeLabel={
                        showTimeLabel
                          ? displayTimeLabel(segment)
                          : ""
                      }
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>{card}</div>
                  </div>
                </AnimatedListItem>
              );
            })}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
