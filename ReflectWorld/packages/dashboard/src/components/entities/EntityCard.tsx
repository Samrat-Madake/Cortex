import { useCallback, useState } from "react";
import { Icon } from "../../theme/icons";
import { tokens } from "../../theme/tokens";
import type { EntityAlias, SemanticMemory } from "../../types";
import type { EntitySighting } from "../../hooks/useEntitySightings";
import { EntityDetail, type EntityActivity } from "./EntityDetail";

interface EntityCardProps {
  entity: EntityAlias;
  sightings: number;
  cameras: string[];
  /** Up to 2-3 latest behavior strings shown as a compact preview on the card. */
  lastActivityPreview?: EntityActivity[];
  /** Full recent activity list used only when expanded. */
  recentActivity?: EntityActivity[];
  semanticMemories?: SemanticMemory[];
  sightingGallery?: EntitySighting[];
  selected: boolean;
  dimmed: boolean;
  expanded: boolean;
  onClick: () => void;
}

function formatHourMin(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
  return activity.is_media_source ? formatMediaTime(activity.time) : formatHourMin(activity.time);
}

function formatRelative(ms: number): string {
  const delta = Math.max(0, Date.now() - ms);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function avatarGradient(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  const palette = [
    ["#ffe2bd", "#ffd0a0"],
    ["#dbeafe", "#bfdbfe"],
    ["#ede9fe", "#ddd6fe"],
    ["#dcfce7", "#bbf7d0"],
    ["#fff0bc", "#fde68a"],
  ];
  const [from, to] = palette[Math.abs(hash) % palette.length];
  return `linear-gradient(135deg, ${from}, ${to})`;
}

function scoreAvatarFace(sighting: EntitySighting): number {
  const face = sighting.face_bbox;
  if (!sighting.keyframe_url || !face || face.width <= 0 || face.height <= 0) return -1;
  if (typeof sighting.avatar_score === "number") return sighting.avatar_score;
  const area = face.width * face.height;
  const aspectRatio = face.width / face.height;
  const faceLikeRatioPenalty = Math.abs(Math.log(Math.max(0.1, aspectRatio) / 0.75));
  return area - faceLikeRatioPenalty * 1_000;
}

function selectStableAvatarSighting(sightings: EntitySighting[]): EntitySighting | undefined {
  const faceSightings = sightings
    .filter((sighting) => scoreAvatarFace(sighting) >= 0)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, 3)
    .sort((a, b) => {
      const scoreDelta = scoreAvatarFace(b) - scoreAvatarFace(a);
      if (Math.abs(scoreDelta) > 1e-6) return scoreDelta;
      return a.timestamp - b.timestamp;
    });
  if (faceSightings[0]) return faceSightings[0];
  return sightings.find((sighting) => sighting.keyframe_url) ?? sightings[0];
}

function expandCrop(
  crop: { x: number; y: number; width: number; height: number },
  naturalSize: { w: number; h: number },
  padding: { x: number; top: number; bottom: number },
) {
  const padX = crop.width * padding.x;
  const padTop = crop.height * padding.top;
  const padBottom = crop.height * padding.bottom;
  const x = Math.max(0, crop.x - padX);
  const y = Math.max(0, crop.y - padTop);
  const right = Math.min(naturalSize.w, crop.x + crop.width + padX);
  const bottom = Math.min(naturalSize.h, crop.y + crop.height + padBottom);
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

function EntityAvatar({
  displayName,
  sighting,
}: {
  displayName: string;
  sighting?: EntitySighting;
}) {
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const isBackendCrop = sighting?.image_is_crop === true;
  const faceCrop = sighting?.face_bbox ?? null;
  const bodyCrop = sighting?.bbox ?? null;
  const crop = isBackendCrop ? null : (faceCrop ?? bodyCrop);
  const imageSrc = sighting?.keyframe_url ?? null;
  const handleLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
  }, []);

  if (!imageSrc || (!isBackendCrop && (!crop || crop.width <= 0 || crop.height <= 0))) {
    return (
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: "50%",
          flexShrink: 0,
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: avatarGradient(displayName),
          boxShadow: "0 0 0 2px #fff, 0 10px 18px -14px rgba(31,45,71,0.75)",
        }}
      >
        <Icon name="person" size={22} color={tokens.accent.base} />
      </div>
    );
  }

  let imgStyle: React.CSSProperties = {
    position: "absolute",
    opacity: 0,
    width: 0,
    height: 0,
  };
  let bgStyle: React.CSSProperties | null = null;
  if (isBackendCrop) {
    bgStyle = {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      objectFit: "cover",
      filter: "blur(7px)",
      transform: "scale(1.12)",
      opacity: 0.42,
    };
    imgStyle = {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      objectFit: "contain",
      left: 0,
      top: 0,
      maxWidth: "none",
    };
  } else if (naturalSize && crop) {
    const displayCrop = faceCrop
      ? expandCrop(crop, naturalSize, { x: 0.55, top: 0.48, bottom: 0.9 })
      : crop;
    const targetSize = faceCrop ? 44 : 34;
    const scale = faceCrop
      ? Math.max(44 / displayCrop.width, 44 / displayCrop.height)
      : Math.min(targetSize / displayCrop.width, targetSize / displayCrop.height);
    const bboxCenterX = (displayCrop.x + displayCrop.width / 2) * scale;
    const bboxCenterY = (displayCrop.y + displayCrop.height / 2) * scale;
    imgStyle = {
      position: "absolute",
      width: naturalSize.w * scale,
      height: naturalSize.h * scale,
      left: 22 - bboxCenterX,
      top: 22 - bboxCenterY,
      maxWidth: "none",
    };
    if (!faceCrop) {
      bgStyle = {
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
        filter: "blur(7px)",
        transform: "scale(1.12)",
        opacity: 0.45,
      };
    }
  }

  return (
    <div
      style={{
        width: 44,
        height: 44,
        borderRadius: "50%",
        flexShrink: 0,
        overflow: "hidden",
        position: "relative",
        background: tokens.bg.hover,
        boxShadow: "0 0 0 2px #fff, 0 10px 18px -14px rgba(31,45,71,0.75)",
      }}
    >
      {bgStyle && (
        <img
          src={imageSrc}
          alt=""
          draggable={false}
          style={bgStyle}
        />
      )}
      <img
        src={imageSrc}
        alt=""
        onLoad={handleLoad}
        draggable={false}
        style={imgStyle}
      />
    </div>
  );
}

