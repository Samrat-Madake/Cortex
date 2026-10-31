import { tokens } from "../../theme/tokens";

interface FilterBarProps {
  /** Filter descriptor rendered inside the pill (e.g. `"Person A"` or `"Segment 15:30"`). */
  label: string;
  /** Clears the active filter. */
  onClear: () => void;
  /**
   * When false, the bar reserves its layout space via `visibility: hidden`
   * so the header row does not jump as the filter toggles on/off.
   */
  visible: boolean;
}

/**
 * Small status bar shown above a filterable list column.
 * Displays the current filter as an accent-tinted pill with a `✕ Clear` link.
 */
export function FilterBar({ label, onClear, visible }: FilterBarProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        minHeight: 24,
        flexShrink: 0,
        visibility: visible ? "visible" : "hidden",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          padding: "3px 10px",
          borderRadius: tokens.radius.pill,
          fontSize: 11,
          fontWeight: 500,
          background: tokens.accent.soft,
          color: tokens.accent.base,
          border: `1px solid ${tokens.accent.border}`,
        }}
      >
        {label}
      </span>
      <button
        type="button"
        onClick={onClear}
        style={{
          fontSize: 11,
          color: tokens.accent.base,
          cursor: "pointer",
          textDecoration: "underline",
          border: "none",
          background: "none",
          fontFamily: "inherit",
          padding: 0,
        }}
      >
        ✕ Clear
      </button>
    </div>
  );
}
