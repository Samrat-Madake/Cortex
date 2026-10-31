import type { ReactNode } from "react";
import { tokens } from "../../theme/tokens";

interface MainLayoutProps {
  sidebar: ReactNode;
  center: ReactNode;
  entities: ReactNode;
  /** When true, entity panel collapses to 0 width. */
  entitiesCollapsed: boolean;
}

export function MainLayout({ sidebar, center, entities, entitiesCollapsed }: MainLayoutProps) {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        gap: 12,
        overflow: "hidden",
        padding: "12px 18px 10px",
        background:
          "radial-gradient(circle at 18% 0%, rgba(47,109,246,0.09), transparent 28%), radial-gradient(circle at 80% 4%, rgba(22,163,74,0.06), transparent 24%), #f4f6fb",
      }}
    >
      <aside
        style={{
          flex: "0 0 clamp(420px, 39vw, 500px)",
          minWidth: 390,
          maxWidth: 520,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {sidebar}
      </aside>
      <main
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: "rgba(255,255,255,0.54)",
          borderRadius: tokens.radius.lg,
          boxShadow: "0 0 0 1px rgba(31,45,71,0.06)",
          backdropFilter: "blur(18px)",
        }}
      >
        {center}
      </main>
      <aside
        style={{
          flex: entitiesCollapsed ? "0 0 0px" : "0 0 360px",
          overflow: "hidden",
          background: entitiesCollapsed ? "transparent" : "rgba(255,255,255,0.64)",
          borderRadius: tokens.radius.lg,
          boxShadow: entitiesCollapsed ? "none" : "0 0 0 1px rgba(31,45,71,0.06)",
          backdropFilter: entitiesCollapsed ? undefined : "blur(18px)",
          opacity: entitiesCollapsed ? 0 : 1,
          padding: entitiesCollapsed ? 0 : 12,
          transition: "flex 0.3s, padding 0.3s, opacity 0.3s",
        }}
      >
        {entities}
      </aside>
    </div>
  );
}
