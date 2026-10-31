import { useState, useEffect, useCallback, useRef, useId } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { tokens } from "../../theme/tokens";

// ── Config types ──

type ConfigKey = "vlm_model" | "analysis_level" | "capture_mode" | "sampling_rate" | "audio_model";

type RuntimeConfig = Record<ConfigKey, string>;

interface ConfigGroup {
  key: ConfigKey;
  label: string;
  options: Array<{ value: string; label: string }>;
}

const CONFIG_GROUPS: ConfigGroup[] = [
  {
    key: "vlm_model",
    label: "Vision Language Model",
    options: [
      { value: "auto", label: "Auto" },
      { value: "gemini-2.5-flash", label: "Gemini Flash" },
      { value: "gemini-2.5-flash-lite", label: "Flash Lite" },
      { value: "gpt-4o-mini", label: "GPT-4o Mini" },
    ],
  },
  {
    key: "analysis_level",
    label: "Analysis Level",
    options: [
      { value: "auto", label: "Auto" },
      { value: "0", label: "L0 (VLM)" },
      { value: "1", label: "L1 (Det+ReID)" },
      { value: "2", label: "L2 (Full)" },
    ],
  },
  {
    key: "audio_model",
    label: "Audio Model",
    options: [
      { value: "moonshine-tiny", label: "Moonshine Tiny" },
      { value: "none", label: "Disabled" },
    ],
  },
  {
    key: "capture_mode",
    label: "Capture Mode",
    options: [
      { value: "stream", label: "Stream" },
      { value: "event", label: "Event" },
      { value: "snapshot", label: "Snapshot" },
    ],
  },
  {
    key: "sampling_rate",
    label: "Sampling Rate",
    options: [
      { value: "0.5", label: "0.5 fps" },
      { value: "1", label: "1 fps" },
      { value: "2", label: "2 fps" },
      { value: "5", label: "5 fps" },
    ],
  },
];

const DEFAULT_CONFIG: RuntimeConfig = {
  vlm_model: "auto",
  analysis_level: "auto",
  capture_mode: "stream",
  sampling_rate: "1",
  audio_model: "moonshine-tiny",
};

// ── API helpers ──

function getApiBase(): string {
  return `${window.location.protocol}//${window.location.host}`;
}

async function fetchConfig(): Promise<RuntimeConfig> {
  const resp = await fetch(`${getApiBase()}/api/config`);
  if (!resp.ok) throw new Error(`GET /api/config failed: ${resp.status}`);
  return await resp.json() as RuntimeConfig;
}

