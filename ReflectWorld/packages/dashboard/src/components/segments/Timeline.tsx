import { tokens } from "../../theme/tokens";

interface TimelineCellProps {
  /** Dot fill color (camera palette). Ignored when `static` is true. */
  color: string;
  /** True when the segment is static — renders a hollow circle. */
  isStatic: boolean;
  /** True when the segment has rule triggers — overlays a purple halo. */
  ruleTriggered: boolean;
  /** Optional time label shown under the dot (empty string hides it). */
  timeLabel: string;
}

/**
 * Single timeline cell — a vertical guideline with a colored dot and
 * optional time label. Used as the left column inside `.seg-row` when
 * timeline mode is enabled.
 *
 * Matches prototype `.tl-cell`, `.tl-dot`, `.tl-time`.
 */
export function TimelineCell({ color, isStatic, ruleTriggered, timeLabel }: TimelineCellProps) {
  const dotStyle: React.CSSProperties = ruleTriggered
    ? {
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: tokens.semantic.purple,
        boxShadow: `0 0 0 3px ${tokens.semantic.purpleSoft}`,
        border: `2px solid ${tokens.bg.surface}`,
        position: "relative",
        zIndex: 1,
        flexShrink: 0,
      }
    : isStatic
      ? {
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: "transparent",
          border: `2px solid ${tokens.text.faint}`,
          position: "relative",
          zIndex: 1,
          flexShrink: 0,
        }
      : {
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: color,
          border: `2px solid ${tokens.bg.surface}`,
          position: "relative",
          zIndex: 1,
          flexShrink: 0,
        };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        position: "relative",
        paddingTop: 14,
      }}
    >
      {/* Vertical connector line behind the dot. */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: "50%",
          width: 2,
          background: tokens.bg.inset,
          transform: "translateX(-50%)",
        }}
      />
      <div style={dotStyle} />
      {timeLabel && (
        <div
          style={{
            fontSize: 11,
            color: tokens.text.muted,
            whiteSpace: "nowrap",
            marginTop: 4,
            fontWeight: 500,
          }}
        >
          {timeLabel}
        </div>
      )}
    </div>
  );
}

interface DateSeparatorProps {
  /** Date label (e.g. "Apr 15"). */
  label: string;
}

/**
 * Horizontal bar inserted between segments spanning different calendar days.
 * Mirrors the prototype's `.tl-date-sep` / `.tl-date-line` / `.tl-date-text`.
 */
export function DateSeparator({ label }: DateSeparatorProps) {
  return (
    <div
      style={{
        gridColumn: "1 / -1",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 0",
        margin: "4px 0",
      }}
    >
      <div style={{ flex: 1, height: 1, background: tokens.text.faint, opacity: 0.3 }} />
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: tokens.text.muted,
          whiteSpace: "nowrap",
          padding: "2px 10px",
          background: tokens.bg.inset,
          borderRadius: tokens.radius.pill,
        }}
      >
        {label}
      </div>
      <div style={{ flex: 1, height: 1, background: tokens.text.faint, opacity: 0.3 }} />
    </div>
  );
}
