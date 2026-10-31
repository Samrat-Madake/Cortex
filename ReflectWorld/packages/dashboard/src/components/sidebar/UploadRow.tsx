import { Icon } from "../../theme/icons";
import { tokens } from "../../theme/tokens";

interface UploadRowProps {
  /** Opens the dashboard video selector/upload dialog. */
  onUploadVideo?: () => void;
  /** When provided the "Stream URL" button is enabled and calls this handler. */
  onAddStream?: () => void;
}

/**
 * Two side-by-side, dashed "Upload video" / "Stream URL" buttons.
 *
 * "Upload video" and "Stream URL" are enabled when the parent supplies their
 * respective callbacks.
 */
export function UploadRow({ onUploadVideo, onAddStream }: UploadRowProps) {
  return (
    <div style={{ display: "flex", gap: 8 }}>
      <UploadButton
        iconName="upload"
        label="Upload video"
        disabled={!onUploadVideo}
        onClick={onUploadVideo}
      />
      <UploadButton
        iconName="link"
        label="Stream URL"
        disabled={!onAddStream}
        onClick={onAddStream}
      />
    </div>
  );
}

function UploadButton({
  iconName,
  label,
  disabled = false,
  onClick,
}: {
  iconName: "upload" | "link";
  label: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const isActive = !disabled && !!onClick;

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      onClick={isActive ? onClick : undefined}
      style={{
        flex: 1,
        height: 38,
        background: isActive ? "rgba(255,255,255,0.74)" : tokens.bg.elevated,
        border: `1px dashed ${isActive ? tokens.accent.border : tokens.text.faint}`,
        borderRadius: tokens.radius.md,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        fontSize: 11,
        fontWeight: 700,
        color: isActive ? tokens.accent.base : tokens.text.muted,
        cursor: isActive ? "pointer" : "not-allowed",
        fontFamily: tokens.font.sans,
        opacity: disabled ? 0.85 : 1,
        boxShadow: "0 8px 18px -18px rgba(31,45,71,0.45)",
        transition: "border-color 0.15s, color 0.15s, background 0.15s",
      }}
    >
      <Icon name={iconName} size={14} />
      {label}
    </button>
  );
}
