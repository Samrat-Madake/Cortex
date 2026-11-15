// Light observation-workbench tokens.
// All UI consumes values from here — no inline color/spacing literals.

export const tokens = {
  bg: {
    page: "#f4f6fb",
    surface: "#ffffff",
    elevated: "#fbfcff",
    hover: "#eef3fb",
    inset: "#f6f8fc",
    // Dark chrome wrapping the go2rtc iframe. Intentionally near-black so the
    // live stream (which may letterbox its own content) visually integrates.
    videoFrame: "#070b16",
    // Inner placeholder backdrop shown while no camera is selected; slightly
    // lifted from videoFrame to hint at a latent surface.
    videoPlaceholder: "#0c1424",
  },
  text: {
    primary: "#172033",
    secondary: "#526075",
    muted: "#8a96aa",
    faint: "#bdc6d5",
  },
  accent: {
    base: "#2f6df6",
    soft: "rgba(47, 109, 246, 0.09)",
    border: "rgba(47, 109, 246, 0.28)",
  },
  semantic: {
    green: "#22c55e",
    amber: "#f59e0b",
    amberSoft: "rgba(245, 158, 11, 0.1)",
    red: "#ef4444",
    purple: "#7c5cff",
    purpleSoft: "rgba(124, 92, 255, 0.09)",
    // Lighter purple used for sparse 3D scene features (MapPoint dots) — a
    // deliberate tint shift from `purple` so identified entities (which use
    // accent.base) and sparse points read as distinct layers.
    purpleLight: "#9f8cff",
  },
  shadow: {
    border: "0 0 0 1px rgba(31, 45, 71, 0.08)",
    card: "0 0 0 1px rgba(31,45,71,0.08), 0 1px 2px rgba(31,45,71,0.04), 0 14px 34px -28px rgba(31,45,71,0.45)",
    elevated: "0 0 0 1px rgba(31,45,71,0.08), 0 10px 30px -18px rgba(31,45,71,0.35), 0 24px 54px -36px rgba(31,45,71,0.45)",
    selected: "0 0 0 1.5px #8cb4ff, 0 0 0 4px rgba(47,109,246,0.10), 0 14px 34px -22px rgba(47,109,246,0.5)",
    // Subtle accent-tinted drop shadow for active pills / highlighted chips.
    accentGlow: "0 6px 16px -8px rgba(47,109,246,0.65)",
  },
  radius: { sm: 8, md: 12, lg: 18, pill: 999 },
  font: {
    sans: "'Manrope', 'Avenir Next', 'Segoe UI', sans-serif",
  },
  /** Stable per-camera colors used for timeline dots and badges. */
  cameraPalette: ["#64748b", "#16a34a", "#2f6df6", "#d97706", "#7c5cff"],
} as const;

/** Assign a stable color to a camera_id based on hash. */
export function getCameraColor(cameraId: string): string {
  let hash = 0;
  for (let i = 0; i < cameraId.length; i++) {
    hash = ((hash << 5) - hash + cameraId.charCodeAt(i)) | 0;
  }
  return tokens.cameraPalette[Math.abs(hash) % tokens.cameraPalette.length];
}
