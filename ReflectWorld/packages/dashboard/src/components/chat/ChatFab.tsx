import type { CSSProperties } from "react";
import { Icon } from "../../theme/icons";
import { tokens } from "../../theme/tokens";

interface ChatFabProps {
  onClick: () => void;
  open: boolean;
}

/**
 * Floating action button that toggles the chat panel. Fixed bottom-right,
 * purple gradient circle with a chat glyph — mirrors prototype `.chat-fab`.
 */
export function ChatFab({ onClick, open }: ChatFabProps) {
  const style: CSSProperties = {
    position: "fixed",
    bottom: 60,
    right: 28,
    width: 52,
    height: 52,
    borderRadius: "50%",
    background: tokens.accent.base,
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    boxShadow: "0 4px 16px rgba(99,102,241,0.35)",
    zIndex: 150,
    border: "none",
    transition: "transform 0.2s",
    transform: open ? "scale(1.08)" : "scale(1)",
    fontFamily: "inherit",
  };

  return (
    <button
      type="button"
      aria-label={open ? "Close chat" : "Open chat"}
      aria-expanded={open}
      onClick={onClick}
      onMouseEnter={e => {
        e.currentTarget.style.transform = "scale(1.08)";
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = open ? "scale(1.08)" : "scale(1)";
      }}
      style={style}
    >
      <Icon name="chat" size={24} color="#fff" />
    </button>
  );
}
