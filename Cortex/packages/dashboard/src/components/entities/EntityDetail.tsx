import { tokens } from "../../theme/tokens";
import type { EntityAlias, SemanticMemory } from "../../types";
import type { EntitySighting } from "../../hooks/useEntitySightings";
import { SightingThumb } from "./SightingThumb";

export interface EntityActivity {
  /** Unix ms timestamp for the activity row. */
  time: number;
  camera_id: string;
  source_label?: string;
  is_media_source?: boolean;
  behavior: string;
}

interface EntityDetailProps {
  entity: EntityAlias;
  semanticMemories: SemanticMemory[];
  recentActivity: EntityActivity[];
  sightings: EntitySighting[];
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatMediaTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatActivityTime(activity: EntityActivity): string {
  return activity.is_media_source ? formatMediaTime(activity.time) : formatTime(activity.time);
}

/**
 * Expanded entity content: semantic memory list, sightings gallery placeholder,
 * and recent activity list. Matches prototype `.ent-det` block.
 */
export function EntityDetail({ entity, semanticMemories, recentActivity, sightings }: EntityDetailProps) {
  void entity; // reserved for future header decoration; keep param for API clarity
  return (
    <div style={{ padding: 12, borderTop: "1px solid rgba(0,0,0,0.05)" }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: tokens.semantic.purple,
          marginBottom: 6,
          display: "flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        <span aria-hidden="true">🧠</span>
        Semantic Memory
        <span
          style={{
            fontSize: 10,
            color: tokens.text.muted,
            fontWeight: 400,
            marginLeft: "auto",
          }}
        >
          {semanticMemories.length} {semanticMemories.length === 1 ? "entry" : "entries"}
        </span>
      </div>

      {semanticMemories.length === 0 ? (
        <div
          style={{
            fontSize: 12,
            color: tokens.text.faint,
            fontStyle: "italic",
            padding: "4px 0 8px",
          }}
        >
          No semantic memories yet.
        </div>
      ) : (
        semanticMemories.map(mem => (
          <div
            key={mem.memory_id}
            style={{
              fontSize: 12,
              color: tokens.text.secondary,
              lineHeight: 1.6,
              background: tokens.bg.inset,
              padding: "10px 12px",
              borderRadius: tokens.radius.md,
              marginBottom: 6,
            }}
          >
            {mem.summary || "(empty memory)"}
          </div>
        ))
      )}

      <DetLabel>
        Sightings
        {sightings.length > 0 && (
          <span
            style={{
              fontSize: 10,
              color: tokens.text.muted,
              fontWeight: 400,
              marginLeft: "auto",
            }}
          >
            {sightings.length}
          </span>
        )}
      </DetLabel>
      {sightings.length === 0 ? (
        <div
          style={{
            fontSize: 12,
            color: tokens.text.faint,
            fontStyle: "italic",
            padding: "4px 0 8px",
          }}
        >
          No visual sightings yet.
        </div>
      ) : (
        <div
          role="list"
          aria-label="Entity sightings gallery"
          style={{
            display: "flex",
            gap: 6,
            overflowX: "auto",
            padding: "4px 0",
          }}
        >
          {sightings.slice(0, 20).map((s, i) => (
            <SightingThumb key={`${s.timestamp}-${i}`} sighting={s} />
          ))}
        </div>
      )}

      <DetLabel>Recent Activity</DetLabel>
      {recentActivity.length === 0 ? (
        <div
          style={{
            fontSize: 12,
            color: tokens.text.faint,
            fontStyle: "italic",
            padding: "4px 0",
          }}
        >
          No recent activity.
        </div>
      ) : (
        recentActivity.map((a, i) => (
          <div
            key={`${a.time}-${i}`}
            style={{
              display: "grid",
              gridTemplateColumns: "64px 1fr",
              gap: 10,
              alignItems: "start",
              padding: "7px 0",
              fontSize: 12,
              color: tokens.text.secondary,
              borderBottom:
                i === recentActivity.length - 1 ? "none" : "1px solid rgba(0,0,0,0.03)",
            }}
          >
            <span
              style={{
                fontSize: 10,
                color: tokens.text.muted,
                whiteSpace: "nowrap",
                paddingTop: 1,
              }}
            >
              {formatActivityTime(a)}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ lineHeight: 1.45 }}>{a.behavior}</div>
              {!a.is_media_source && (a.source_label || a.camera_id) && (
                <div
                  style={{
                    marginTop: 3,
                    fontSize: 10,
                    color: tokens.text.faint,
                  }}
                >
                  {a.source_label ?? a.camera_id}
                </div>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function DetLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 600,
        color: tokens.text.muted,
        textTransform: "uppercase",
        letterSpacing: "0.03em",
        margin: "10px 0 6px",
      }}
    >
      {children}
    </div>
  );
}
