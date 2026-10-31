import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { Icon } from "../../theme/icons";
import { tokens } from "../../theme/tokens";

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  mode?: "text" | "voice";
  voiceTurnId?: number;
}

export interface ChatVoiceControls {
  enabled: boolean;
  hotkey: string;
  state: "disabled" | "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error";
  error: string | null;
  interactive: boolean;
  audioLevel?: number;
  onToggle: () => void;
}

interface ChatPanelProps {
  open?: boolean;
  variant?: "floating" | "inline";
  messages: ChatMessage[];
  contextLabel: string;
  suggestions: string[];
  onClose?: () => void;
  onClear?: () => void;
  onSend: (text: string) => void;
  voice?: ChatVoiceControls;
}

export function ChatPanel({
  open = true,
  variant = "floating",
  messages,
  contextLabel,
  suggestions,
  onClose,
  onClear,
  onSend,
  voice,
}: ChatPanelProps) {
  const [input, setInput] = useState("");
  const msgsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const el = msgsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  if (!open) return null;

  const handleSubmit = () => {
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (shouldSubmitChatOnKeyDown({
      key: e.key,
      shiftKey: e.shiftKey,
      isComposing: composingRef.current || e.nativeEvent.isComposing,
      keyCode: e.nativeEvent.keyCode,
    })) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const inline = variant === "inline";
  const showVoiceWaveform = voice?.enabled && voice.state === "listening";
  const showVoiceHotkey = voice?.enabled && voice.state === "listening" && Boolean(voice.hotkey);
  const panelStyle: CSSProperties = {
    position: inline ? "relative" : "fixed",
    bottom: inline ? undefined : 120,
    right: inline ? undefined : 28,
    width: inline ? "100%" : 440,
    maxWidth: inline ? undefined : "calc(100vw - 40px)",
    height: inline ? "auto" : "min(560px, calc(100vh - 168px))",
    minHeight: inline ? 220 : undefined,
    flex: inline ? "1 1 0" : undefined,
    background: tokens.bg.surface,
    border: "1px solid rgba(15,23,42,0.08)",
    borderRadius: inline ? 20 : 24,
    boxShadow: inline ? tokens.shadow.card : "0 26px 70px rgba(15,23,42,0.18)",
    zIndex: inline ? undefined : 150,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    fontFamily: tokens.font.sans,
  };

  return (
    <div
      role={inline ? "region" : "dialog"}
      aria-modal="false"
      aria-labelledby={titleId}
      style={panelStyle}
    >
      <style>{chatPanelKeyframes}</style>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 12px",
          borderBottom: "1px solid rgba(15,23,42,0.06)",
          minWidth: 0,
          gap: 8,
        }}
      >
        <div id={titleId} style={{ minWidth: 0, flex: "1 1 auto", overflow: "hidden" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              color: tokens.text.muted,
              fontSize: 11,
              minWidth: 0,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: tokens.accent.base,
                flexShrink: 0,
              }}
            />
            <span
              title={contextLabel}
              style={{
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ color: tokens.text.primary, fontWeight: 500 }}>Chat</span>
              <span style={{ color: tokens.text.faint, padding: "0 5px" }}>·</span>
              {contextLabel}
            </span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {messages.length > 0 && onClear && (
            <button
              type="button"
              aria-label="Clear chat"
              title="Clear chat"
              onClick={onClear}
              style={{
                border: "none",
                background: tokens.bg.inset,
                borderRadius: 999,
                cursor: "pointer",
                color: tokens.text.muted,
                width: 30,
                height: 30,
                fontFamily: "inherit",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name="trash" size={14} color={tokens.text.muted} />
            </button>
          )}
          {!inline && onClose && (
            <button
              type="button"
              aria-label="Close chat"
              onClick={onClose}
              style={{
                border: "none",
                background: tokens.bg.inset,
                borderRadius: 999,
                cursor: "pointer",
                fontSize: 16,
                color: tokens.text.muted,
                width: 30,
                height: 30,
                lineHeight: 1,
                fontFamily: "inherit",
              }}
            >
              <Icon name="close" size={14} color={tokens.text.muted} />
            </button>
          )}
        </div>
      </div>

      <div
        ref={msgsRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "14px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {messages.length === 0 && (
          <EmptyState
            suggestions={suggestions}
            onSend={(text) => {
              onSend(text);
              inputRef.current?.focus();
            }}
          />
        )}
        {messages.map((msg, idx) => (
          <ChatBubble key={idx} role={msg.role} text={msg.text} />
        ))}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          padding: "12px",
          borderTop: "1px solid rgba(15,23,42,0.06)",
          background: "linear-gradient(180deg, rgba(248,250,252,0.35), rgba(248,250,252,0.72))",
        }}
      >
        {voice?.enabled && voice.state !== "idle" && voice.state !== "disabled" && (
          <div
            style={{
              alignSelf: "stretch",
              borderRadius: 12,
              padding: "6px 9px",
              background: voice.state === "error"
                ? "rgba(239,68,68,0.08)"
                : voice.state === "listening"
                  ? "rgba(34,197,94,0.1)"
                  : tokens.accent.soft,
              color: voice.state === "error"
                ? tokens.semantic.red
                : voice.state === "listening"
                  ? tokens.semantic.green
                  : tokens.text.secondary,
              fontSize: 11,
              lineHeight: 1.35,
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span>{voiceStatusText(voice)}</span>
            {showVoiceHotkey && <span style={{ color: tokens.text.faint, fontWeight: 650 }}>{voice.hotkey}</span>}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
          {showVoiceWaveform ? (
            <VoiceWaveform level={voice.audioLevel ?? 0} />
          ) : (
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; }}
              placeholder="Ask about current scene, targets, or recent segments..."
              aria-label="Chat message"
              rows={1}
              style={{
                flex: 1,
                border: "none",
                background: tokens.bg.surface,
                fontSize: 13,
                fontFamily: tokens.font.sans,
                color: tokens.text.primary,
                outline: "none",
                padding: "12px",
                borderRadius: 16,
                boxSizing: "border-box",
                height: 44,
                minHeight: 44,
                maxHeight: 44,
                resize: "none",
                lineHeight: "20px",
                overflowY: "auto",
                boxShadow: "inset 0 0 0 1px rgba(15,23,42,0.08)",
              }}
            />
          )}
          {voice?.enabled && (
            <ChatIconButton
              ariaLabel={voice.state === "listening" ? "Stop voice input" : "Start voice input"}
              title={voiceTitle(voice)}
              icon={voice.state === "speaking" ? "speaker" : "mic"}
              tone={voiceButtonTone(voice.state)}
              busy={voice.state === "connecting" || voice.state === "thinking"}
              disabled={!voice.interactive}
              onClick={voice.onToggle}
            />
          )}
          <ChatIconButton
            ariaLabel="Send message"
            title="Send"
            icon="send"
            onClick={handleSubmit}
          />
        </div>
      </div>
    </div>
  );
}

