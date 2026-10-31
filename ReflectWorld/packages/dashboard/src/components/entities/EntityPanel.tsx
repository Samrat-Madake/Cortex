import { useMemo } from "react";
import { tokens } from "../../theme/tokens";
import type { EntityAlias, SemanticMemory, Selection } from "../../types";
import type { EntitySighting } from "../../hooks/useEntitySightings";
import { EntityCard } from "./EntityCard";
import type { EntityActivity } from "./EntityDetail";
import { FilterBar } from "../shared/FilterBar";

interface EntityPanelProps {
  entities: EntityAlias[];
  sightingsMap: Map<string, number>;
  camerasMap: Map<string, string[]>;
  activityMap: Map<string, EntityActivity[]>;
  semanticMap: Map<string, SemanticMemory[]>;
  sightingsGalleryMap: Map<string, EntitySighting[]>;
  selection: Selection;
  onSelectEntity: (entity_id: string) => void;
  onClearFilter: () => void;
  /** Label shown in the FilterBar when a cross-column filter targets a segment/rule. */
  filterLabel?: string;
  /** Fill the parent height and let the internal entity list scroll. */
  fillHeight?: boolean;
  /**
   * Cross-column filter set. When present, only entities whose ids appear in
   * this Set stay bright; the rest dim. `undefined` means no cross-column
   * filter is active (all entities stay bright). An empty Set dims every
   * entity — used for rule selections until Phase 2 adds triggered segments.
   */
  selectedEntityIds?: Set<string>;
}

interface DisplayEntry {
  entity: EntityAlias;
  sightings: number;
  cameras: string[];
  activity: EntityActivity[];
  semantic: SemanticMemory[];
  gallery: EntitySighting[];
  selected: boolean;
  dimmed: boolean;
  expanded: boolean;
}

function PanelPill({ label, active = false }: { label: string; active?: boolean }) {
  return (
    <span
      style={{
        padding: "5px 9px",
        borderRadius: tokens.radius.pill,
        fontSize: 11,
        fontWeight: 700,
        background: active ? tokens.accent.soft : tokens.bg.inset,
        color: active ? tokens.accent.base : tokens.text.secondary,
      }}
    >
      {label}
    </span>
  );
}

/**
 * Right-column entity panel.
 * - Header shows count.
 * - FilterBar reflects active cross-column selection.
 * - Entity list preserves original order; filtering only changes emphasis.
 */
export function EntityPanel({
  entities,
  sightingsMap,
  camerasMap,
  activityMap,
  semanticMap,
  sightingsGalleryMap,
  selection,
  onSelectEntity,
  onClearFilter,
  filterLabel,
  fillHeight = true,
  selectedEntityIds,
}: EntityPanelProps) {
  const entries = useMemo<DisplayEntry[]>(() => {
    const filterActive = selection.kind !== "none";
    const visible: DisplayEntry[] = [];

    for (const entity of entities) {
      const selected =
        selection.kind === "entity" && selection.entity_id === entity.entity_id;

      // Cross-column filter resolution:
      // - entity selection: only the selected entity stays bright
      // - segment/rule selection: caller passes `selectedEntityIds` — entities
      //   whose id is in the set stay bright, others dim. Empty set = dim all.
      // - no selection: no filter, everything bright.
      let isMatch: boolean;
      if (selection.kind === "entity") {
        isMatch = entity.entity_id === selection.entity_id;
      } else if (selectedEntityIds) {
        isMatch = selectedEntityIds.has(entity.entity_id);
      } else {
        isMatch = true;
      }

      const entry: DisplayEntry = {
        entity,
        sightings: sightingsMap.get(entity.entity_id) ?? 0,
        cameras: camerasMap.get(entity.entity_id) ?? [],
        activity: activityMap.get(entity.entity_id) ?? [],
        semantic: semanticMap.get(entity.entity_id) ?? [],
        gallery: sightingsGalleryMap.get(entity.entity_id) ?? [],
        selected,
        dimmed: filterActive && !isMatch,
        expanded: selected,
      };
      const hasEvidence =
        entry.sightings > 0 ||
        entry.cameras.length > 0 ||
        entry.activity.length > 0 ||
        entry.gallery.length > 0;
      if (!hasEvidence) continue;
      visible.push(entry);
    }
    return visible;
  }, [
    entities,
    selection,
    selectedEntityIds,
    sightingsMap,
    camerasMap,
    activityMap,
    semanticMap,
    sightingsGalleryMap,
  ]);

  const filterActive = selection.kind !== "none";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: fillHeight ? "100%" : undefined }}>
      <div
        style={{
          fontSize: 15,
          fontWeight: 700,
          color: tokens.text.primary,
          letterSpacing: "-0.35px",
          marginBottom: 8,
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexShrink: 0,
        }}
      >
        Entity
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: tokens.text.muted,
            background: tokens.bg.inset,
            padding: "3px 9px",
            borderRadius: tokens.radius.pill,
          }}
        >
          {entries.length}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <PanelPill active label="Live" />
          <PanelPill label="All" />
        </span>
      </div>

      <FilterBar
        label={filterLabel ?? ""}
        onClear={onClearFilter}
        visible={filterActive && Boolean(filterLabel)}
      />

      <div
        style={{
          flex: fillHeight ? 1 : undefined,
          overflowY: fillHeight ? "auto" : "visible",
          padding: "2px 4px 4px 2px",
          margin: "-2px -4px -4px -2px",
        }}
      >
        {entries.length === 0 && (
          <div style={{ color: tokens.text.muted, fontSize: 13, padding: 16, textAlign: "center" }}>
            No entities identified yet.
          </div>
        )}
        {entries.map(entry => (
          <EntityCard
            key={entry.entity.entity_id}
            entity={entry.entity}
            sightings={entry.sightings}
            cameras={entry.cameras}
            lastActivityPreview={entry.activity.slice(0, 3)}
            recentActivity={entry.activity}
            semanticMemories={entry.semantic}
            sightingGallery={entry.gallery}
            selected={entry.selected}
            dimmed={entry.dimmed}
            expanded={entry.expanded}
            onClick={() => onSelectEntity(entry.entity.entity_id)}
          />
        ))}
      </div>
    </div>
  );
}