async function postConfig(key: ConfigKey, value: string): Promise<{ ok: boolean; error?: string }> {
  const resp = await fetch(`${getApiBase()}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  const data = await resp.json() as { ok?: boolean; error?: string };
  if (!resp.ok) throw new Error(data.error ?? `POST /api/config failed: ${resp.status}`);
  return { ok: true };
}

// ── Component ──

interface SettingsOverlayProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Modal settings panel. Fetches runtime config from the backend on open,
 * POSTs changes on pill click with optimistic update + error rollback.
 *
 * Closes on backdrop click, close button, or Escape.
 */
export function SettingsOverlay({ open, onClose }: SettingsOverlayProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [config, setConfig] = useState<RuntimeConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(false);
  const [savingKey, setSavingKey] = useState<ConfigKey | null>(null);
  const [feedback, setFeedback] = useState<{ key: ConfigKey; type: "ok" | "error"; message: string } | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Move focus into the panel when it opens for keyboard accessibility.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  // Fetch config from server when overlay opens
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetchConfig()
      .then((cfg) => setConfig(cfg))
      .catch(() => { /* use defaults on failure */ })
      .finally(() => setLoading(false));
  }, [open]);

  const handleSelect = useCallback(async (key: ConfigKey, value: string) => {
    const previous = config[key];
    if (value === previous) return;

    // Optimistic update
    setConfig((prev) => ({ ...prev, [key]: value }));
    setSavingKey(key);

    try {
      await postConfig(key, value);
      setFeedback({
        key,
        type: "ok",
        message: key === "audio_model" ? "Saved (restart required)" : "Saved",
      });
    } catch (err) {
      // Revert on failure
      setConfig((prev) => ({ ...prev, [key]: previous }));
      setFeedback({
        key,
        type: "error",
        message: err instanceof Error ? err.message : "Failed to save",
      });
    } finally {
      setSavingKey(null);
      // Clear feedback after 2 seconds
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
      feedbackTimer.current = setTimeout(() => setFeedback(null), 2000);
    }
  }, [config]);

  if (!open) return null;

  const handleBackdropClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  const overlayStyle: CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.4)",
    backdropFilter: "blur(4px)",
    WebkitBackdropFilter: "blur(4px)",
    zIndex: 200,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: tokens.font.sans,
  };

  const panelStyle: CSSProperties = {
    background: tokens.bg.surface,
    borderRadius: tokens.radius.lg,
    padding: 24,
    width: 440,
    maxHeight: "80vh",
    overflowY: "auto",
    boxShadow: tokens.shadow.elevated,
    outline: "none",
  };

  return (
    <div style={overlayStyle} onClick={handleBackdropClick} aria-hidden={false}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={panelStyle}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 16,
            fontWeight: 600,
            color: tokens.text.primary,
            marginBottom: 20,
          }}
        >
          <span id={titleId}>Settings</span>
          <button
            type="button"
            aria-label="Close settings"
            onClick={onClose}
            style={{
              border: "none",
              background: "none",
              fontSize: 18,
              cursor: "pointer",
              color: tokens.text.muted,
              padding: 4,
              lineHeight: 1,
              fontFamily: "inherit",
            }}
          >
            X
          </button>
        </div>

        {loading ? (
          <div style={{
            textAlign: "center",
            padding: 20,
            color: tokens.text.muted,
            fontSize: 12,
          }}>
            Loading config...
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {CONFIG_GROUPS.map((group) => (
              <ConfigGroupRow
                key={group.key}
                group={group}
                selected={config[group.key]}
                saving={savingKey === group.key}
                feedback={feedback?.key === group.key ? feedback : null}
                onSelect={(value) => handleSelect(group.key, value)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ──

function ConfigGroupRow({ group, selected, saving, feedback, onSelect }: {
  group: ConfigGroup;
  selected: string;
  saving: boolean;
  feedback: { type: "ok" | "error"; message: string } | null;
  onSelect: (value: string) => void;
}) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 8,
      }}>
        <span style={{
          fontSize: 12,
          fontWeight: 600,
          color: tokens.text.secondary,
        }}>
          {group.label}
        </span>
        {saving && (
          <span style={{
            fontSize: 10,
            color: tokens.semantic.amber,
          }}>
            saving...
          </span>
        )}
        {feedback && (
          <span style={{
            fontSize: 10,
            color: feedback.type === "ok" ? tokens.semantic.green : tokens.semantic.red,
          }}>
            {feedback.message}
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {group.options.map((opt) => {
          const isActive = selected === opt.value;
          const style: CSSProperties = {
            padding: "7px 16px",
            borderRadius: tokens.radius.pill,
            fontSize: 12,
            fontWeight: 500,
            cursor: saving ? "wait" : "pointer",
            border: "none",
            fontFamily: "inherit",
            transition: "all 0.15s",
            background: isActive ? tokens.accent.base : tokens.bg.inset,
            color: isActive ? "#fff" : tokens.text.secondary,
            boxShadow: isActive ? tokens.shadow.accentGlow : tokens.shadow.border,
            opacity: saving ? 0.6 : 1,
          };
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={isActive}
              onClick={() => onSelect(opt.value)}
              disabled={saving}
              style={style}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