export function shouldSubmitChatOnKeyDown(event: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode?: number;
}): boolean {
  return event.key === "Enter"
    && !event.shiftKey
    && !event.isComposing
    && event.keyCode !== 229;
}

function VoiceWaveform({ level }: { level: number }) {
  const bars = [12, 20, 28, 18, 34, 24, 14, 30, 22, 16, 27, 19, 32, 21, 13];
  const weights = [0.45, 0.82, 1.12, 0.68, 1.25, 0.98, 0.56, 1.18, 0.88, 0.62, 1.06, 0.74, 1.22, 0.84, 0.5];
  const normalized = Math.max(0, Math.min(1, level));
  return (
    <div
      aria-label="Listening"
      role="status"
      style={{
        flex: 1,
        height: 44,
        minHeight: 44,
        borderRadius: 16,
        boxSizing: "border-box",
        background: "linear-gradient(135deg, rgba(34,197,94,0.12), rgba(34,197,94,0.04))",
        boxShadow: "inset 0 0 0 1px rgba(34,197,94,0.22)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        overflow: "hidden",
      }}
    >
      {bars.map((height, index) => (
        <span
          key={index}
          style={{
            width: 4,
            height: Math.max(5, Math.min(38, Math.round(5 + height * (0.18 + normalized * (weights[index] ?? 1))))),
            borderRadius: 999,
            background: tokens.semantic.green,
            opacity: 0.34 + Math.min(1, normalized * (weights[index] ?? 1)) * 0.62,
            transformOrigin: "center",
            transition: "height 70ms linear, opacity 70ms linear",
          }}
        />
      ))}
    </div>
  );
}

