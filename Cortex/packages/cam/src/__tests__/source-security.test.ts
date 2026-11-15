import { describe, expect, it } from "vitest";
import { isDisallowedNetworkAddress, shouldUseStrictSourceValidation, sourceSecurityEnvWarnings, validateSourceInputSecurity } from "../source-security.js";

describe("source security validation", () => {
  it("uses strict mode for dashboard-owned sources unless explicitly disabled", () => {
    expect(shouldUseStrictSourceValidation({ _dashboardUserId: "user-a" })).toBe(true);
    expect(shouldUseStrictSourceValidation({ _dashboardSessionId: "session-a" })).toBe(true);
    expect(shouldUseStrictSourceValidation({ _sourceSecurityMode: "strict" })).toBe(true);
    expect(shouldUseStrictSourceValidation({ _dashboardUserId: "user-a", _sourceSecurityMode: "local_trusted" })).toBe(false);
  });

  it("warns when public mode enables private or local source escape hatches", () => {
    const previousPublicMode = process.env.CORTEX_PUBLIC_MODE;
    const previousPrivateSource = process.env.CORTEX_ALLOW_PRIVATE_SOURCE;
    const previousLocalSource = process.env.CORTEX_ALLOW_LOCAL_SOURCE;
    try {
      process.env.CORTEX_PUBLIC_MODE = "true";
      process.env.CORTEX_ALLOW_PRIVATE_SOURCE = "true";
      process.env.CORTEX_ALLOW_LOCAL_SOURCE = "true";
      expect(sourceSecurityEnvWarnings()).toEqual([
        expect.stringContaining("CORTEX_ALLOW_PRIVATE_SOURCE=true"),
        expect.stringContaining("CORTEX_ALLOW_LOCAL_SOURCE=true"),
      ]);
    } finally {
      if (previousPublicMode == null) delete process.env.CORTEX_PUBLIC_MODE;
      else process.env.CORTEX_PUBLIC_MODE = previousPublicMode;
      if (previousPrivateSource == null) delete process.env.CORTEX_ALLOW_PRIVATE_SOURCE;
      else process.env.CORTEX_ALLOW_PRIVATE_SOURCE = previousPrivateSource;
      if (previousLocalSource == null) delete process.env.CORTEX_ALLOW_LOCAL_SOURCE;
      else process.env.CORTEX_ALLOW_LOCAL_SOURCE = previousLocalSource;
    }
  });

  it("keeps local-trusted mode permissive", async () => {
    await expect(validateSourceInputSecurity("/etc/passwd", { strict: false }))
      .resolves.toEqual({ ok: true });
    await expect(validateSourceInputSecurity("http://169.254.169.254/latest", { strict: false }))
      .resolves.toEqual({ ok: true });
  });

  it("rejects local files, local devices, file URLs, and default http in strict mode", async () => {
    await expect(validateSourceInputSecurity("/etc/passwd", { strict: true }))
      .resolves.toMatchObject({ ok: false, code: "local_path_not_allowed" });
    await expect(validateSourceInputSecurity("usb:1", { strict: true }))
      .resolves.toMatchObject({ ok: false, code: "local_device_not_allowed" });
    await expect(validateSourceInputSecurity("file:///etc/passwd", { strict: true }))
      .resolves.toMatchObject({ ok: false, code: "file_url_not_allowed" });
    await expect(validateSourceInputSecurity("http://8.8.8.8/live.m3u8", { strict: true }))
      .resolves.toMatchObject({ ok: false, code: "http_not_allowed" });
  });

  it("allows explicit strict-mode local and http overrides", async () => {
    await expect(validateSourceInputSecurity("/tmp/upload.mp4", { strict: true, allowLocalSource: true }))
      .resolves.toEqual({ ok: true });
    await expect(validateSourceInputSecurity("http://8.8.8.8/live.m3u8", { strict: true, allowHttp: true }))
      .resolves.toEqual({ ok: true });
  });

  it("rejects private and local network addresses in strict mode", async () => {
    await expect(validateSourceInputSecurity("rtsp://127.0.0.1/stream", { strict: true }))
      .resolves.toMatchObject({ ok: false, code: "private_network_not_allowed" });
    await expect(validateSourceInputSecurity("rtsp://192.168.1.10/stream", { strict: true }))
      .resolves.toMatchObject({ ok: false, code: "private_network_not_allowed" });
    await expect(validateSourceInputSecurity("https://camera.example/live", {
      strict: true,
      resolveHost: async () => ["10.0.0.5"],
    })).resolves.toMatchObject({ ok: false, code: "private_network_not_allowed" });
  });

  it("allows public rtsp/rtsps/https addresses in strict mode", async () => {
    await expect(validateSourceInputSecurity("rtsp://8.8.8.8/stream", { strict: true }))
      .resolves.toEqual({ ok: true });
    await expect(validateSourceInputSecurity("https://camera.example/live", {
      strict: true,
      resolveHost: async () => ["8.8.8.8"],
    })).resolves.toEqual({ ok: true });
  });

  it("classifies local, private, and reserved network addresses", () => {
    expect(isDisallowedNetworkAddress("127.0.0.1")).toBe(true);
    expect(isDisallowedNetworkAddress("169.254.169.254")).toBe(true);
    expect(isDisallowedNetworkAddress("10.0.0.1")).toBe(true);
    expect(isDisallowedNetworkAddress("192.168.1.1")).toBe(true);
    expect(isDisallowedNetworkAddress("172.16.0.1")).toBe(true);
    expect(isDisallowedNetworkAddress("198.51.100.10")).toBe(true);
    expect(isDisallowedNetworkAddress("203.0.113.10")).toBe(true);
    expect(isDisallowedNetworkAddress("::1")).toBe(true);
    expect(isDisallowedNetworkAddress("fc00::1")).toBe(true);
    expect(isDisallowedNetworkAddress("fe80::1")).toBe(true);
    expect(isDisallowedNetworkAddress("8.8.8.8")).toBe(false);
    expect(isDisallowedNetworkAddress("2606:4700:4700::1111")).toBe(false);
  });
});
