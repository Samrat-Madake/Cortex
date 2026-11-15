import type { ReactNode } from "react";
import { Icon } from "../../theme/icons";
import { tokens } from "../../theme/tokens";

interface TopBarProps {
  connected: boolean;
  analysisStatus?: string;
  rulesSlot: ReactNode;
  userId: string;
  isAdmin: boolean;
  clearing?: boolean;
  onClearDashboard: () => void;
  onOpenSettings: () => void;
}

export function TopBar({
  connected,
  analysisStatus,
  rulesSlot,
  userId,
  isAdmin,
  clearing = false,
  onClearDashboard,
  onOpenSettings,
}: TopBarProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        minHeight: 44,
        padding: "7px 18px",
        background: "rgba(255,255,255,0.82)",
        boxShadow: "0 1px 0 rgba(31,45,71,0.08)",
        backdropFilter: "blur(18px)",
        flexShrink: 0,
        zIndex: 100,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <img
          src="/logo.png"
          alt="Cortex logo"
          style={{ width: "auto", height: 28, flexShrink: 0, objectFit: "contain" }}
        />
        <div style={{ display: "flex", alignItems: "baseline" }}>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.35px", color: tokens.text.primary }}>
            Cortex
          </span>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {analysisStatus && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: tokens.accent.base,
              maxWidth: 340,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              background: tokens.accent.soft,
              borderRadius: tokens.radius.pill,
              padding: "5px 10px",
            }}
          >
            {analysisStatus}
          </span>
        )}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 10px",
            borderRadius: tokens.radius.pill,
            background: tokens.bg.inset,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: connected ? tokens.semantic.green : tokens.semantic.red,
              boxShadow: connected ? "0 0 6px rgba(34,197,94,0.4)" : "none",
            }}
          />
          <span style={{ fontSize: 11, fontWeight: 600, color: tokens.text.secondary }}>
            {connected ? "Online" : "Offline"}
          </span>
        </div>
        {rulesSlot}
        <button
          type="button"
          onClick={onClearDashboard}
          disabled={clearing}
          aria-label="Clear dashboard data"
          style={{
            height: 36,
            padding: "0 12px",
            background: "#fff1f2",
            color: "#be123c",
            borderRadius: tokens.radius.pill,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: clearing ? "wait" : "pointer",
            boxShadow: tokens.shadow.border,
            border: "none",
            fontSize: 11,
            fontWeight: 700,
            opacity: clearing ? 0.7 : 1,
          }}
        >
          {clearing ? "Clearing..." : "Clear"}
        </button>
        <span
          style={{
            height: 36,
            padding: "0 12px",
            background: tokens.bg.inset,
            borderRadius: tokens.radius.pill,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: tokens.text.muted,
            fontSize: 11,
            fontWeight: 700,
            maxWidth: 160,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={`user_id: ${userId}`}
        >
          {userId}
        </span>
        {isAdmin && (
          <button
            onClick={onOpenSettings}
            aria-label="Open settings"
            style={{
              width: 36,
              height: 36,
              background: tokens.bg.elevated,
              borderRadius: tokens.radius.pill,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              boxShadow: tokens.shadow.border,
              border: "none",
            }}
          >
            <Icon name="gear" size={18} color={tokens.text.muted} />
          </button>
        )}
      </div>
    </div>
  );
}