function EmptyState({
  suggestions,
  onSend,
}: {
  suggestions: string[];
  onSend: (text: string) => void;
}) {
  return (
    <div
      style={{
        border: "1px solid rgba(15,23,42,0.08)",
        background: "linear-gradient(145deg, rgba(248,250,252,0.98), rgba(255,255,255,0.9))",
        borderRadius: 20,
        padding: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 14,
            background: tokens.accent.soft,
            color: tokens.accent.base,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Icon name="chat" size={18} />
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 650, color: tokens.text.primary }}>
            Ask against the current dashboard context
          </div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 10 }}>
        {suggestions.map(suggestion => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onSend(suggestion)}
            onKeyDown={(event) => {
              if (event.key === " ") event.preventDefault();
            }}
            style={{
              border: "1px solid rgba(15,23,42,0.08)",
              background: tokens.bg.surface,
              borderRadius: 14,
              padding: "9px 11px",
              color: tokens.text.secondary,
              fontSize: 12,
              fontFamily: "inherit",
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

function ChatBubble({ role, text }: { role: "user" | "assistant"; text: string }) {
  const isUser = role === "user";
  const style: CSSProperties = {
    padding: "10px 12px",
    borderRadius: 16,
    fontSize: 13,
    lineHeight: 1.48,
    maxWidth: "88%",
    background: isUser ? tokens.accent.base : tokens.bg.inset,
    color: isUser ? "#fff" : tokens.text.secondary,
    alignSelf: isUser ? "flex-end" : "flex-start",
    borderBottomRightRadius: isUser ? 5 : 16,
    borderBottomLeftRadius: isUser ? 16 : 5,
    boxShadow: isUser ? "0 8px 20px rgba(37,99,235,0.2)" : "inset 0 0 0 1px rgba(15,23,42,0.04)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  };
  return <div style={style}>{text}</div>;
}

interface ChatIconButtonProps {
  ariaLabel: string;
  title: string;
  icon: "send" | "mic" | "speaker";
  tone?: "accent" | "success" | "danger" | "working";
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

function ChatIconButton({
  ariaLabel,
  title,
  icon,
  tone = "accent",
  busy = false,
  disabled = false,
  onClick,
}: ChatIconButtonProps) {
  const background = tone === "success"
    ? tokens.semantic.green
    : tone === "danger"
      ? tokens.semantic.red
      : tone === "working"
        ? tokens.semantic.amber
        : tokens.accent.base;
  const borderColor = background;
  const shadow = tone === "success"
    ? "0 10px 24px rgba(34,197,94,0.24)"
    : tone === "danger"
    ? "0 10px 24px rgba(239,68,68,0.24)"
    : tone === "working"
      ? "0 10px 24px rgba(245,158,11,0.24)"
      : "0 10px 24px rgba(37,99,235,0.22)";
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={title}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        width: 44,
        height: 44,
        borderRadius: "50%",
        border: `1px solid ${borderColor}`,
        background,
        color: "#fff",
        cursor: disabled ? "not-allowed" : "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "inherit",
        boxShadow: shadow,
        opacity: disabled ? 0.55 : 1,
        flexShrink: 0,
        position: "relative",
      }}
    >
      {busy && <span aria-hidden="true" style={spinnerStyle} />}
      <Icon name={icon} size={17} color="#fff" />
    </button>
  );
}

function voiceTitle(voice: ChatVoiceControls): string {
  const suffix = voice.hotkey ? ` (${voice.hotkey})` : "";
  if (voice.error) return `${voice.error}${suffix}`;
  if (voice.state === "listening") return `Stop voice input${suffix}`;
  if (voice.state === "thinking") return `Processing voice input${suffix}`;
  if (voice.state === "speaking") return `Speaking${suffix}`;
  if (voice.state === "connecting") return `Connecting voice${suffix}`;
  return `Start voice input${suffix}`;
}

function voiceStatusText(voice: ChatVoiceControls): string {
  if (voice.error) return voice.error;
  if (voice.state === "connecting") return "Connecting voice input...";
  if (voice.state === "listening") return "Listening. Click mic again to stop.";
  if (voice.state === "thinking") return "Processing your question...";
  if (voice.state === "speaking") return "Speaking response...";
  return "Voice input ready.";
}

function voiceButtonTone(state: ChatVoiceControls["state"]): "accent" | "success" | "danger" | "working" {
  if (state === "listening") return "success";
  if (state === "error") return "danger";
  if (state === "connecting" || state === "thinking" || state === "speaking") return "working";
  return "accent";
}

const spinnerStyle: CSSProperties = {
  position: "absolute",
  inset: -3,
  borderRadius: "50%",
  border: "2px solid rgba(255,255,255,0.36)",
  borderTopColor: "#fff",
  animation: "chatVoiceSpin 0.8s linear infinite",
};

const chatPanelKeyframes = `
@keyframes chatVoiceSpin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
`;
