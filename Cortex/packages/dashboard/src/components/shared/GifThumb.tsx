import { tokens } from "../../theme/tokens";

interface GifThumbProps {
  /** Animated WebP preview URL (preferred). */
  gif_url?: string | null;
  /** Absolute keyframe URL (already `/media/...`) or null for a placeholder. */
  keyframe_url: string | null;
  /** Width in CSS pixels. Defaults to 110 to match `.seg-thumb`. */
  width?: number | string;
  /** Height in CSS pixels. Defaults to 68 to match `.seg-thumb`. */
  height?: number | string;
  /** Optional alt text for the underlying <img>. */
  alt?: string;
  /** How the thumbnail image should fit the frame. */
  objectFit?: React.CSSProperties["objectFit"];
  /** CSS object-position for crop control. */
  objectPosition?: React.CSSProperties["objectPosition"];
  /** Optional frame radius for tighter card integrations. */
  borderRadius?: React.CSSProperties["borderRadius"];
}

/**
 * Segment thumbnail shown in the Moments list.
 * Callers pass `gif_url` only for rows that should animate; all other cards
 * remain on the static keyframe to keep the list calm.
 */
export function GifThumb({
  gif_url,
  keyframe_url,
  width = 110,
  height = 68,
  alt = "",
  objectFit = "cover",
  objectPosition = "center center",
  borderRadius = tokens.radius.sm,
}: GifThumbProps) {
  const baseStyle: React.CSSProperties = {
    width,
    height,
    borderRadius,
    flexShrink: 0,
    overflow: "hidden",
    position: "relative",
    background: `linear-gradient(135deg, ${tokens.bg.inset}, ${tokens.bg.elevated})`,
  };

  const src = gif_url ?? keyframe_url;
  if (!src) {
    return <div style={baseStyle} aria-hidden="true" />;
  }

  return (
    <div style={baseStyle}>
      <img
        src={src}
        alt={alt}
        style={{
          width: "100%",
          height: "100%",
          objectFit,
          objectPosition,
          display: "block",
        }}
      />
    </div>
  );
}
