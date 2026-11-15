import { useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "../../theme/icons";
import { tokens } from "../../theme/tokens";
import type { BoundingBox } from "../../hooks/useSegments";

const THUMB_SIZE = 40;

interface TargetRowProps {
  /** Optional cropped thumbnail URL; falls back to an icon-only chip when null. */
  thumb_url: string | null;
  /** True when thumb_url is already a backend-generated target crop. */
  image_is_crop?: boolean;
  /** Body crop in keyframe pixel-space. */
  bbox?: BoundingBox;
  /** Tighter face crop in keyframe pixel-space; fallback when body bbox is absent. */
  face_bbox?: BoundingBox;
  /** Display name (e.g. "Person A", "Dog", "Unknown"). */
  display_name: string;
  /** Behavior description rendered below the name. */
  behavior?: string;
  /** Appearance description rendered below the name. */
  appearance?: string;
  /** True when this target is a face-matched entity (identified). */
  identified: boolean;
  /** Icon used inside the thumb when there is no image (e.g. `person`, `pet`, `car`). */
  icon: IconName;
}

function expandCrop(
  crop: BoundingBox,
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
 * A single row inside `SegmentDetail` showing one detected target.
 * Mirrors the prototype's `.trow.id` (identified) and `.trow.an` (anonymous) styles.
 */
export function TargetRow({ thumb_url, image_is_crop, bbox, face_bbox, display_name, behavior, appearance, identified, icon }: TargetRowProps) {
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    setNaturalSize(null);
    setLoadFailed(false);
  }, [thumb_url]);

  const handleLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
  }, []);

  const handleError = useCallback(() => setLoadFailed(true), []);

  const rowBg = identified ? "rgba(47,109,246,0.06)" : "rgba(246,248,252,0.92)";
  const nameColor = identified ? tokens.text.primary : tokens.text.secondary;
  const thumbBg = identified
    // Matches `.tthumb.face-bg` gradient in prototype (soft lavender).
    ? "linear-gradient(135deg, #e8e5f5, #ddd8f0)"
    : tokens.bg.hover;
  const thumbIconColor = identified ? tokens.accent.base : tokens.text.faint;
  const crop = image_is_crop ? undefined : (face_bbox ?? bbox);
  const usesFaceCrop = Boolean(face_bbox);
  const imageSrc = thumb_url && !loadFailed ? thumb_url : null;

  let imgStyle: React.CSSProperties | undefined;
  let bgStyle: React.CSSProperties | undefined;
  if (image_is_crop && imageSrc) {
    bgStyle = {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      objectFit: "cover",
      filter: "blur(7px)",
      transform: "scale(1.12)",
      opacity: 0.35,
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
    const targetSize = usesFaceCrop ? THUMB_SIZE : THUMB_SIZE - 8;
    const scaleX = targetSize / displayCrop.width;
    const scaleY = targetSize / displayCrop.height;
    const scale = usesFaceCrop ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
    const bboxCenterX = (displayCrop.x + displayCrop.width / 2) * scale;
    const bboxCenterY = (displayCrop.y + displayCrop.height / 2) * scale;

    imgStyle = {
      position: "absolute",
      width: naturalSize.w * scale,
      height: naturalSize.h * scale,
      left: THUMB_SIZE / 2 - bboxCenterX,
      top: THUMB_SIZE / 2 - bboxCenterY,
      maxWidth: "none",
    };
    if (!usesFaceCrop) {
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
    }
  } else if (naturalSize) {
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
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 9px",
        borderRadius: tokens.radius.md,
        marginBottom: 6,
        background: rowBg,
        boxShadow: identified
          ? "inset 0 0 0 1px rgba(47,109,246,0.10)"
          : "inset 0 0 0 1px rgba(31,45,71,0.05)",
      }}
    >
      <div
        style={{
          width: THUMB_SIZE,
          height: THUMB_SIZE,
          borderRadius: "50%",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          position: "relative",
          background: imageSrc ? tokens.bg.hover : thumbBg,
          boxShadow: "0 0 0 2px #fff, 0 8px 16px -12px rgba(31,45,71,0.6)",
        }}
      >
        {imageSrc ? (
          <>
            {bgStyle && <img src={imageSrc} alt="" draggable={false} style={bgStyle} />}
            <img
              src={imageSrc}
              alt=""
              onLoad={handleLoad}
              onError={handleError}
              style={
                imgStyle ?? {
                  position: "absolute",
                  opacity: 0,
                  width: 0,
                  height: 0,
                }
              }
              draggable={false}
            />
          </>
        ) : (
          <Icon name={icon} size={identified ? 20 : 18} color={thumbIconColor} />
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 800,
            color: nameColor,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {display_name}
        </div>
        {(behavior || appearance) && (
          <div style={{ marginTop: 3, display: "flex", flexDirection: "column", gap: 2 }}>
            {behavior && (
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 5,
                  fontSize: 11,
                  color: tokens.text.secondary,
                  lineHeight: 1.4,
                }}
              >
                <Icon name="play" size={11} color={tokens.text.faint} style={{ marginTop: 2 }} />
                <span>{behavior}</span>
              </div>
            )}
            {appearance && (
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 5,
                  fontSize: 11,
                  color: tokens.text.muted,
                  lineHeight: 1.4,
                }}
              >
                <Icon name="eye" size={11} color={tokens.text.faint} style={{ marginTop: 2 }} />
                <span>{appearance}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
