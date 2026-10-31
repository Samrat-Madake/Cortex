import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { isToolAdminAuthorized, isToolApiRestricted, toolApiMaxBodyBytes } from "../cli/start.js";

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("CLI start tool API security", () => {
  it("keeps the tool API unrestricted by default", () => {
    expect(isToolApiRestricted({})).toBe(false);
    expect(isToolAdminAuthorized(req({}), {})).toBe(true);
  });

  it("requires an admin token for the tool API in public mode", () => {
    const env = {
      REFLECTWORLD_PUBLIC_MODE: "true",
      DASHBOARD_ADMIN_TOKEN: "secret",
    };

    expect(isToolApiRestricted(env)).toBe(true);
    expect(isToolAdminAuthorized(req({}), env)).toBe(false);
    expect(isToolAdminAuthorized(req({ authorization: "Bearer secret" }), env)).toBe(true);
    expect(isToolAdminAuthorized(req({ "x-dashboard-admin-token": "secret" }), env)).toBe(true);
    expect(isToolAdminAuthorized(req({ "x-reflectworld-admin-token": "secret" }), env)).toBe(true);
  });

  it("uses a bounded tool API request body limit", () => {
    expect(toolApiMaxBodyBytes({})).toBe(1024 * 1024);
    expect(toolApiMaxBodyBytes({ REFLECTWORLD_TOOL_API_MAX_BODY_BYTES: "2048" })).toBe(2048);
    expect(toolApiMaxBodyBytes({ REFLECTWORLD_TOOL_API_MAX_BODY_BYTES: "-1" })).toBe(1024 * 1024);
  });
});
