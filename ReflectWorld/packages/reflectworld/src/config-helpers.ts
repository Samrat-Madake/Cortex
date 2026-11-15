export interface CortexPortOverlay {
  qdrant?: number;
  qdrantGrpc?: number;
  mem?: number;
  go2rtcApi?: number;
  go2rtcRtsp?: number;
  go2rtcWebrtc?: number;
  go2rtcListen?: string;
  go2rtcReuseExternal?: boolean;
}

/**
 * Build cam config by merging eye + cam + port overlays.
 * Extracted from index.ts for testability — index.ts imports this.
 *
 * Priority: ports overlay > cam config > eye config.
 */
export function buildCamConfig(
  eye: Record<string, unknown> | undefined,
  cam: Record<string, unknown> | undefined,
  ports: CortexPortOverlay,
): Record<string, unknown> {
  return {
    ...(eye ?? {}),
    ...(cam ?? {}),
    go2rtc_api_port:
      ports.go2rtcApi
      ?? (cam as any)?.go2rtc_api_port
      ?? (eye as any)?.go2rtc_api_port,
    go2rtc_rtsp_port:
      ports.go2rtcRtsp
      ?? (cam as any)?.go2rtc_rtsp_port
      ?? (eye as any)?.go2rtc_rtsp_port,
    go2rtc_webrtc_port:
      ports.go2rtcWebrtc
      ?? (cam as any)?.go2rtc_webrtc_port
      ?? (eye as any)?.go2rtc_webrtc_port,
    go2rtc_listen_addr:
      ports.go2rtcListen
      ?? (cam as any)?.go2rtc_listen_addr
      ?? (eye as any)?.go2rtc_listen_addr,
    go2rtc_reuse_external:
      ports.go2rtcReuseExternal
      ?? (cam as any)?.go2rtc_reuse_external
      ?? (eye as any)?.go2rtc_reuse_external,
  };
}

/**
 * Resolve go2rtc API endpoint from config layers.
 *
 * Priority: ports.go2rtcApi > cam.go2rtc_api_port > eye.go2rtc_api_port > 1984.
 * Handles string port values (coerces to number).
 */
export function resolveGo2rtcEndpoint(
  ports: { go2rtcApi?: number },
  cam?: Record<string, unknown>,
  eye?: Record<string, unknown>,
): string {
  const raw = ports.go2rtcApi
    ?? (cam as any)?.go2rtc_api_port
    ?? (eye as any)?.go2rtc_api_port;
  const port = typeof raw === "number"
    ? raw
    : Number.parseInt(String(raw ?? ""), 10) || 1984;
  return `http://127.0.0.1:${port}`;
}
