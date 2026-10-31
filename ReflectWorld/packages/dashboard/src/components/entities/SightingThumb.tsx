import { useState, useCallback } from "react";
import { tokens, getCameraColor } from "../../theme/tokens";
import type { EntitySighting } from "../../hooks/useEntitySightings";

const THUMB_SIZE = 64;

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

function formatSightingTime(sighting: EntitySighting): string {
  return sighting.display_time_mode === "media" ? formatMediaTime(sighting.timestamp) : formatHourMin(sighting.timestamp);
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

/**
 * 64x64 thumbnail with CSS bbox cropping.
 *
 * Sightings are history/evidence thumbnails, so prefer the body bbox to show
 * the full person. Falls back to an expanded face bbox when body crop is absent.
 */
export function SightingThumb({ sighting }: { sighting: EntitySighting }) {
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const handleLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
  }, []);

  const handleError = useCallback(() => setLoadFailed(true), []);

  const isBackendCrop = sighting.image_is_crop;
  const crop = isBackendCrop ? null : (sighting.bbox ?? sighting.face_bbox);
  const usesFaceCrop = !sighting.bbox && Boolean(sighting.face_bbox);
  const hasImage = sighting.keyframe_url && !loadFailed;

  if (!hasImage) return null;

  // Compute CSS transform to crop bbox into the 64x64 container.
  let imgStyle: React.CSSProperties | undefined;
  let bgStyle: React.CSSProperties | undefined;
  if (isBackendCrop && hasImage) {
    bgStyle = {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      objectFit: "cover",
      filter: "blur(8px)",
      transform: "scale(1.12)",
      opacity: 0.38,
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
  } else if (naturalSize && crop && crop.width > 0 && crop.height > 0) {
    const displayCrop = usesFaceCrop
      ? expandCrop(crop, naturalSize, { x: 0.55, top: 0.48, bottom: 0.9 })
      : crop;
    const targetSize = usesFaceCrop ? THUMB_SIZE : THUMB_SIZE - 10;
    const scaleX = targetSize / displayCrop.width;
    const scaleY = targetSize / displayCrop.height;
    const scale = usesFaceCrop ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);

    const imgW = naturalSize.w * scale;
    const imgH = naturalSize.h * scale;

    // Translate so the bbox center is centered in the container.
    const bboxCenterX = (displayCrop.x + displayCrop.width / 2) * scale;
    const bboxCenterY = (displayCrop.y + displayCrop.height / 2) * scale;
    const translateX = THUMB_SIZE / 2 - bboxCenterX;
    const translateY = THUMB_SIZE / 2 - bboxCenterY;

    imgStyle = {
      position: "absolute",
      width: imgW,
      height: imgH,
      left: translateX,
      top: translateY,
      maxWidth: "none",
    };
    if (!usesFaceCrop) {
      bgStyle = {
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
        filter: "blur(8px)",
        transform: "scale(1.12)",
        opacity: 0.42,
      };
    }
  } else if (naturalSize) {
    // No bbox — fit the whole image.
    imgStyle = {
      position: "absolute",
      width: "100%",
      height: "100%",
      objectFit: "cover",
      left: 0,
      top: 0,
    };
  }

  return (
    <div
      style={{ width: THUMB_SIZE, flexShrink: 0, textAlign: "center" }}
      aria-label={`Sighting at ${formatSightingTime(sighting)} on ${sighting.camera_id}`}
    >
      <div
        style={{
          width: THUMB_SIZE,
          height: THUMB_SIZE,
          borderRadius: tokens.radius.sm,
          overflow: "hidden",
          position: "relative",
          background: hasImage
            ? tokens.bg.inset
            : `linear-gradient(135deg, ${tokens.bg.inset}, ${tokens.bg.hover})`,
          marginBottom: 3,
        }}
      >
        {hasImage && (
          <>
            {bgStyle && <img src={sighting.keyframe_url!} alt="" draggable={false} style={bgStyle} />}
            <img
              src={sighting.keyframe_url!}
              alt=""
              onLoad={handleLoad}
              onError={handleError}
              style={
                imgStyle ?? {
                  // Before natural dimensions are known, hide the image to
                  // avoid a flash of the uncropped frame.
                  position: "absolute",
                  opacity: 0,
                  width: 0,
                  height: 0,
                }
              }
              draggable={false}
            />
          </>
        )}
        {sighting.is_new && (
          <span
            style={{
              position: "absolute",
              top: 3,
              right: 3,
              fontSize: 8,
              fontWeight: 700,
              color: "#fff",
              background: tokens.semantic.green,
              padding: "0 4px",
              borderRadius: tokens.radius.sm,
              lineHeight: "14px",
              letterSpacing: "0.02em",
            }}
          >
            NEW
          </span>
        )}
      </div>
      <div
        style={{
          fontSize: 9,
          color: tokens.text.muted,
          lineHeight: 1.3,
        }}
      >
        {formatSightingTime(sighting)}
      </div>
      <div
        style={{
          fontSize: 8,
          color: getCameraColor(sighting.camera_id),
          background: tokens.bg.inset,
          borderRadius: tokens.radius.sm,
          padding: "0 4px",
          display: "inline-block",
          marginTop: 1,
          maxWidth: THUMB_SIZE,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {sighting.camera_id}
      </div>
    </div>
  );
}