/**
 * Entity row in the right panel — photo + name/pills/meta + recent behavior
 * preview. Expands to `EntityDetail` when `expanded` is true.
 * Matches prototype `.ent` / `.ent-body` / `.ent-recent`.
 */
export function EntityCard({
  entity,
  sightings,
  cameras,
  lastActivityPreview = [],
  recentActivity = [],
  semanticMemories = [],
  sightingGallery = [],
  selected,
  dimmed,
  expanded,
  onClick,
}: EntityCardProps) {
  // Outer <article> owns the card chrome (shadow, selected ring, dimmed
  // opacity). The inner <button> targets only the summary body so the
  // expanded <EntityDetail> (with its scrollable gallery + future interactive
  // controls) sits as a sibling and can receive its own events.
  const outerStyle: React.CSSProperties = {
    background: selected ? "linear-gradient(180deg, #ffffff, #f8fbff)" : tokens.bg.surface,
    borderRadius: 16,
    marginBottom: 8,
    boxShadow: selected ? tokens.shadow.selected : tokens.shadow.card,
    transition: "box-shadow 0.2s, opacity 0.2s, transform 0.2s",
    overflow: "hidden",
    opacity: dimmed ? 0.24 : 1,
    pointerEvents: dimmed ? "none" : "auto",
    display: "block",
  };

  const buttonStyle: React.CSSProperties = {
    background: "transparent",
    cursor: "pointer",
    width: "100%",
    textAlign: "left",
    border: "none",
    padding: 0,
    color: "inherit",
    fontFamily: "inherit",
    display: "block",
  };
  const latestActivity = lastActivityPreview[0];
  const firstCamera = cameras[0];
  const avatarSighting = selectStableAvatarSighting(sightingGallery);

  return (
    <article style={outerStyle}>
      <button
        type="button"
        onClick={onClick}
        aria-pressed={selected}
        aria-expanded={expanded}
        aria-label={`Entity ${entity.display_name}`}
        style={buttonStyle}
      >
        <div style={{ display: "flex", gap: 11, padding: 11 }}>
          <EntityAvatar displayName={entity.display_name} sighting={avatarSighting} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 800,
                  letterSpacing: "-0.25px",
                  color: tokens.text.primary,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                }}
              >
                {entity.display_name}
              </span>
              <span
                aria-hidden="true"
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: tokens.semantic.green,
                  boxShadow: "0 0 0 3px rgba(34,197,94,0.10)",
                }}
              />
              <span
                style={{
                  marginLeft: "auto",
                  fontSize: 10,
                  fontWeight: 800,
                  color: tokens.text.muted,
                  background: tokens.bg.inset,
                  padding: "2px 7px",
                  borderRadius: tokens.radius.pill,
                }}
              >
                {sightings}
              </span>
            </div>
            <div
              style={{
                marginTop: 5,
                display: "flex",
                alignItems: "center",
                gap: 5,
                fontSize: 11,
                color: tokens.text.muted,
                minWidth: 0,
              }}
            >
              {firstCamera && !latestActivity?.is_media_source && (
                <>
                  <span
                    aria-hidden="true"
                    style={{
                      width: 4,
                      height: 4,
                      borderRadius: "50%",
                      background: tokens.accent.base,
                    }}
                  />
                  <span style={{ whiteSpace: "nowrap" }}>{firstCamera}</span>
                </>
              )}
              {latestActivity && (
                <>
                  {firstCamera && !latestActivity.is_media_source && <span style={{ color: tokens.text.faint }}>·</span>}
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      minWidth: 0,
                    }}
                  >
                    {latestActivity.behavior}
                  </span>
                  <span style={{ marginLeft: "auto", color: tokens.text.faint, whiteSpace: "nowrap" }}>
                    {latestActivity.is_media_source ? formatMediaTime(latestActivity.time) : formatRelative(latestActivity.time)}
                  </span>
                </>
              )}
              {!latestActivity && sightings > 0 && (
                <span style={{ color: tokens.text.faint }}>
                  {sightings} sightings
                </span>
              )}
            </div>
            {latestActivity && (
              <div style={{ marginTop: 5, fontSize: 10, color: tokens.text.faint }}>
                {latestActivity.is_media_source ? `at ${formatActivityTime(latestActivity)}` : `last seen ${formatActivityTime(latestActivity)}`}
              </div>
            )}
          </div>
        </div>
      </button>
      {expanded && (
        <EntityDetail
          entity={entity}
          semanticMemories={semanticMemories}
          recentActivity={recentActivity}
          sightings={sightingGallery}
        />
      )}
    </article>
  );
}
