import { useState } from "react";
import { getCameraColor, tokens } from "../../theme/tokens";
import type { MediaSourceSession } from "../../hooks/useMediaSources";
import { Icon } from "../../theme/icons";

export type CameraTabItem = MediaSourceSession;

interface CameraTabsProps {
  cameras: CameraTabItem[];
  active: string | null;
  onSelect: (id: string) => void;
  onStart?: (id: string) => void;
  onStop?: (id: string) => void;
  onRemove?: (id: string) => void;
  onInfo?: (id: string) => void;
  onUploadVideo?: () => void;
  onAddStream?: () => void;
}

/**
 * Horizontal pill switcher for the available cameras.
 *
 * The active pill is filled with `tokens.accent.base` and casts a subtle
 * accent-colored shadow; inactive pills use `tokens.bg.elevated` with the
 * generic shadow border. Matches the prototype's `.cam-chip` block.
 */
export function CameraTabs({ cameras, active, onSelect, onStart, onStop, onRemove, onInfo, onUploadVideo, onAddStream }: CameraTabsProps) {
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  if (cameras.length === 0) {
    return (
      <div style={{ fontSize: 11, color: tokens.text.muted, fontStyle: "italic" }}>
        No cameras connected
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div
        style={{
          fontSize: 15,
          fontWeight: 700,
          color: tokens.text.primary,
          letterSpacing: "-0.35px",
        }}
      >
        Sources
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <div style={{ display: "flex", flex: 1, minWidth: 0, gap: 6, overflowX: "auto", paddingBottom: 1 }}>
          {cameras.map((camera) => {
            const isActive = camera.id === active;
            const cameraColor = getCameraColor(camera.id);
            const status = camera.status ?? "active";
            const canStart = !camera.isVideo && camera.canStart === true && Boolean(onStart);
            const canStop = !camera.isVideo && camera.canStop === true && Boolean(onStop);
            const statusColor = status === "unavailable"
              ? tokens.semantic.red
              : status === "stopped"
                ? tokens.text.faint
              : status === "reconnecting" || status === "waiting"
                ? tokens.semantic.amber
                : cameraColor;
            const subLabel = camera.isVideo ? "" : camera.meta ?? status;
            return (
              <div
                key={camera.id}
                className="source-chip"
                style={{
                  display: "inline-flex",
                  alignItems: "stretch",
                  position: "relative",
                  width: 148,
                  height: 42,
                  borderRadius: 14,
                  background: isActive ? "linear-gradient(180deg, #1a2234, #111827)" : "rgba(255,255,255,0.84)",
                  color: isActive ? "#fff" : tokens.text.primary,
                  boxShadow: isActive ? "0 14px 28px -22px rgba(10,16,28,0.95)" : "0 8px 22px -18px rgba(15,23,42,0.3)",
                  overflow: "hidden",
                  flexShrink: 0,
                }}
              >
                <button
                  type="button"
                  onClick={() => onSelect(camera.id)}
                  aria-pressed={isActive}
                  style={{
                    display: "block",
                    flex: 1,
                    width: "100%",
                    minWidth: 0,
                    padding: "7px 8px",
                    cursor: "pointer",
                    border: "none",
                    fontFamily: tokens.font.sans,
                    background: "transparent",
                    color: "inherit",
                    textAlign: "left",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                    <span
                      title={camera.isVideo ? "Uploaded video" : "Live stream"}
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 999,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: isActive ? "rgba(255,255,255,0.12)" : tokens.bg.inset,
                        color: isActive ? "rgba(255,255,255,0.82)" : tokens.text.secondary,
                      }}
                    >
                      <Icon name={camera.isVideo ? "film" : "play"} size={13} />
                    </span>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: "block", fontSize: 12, fontWeight: 750, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {camera.label}
                      </span>
                      {subLabel ? (
                        <span style={{ display: "block", marginTop: 1, fontSize: 9, color: isActive ? "rgba(255,255,255,0.58)" : tokens.text.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {subLabel}
                        </span>
                      ) : null}
                    </span>
                    <span
                      aria-hidden="true"
                      title={status}
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: statusColor,
                        boxShadow: `0 0 0 3px ${isActive ? "rgba(255,255,255,0.12)" : "rgba(47,109,246,0.08)"}`,
                      }}
                    />
                  </div>
                </button>
                {(onInfo || canStart || canStop || (camera.canRemove && onRemove)) ? (
                  <div
                    className="source-actions"
                    style={{
                      position: "absolute",
                      top: 0,
                      right: 0,
                      height: "100%",
                      visibility: "hidden",
                      pointerEvents: "none",
                      display: "inline-flex",
                    }}
                  >
                    {onInfo ? (
                      <button
                        type="button"
                        aria-label={`Show scene understanding for ${camera.label}`}
                        title={`Show scene understanding for ${camera.label}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onInfo(camera.id);
                        }}
                        style={{
                          width: 30,
                          height: "100%",
                          border: "none",
                          borderLeft: `1px solid ${isActive ? "#334155" : "#e2e8f0"}`,
                          background: isActive ? "#1e293b" : "#eff6ff",
                          color: tokens.accent.base,
                          cursor: "pointer",
                          fontFamily: tokens.font.sans,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Icon name="info" size={13} color="currentColor" />
                      </button>
                    ) : null}
                    {canStart ? (
                      <button
                        type="button"
                        aria-label={`Start watch for ${camera.label}`}
                        title={`Start watch for ${camera.label}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onStart?.(camera.id);
                        }}
                        style={{
                          width: 30,
                          height: "100%",
                          border: "none",
                          borderLeft: `1px solid ${isActive ? "#334155" : "#e2e8f0"}`,
                          background: isActive ? "#14532d" : "#f0fdf4",
                          color: tokens.semantic.green,
                          cursor: "pointer",
                          fontFamily: tokens.font.sans,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Icon name="play" size={12} color={tokens.semantic.green} />
                      </button>
                    ) : null}
                    {canStop ? (
                      <button
                        type="button"
                        aria-label={`Stop watch for ${camera.label}`}
                        title={`Stop watch for ${camera.label}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onStop?.(camera.id);
                        }}
                        style={{
                          width: 30,
                          height: "100%",
                          border: "none",
                          borderLeft: `1px solid ${isActive ? "#334155" : "#e2e8f0"}`,
                          background: isActive ? "#78350f" : "#fffbeb",
                          color: tokens.semantic.amber,
                          cursor: "pointer",
                          fontFamily: tokens.font.sans,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Icon name="stop" size={12} color={tokens.semantic.amber} />
                      </button>
                    ) : null}
                    {camera.canRemove && onRemove ? (
                      <button
                        type="button"
                        aria-label={`Delete ${camera.label}`}
                        title={`Delete ${camera.label}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onRemove(camera.id);
                        }}
                        style={{
                          width: 30,
                          height: "100%",
                          border: "none",
                          borderLeft: `1px solid ${isActive ? "#334155" : "#e2e8f0"}`,
                          borderRadius: "0 14px 14px 0",
                          background: isActive ? "#7f1d1d" : "#fef2f2",
                          color: tokens.semantic.red,
                          cursor: "pointer",
                          fontFamily: tokens.font.sans,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Icon name="trash" size={13} color={tokens.semantic.red} />
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        {(onUploadVideo || onAddStream) ? (
          <div style={{ position: "relative", flexShrink: 0 }}>
            <button
              type="button"
              aria-label="Add source"
              title="Add source"
              onClick={() => setAddMenuOpen((open) => !open)}
              style={{
                width: 34,
                height: 34,
                border: "none",
                borderRadius: "50%",
                background: tokens.bg.elevated,
                color: tokens.accent.base,
                cursor: "pointer",
                boxShadow: tokens.shadow.border,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: tokens.font.sans,
              }}
            >
              <Icon name="plus" size={18} />
            </button>
            {addMenuOpen && (
              <div
                style={{
                  position: "absolute",
                  top: 40,
                  right: 0,
                  zIndex: 20,
                  width: 148,
                  padding: 5,
                  borderRadius: tokens.radius.md,
                  background: tokens.bg.surface,
                  boxShadow: tokens.shadow.elevated,
                  display: "flex",
                  flexDirection: "column",
                  gap: 3,
                }}
              >
                {onUploadVideo && (
                  <AddSourceMenuButton
                    icon="upload"
                    label="Upload video"
                    onClick={() => {
                      setAddMenuOpen(false);
                      onUploadVideo();
                    }}
                  />
                )}
                {onAddStream && (
                  <AddSourceMenuButton
                    icon="link"
                    label="Stream URL"
                    onClick={() => {
                      setAddMenuOpen(false);
                      onAddStream();
                    }}
                  />
                )}
              </div>
            )}
          </div>
        ) : null}
      </div>
      <style>{`
        .source-actions:focus-within,
        .source-chip:hover > .source-actions {
          visibility: visible !important;
          pointer-events: auto !important;
        }
      `}</style>
    </div>
  );
}

function AddSourceMenuButton({
  icon,
  label,
  onClick,
}: {
  icon: "upload" | "link";
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: "none",
        borderRadius: tokens.radius.sm,
        padding: "7px 8px",
        background: "transparent",
        color: tokens.text.secondary,
        cursor: "pointer",
        fontFamily: tokens.font.sans,
        fontSize: 11,
        fontWeight: 700,
        display: "flex",
        alignItems: "center",
        gap: 7,
        textAlign: "left",
      }}
    >
      <Icon name={icon} size={13} color={tokens.accent.base} />
      {label}
    </button>
  );
}
