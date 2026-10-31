import type { CSSProperties } from "react";

/** Names of all icons available. Keep in sync with the <symbol> definitions below. */
export type IconName =
  | "eye" | "gear" | "person" | "person-outline" | "pet" | "car" | "cube"
  | "mic" | "speaker" | "send" | "upload" | "link" | "film" | "users" | "chat"
  | "play" | "stop" | "image" | "sidebar" | "expand" | "close" | "plus" | "trash" | "info"
  | "sparkle" | "alert" | "network" | "brain";

/**
 * Single SVG sprite mounted once at the root of the app.
 * Render <IconSprite /> inside App root.
 */
export function IconSprite() {
  return (
    <svg style={{ display: "none" }} aria-hidden="true">
      <symbol id="ic-eye" viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" /></symbol>
      <symbol id="ic-gear" viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" /></symbol>
      <symbol id="ic-person" viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" /></symbol>
      <symbol id="ic-person-outline" viewBox="0 0 24 24"><path d="M12 6c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2m0-2c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm0 10c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4zm6 4H6v-.01c.2-.71 3.3-2 6-2 2.69 0 5.78 1.28 6 2v.01z" /></symbol>
      <symbol id="ic-pet" viewBox="0 0 24 24"><path d="M4.5 9.5a2.5 2.5 0 105 0 2.5 2.5 0 10-5 0M9 5.5a2.5 2.5 0 105 0 2.5 2.5 0 10-5 0M15 5.5a2.5 2.5 0 105 0 2.5 2.5 0 10-5 0M19.5 9.5a2.5 2.5 0 105 0 2.5 2.5 0 10-5 0M17.34 14.86c-.87-1.02-1.6-1.89-2.48-2.91-.46-.54-1.17-.95-1.87-.95s-1.41.41-1.87.95c-.87 1.02-1.6 1.89-2.48 2.91-1.31 1.31-2.92 2.76-2.62 4.79.29 1.02 1.02 2.0 2.09 2.35 1.97.4 4.17-.97 5.89-.97s3.92 1.37 5.89.97c1.07-.35 1.8-1.33 2.09-2.35.3-2.03-1.31-3.48-2.64-4.79z" /></symbol>
      <symbol id="ic-car" viewBox="0 0 24 24"><path d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm11 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3zM5 11l1.5-4.5h11L19 11H5z" /></symbol>
      <symbol id="ic-cube" viewBox="0 0 24 24"><path d="M21 16.5c0 .38-.21.71-.53.88l-7.9 4.44c-.36.2-.8.2-1.14 0l-7.9-4.44A.99.99 0 013 16.5v-9c0-.38.21-.71.53-.88l7.9-4.44c.36-.2.8-.2 1.14 0l7.9 4.44c.32.17.53.5.53.88v9zM12 4.15L5 8.09v7.82l7 3.94 7-3.94V8.09l-7-3.94z" /></symbol>
      <symbol id="ic-brain" viewBox="0 0 24 24">
        <path d="M9.2 3.5c-1.72 0-3.12 1.17-3.48 2.75A3.6 3.6 0 003.4 9.6c0 .65.17 1.26.47 1.79A3.74 3.74 0 003 13.8c0 1.7 1.14 3.13 2.7 3.58A3.55 3.55 0 009.2 20.5c1.25 0 2.3-.67 2.8-1.66.5.99 1.55 1.66 2.8 1.66a3.55 3.55 0 003.5-3.12A3.74 3.74 0 0021 13.8c0-.9-.32-1.72-.87-2.41.3-.53.47-1.14.47-1.79a3.6 3.6 0 00-2.32-3.35A3.56 3.56 0 0014.8 3.5c-1.17 0-2.18.58-2.8 1.45A3.35 3.35 0 009.2 3.5zm-.12 2c.96 0 1.72.64 1.92 1.53V18c-.2.89-.96 1.53-1.92 1.53-.92 0-1.65-.62-1.78-1.5l-.16-1.05-1.03-.23A1.76 1.76 0 014.8 15c0-.52.23-1 .62-1.34l.8-.7-.5-.94A1.75 1.75 0 015.5 11.2c0-.77.5-1.45 1.23-1.68l.85-.27.15-.88A1.36 1.36 0 019.08 5.5zm5.84 0c.7 0 1.24.48 1.36 1.16l.15.88.85.27c.73.23 1.22.91 1.22 1.68 0 .29-.07.57-.21.82l-.5.94.8.7c.38.34.61.82.61 1.34 0 .82-.56 1.53-1.31 1.75l-1.03.23-.16 1.05c-.13.88-.86 1.5-1.78 1.5-.96 0-1.72-.64-1.92-1.53V7.03c.2-.89.96-1.53 1.92-1.53z" />
      </symbol>
      <symbol id="ic-mic" viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9a1 1 0 112 0v6a1 1 0 11-2 0V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" /></symbol>
      <symbol id="ic-speaker" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 00-2.5-4.03v8.05A4.5 4.5 0 0016.5 12zm-2.5-9.23v2.06a8 8 0 010 14.34v2.06c4.01-1.04 7-4.69 7-9.23s-2.99-8.19-7-9.23z" /></symbol>
      <symbol id="ic-send" viewBox="0 0 24 24"><path d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z" /></symbol>
      <symbol id="ic-upload" viewBox="0 0 24 24"><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z" /></symbol>
      <symbol id="ic-link" viewBox="0 0 24 24"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7a5 5 0 100 10h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4a3.1 3.1 0 010 6.2h-4V17h4a5 5 0 000-10z" /></symbol>
      <symbol id="ic-film" viewBox="0 0 24 24"><path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V4h-4z" /></symbol>
      <symbol id="ic-users" viewBox="0 0 24 24"><path d="M16 11a3 3 0 100-6 3 3 0 000 6zm-8 0a3 3 0 100-6 3 3 0 000 6zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" /></symbol>
      <symbol id="ic-chat" viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2zm0 14H6l-2 2V4h16v12z" /></symbol>
      <symbol id="ic-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></symbol>
      <symbol id="ic-stop" viewBox="0 0 24 24"><path d="M6 6h12v12H6z" /></symbol>
      <symbol id="ic-image" viewBox="0 0 24 24"><path d="M21 19V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" /></symbol>
      <symbol id="ic-sidebar" viewBox="0 0 24 24"><path d="M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2zm0 14H10V6h10v12z" /></symbol>
      <symbol id="ic-expand" viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" /></symbol>
      <symbol id="ic-close" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></symbol>
      <symbol id="ic-plus" viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" /></symbol>
      <symbol id="ic-trash" viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM8 9h8v10H8V9zm7.5-5l-1-1h-5l-1 1H5v2h14V4h-3.5z" /></symbol>
      <symbol id="ic-info" viewBox="0 0 24 24"><path d="M11 17h2v-6h-2v6zm0-8h2V7h-2v2zm1-7a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16z" /></symbol>
      <symbol id="ic-sparkle" viewBox="0 0 24 24"><path d="M12 2l1.43 4.57L18 8l-4.57 1.43L12 14l-1.43-4.57L6 8l4.57-1.43L12 2zm6.5 9l.82 2.68L22 14.5l-2.68.82L18.5 18l-.82-2.68L15 14.5l2.68-.82L18.5 11zM7 14l1.03 3.47L11.5 18.5l-3.47 1.03L7 23l-1.03-3.47L2.5 18.5l3.47-1.03L7 14z" /></symbol>
      <symbol id="ic-alert" viewBox="0 0 24 24"><path d="M1.73 21h20.54L12 3 1.73 21zM13 18h-2v-2h2v2zm0-4h-2V9h2v5z" /></symbol>
      <symbol id="ic-network" viewBox="0 0 24 24">
        <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d="M12 3.2a8.8 8.8 0 100 17.6 8.8 8.8 0 000-17.6z" />
        <path fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" d="M4.1 9h15.8M4.1 15h15.8M12 3.2c2.1 2.2 3.15 5.14 3.15 8.8S14.1 18.6 12 20.8M12 3.2C9.9 5.4 8.85 8.34 8.85 12S9.9 18.6 12 20.8" />
      </symbol>
    </svg>
  );
}

interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  style?: CSSProperties;
  title?: string;
}

export function Icon({ name, size = 16, color = "currentColor", style, title }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      fill={color}
      style={{ flexShrink: 0, ...style }}
      aria-hidden={title ? undefined : "true"}
      aria-label={title}
    >
      <use href={`#ic-${name}`} />
    </svg>
  );
}
