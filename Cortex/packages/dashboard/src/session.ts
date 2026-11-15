const USER_ID_STORAGE_KEY = "cortex.dashboard.user_id.v1";
const SESSION_ID_STORAGE_KEY = "cortex.dashboard.session_id.v1";
const ADMIN_STORAGE_KEY = "cortex.dashboard.admin.v1";
const ADMIN_TOKEN_STORAGE_KEY = "cortex.dashboard.admin_token.v1";

export interface DashboardSession {
  sessionId: string;
  userId: string;
  isAdmin: boolean;
  adminToken?: string;
}

function sanitizeUserId(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  const safe = text.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
  return safe || null;
}

function randomUserId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `user_${rand}`;
}

function randomSessionId(): string {
  const rand = Math.random().toString(36).slice(2, 12);
  return `sess_${Date.now().toString(36)}_${rand}`;
}

export function getDashboardSession(): DashboardSession {
  const params = new URLSearchParams(window.location.search);
  const queryUser = sanitizeUserId(params.get("user_id"));
  const storedUser = sanitizeUserId(window.sessionStorage.getItem(USER_ID_STORAGE_KEY));
  const userId = queryUser ?? storedUser ?? randomUserId();
  window.sessionStorage.setItem(USER_ID_STORAGE_KEY, userId);

  const storedSession = sanitizeUserId(window.sessionStorage.getItem(SESSION_ID_STORAGE_KEY));
  const sessionId = storedSession ?? randomSessionId();
  window.sessionStorage.setItem(SESSION_ID_STORAGE_KEY, sessionId);

  const queryAdmin = params.get("admin");
  if (queryAdmin === "1" || queryAdmin === "true") {
    window.sessionStorage.setItem(ADMIN_STORAGE_KEY, "true");
  }
  const queryAdminToken = params.get("admin_token")?.trim();
  if (queryAdminToken) {
    window.sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, queryAdminToken);
  }
  const isAdmin = userId === "admin" || window.sessionStorage.getItem(ADMIN_STORAGE_KEY) === "true";
  const adminToken = isAdmin ? window.sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY)?.trim() : "";
  return { sessionId, userId, isAdmin, ...(adminToken ? { adminToken } : {}) };
}

export function dashboardAuthHeaders(session: DashboardSession): Record<string, string> {
  return {
    "X-Dashboard-Session-Id": session.sessionId,
    "X-Dashboard-User-Id": session.userId,
  };
}

export function withDashboardQuery(path: string, session: DashboardSession): string {
  const url = new URL(path, window.location.origin);
  url.searchParams.set("session_id", session.sessionId);
  url.searchParams.set("user_id", session.userId);
  return `${url.pathname}${url.search}`;
}
