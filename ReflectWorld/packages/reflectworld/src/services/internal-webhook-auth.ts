import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { isLoopbackRequest } from "./dashboard-common.js";

export const INTERNAL_WEBHOOK_TOKEN_HEADER = "x-reflectworld-internal-token";

const INTERNAL_WEBHOOK_TOKEN_FILE = ".internal-webhook-token";

export function resolveInternalWebhookToken(stateDir: string, configuredToken?: string): string {
  const normalizedConfigured = configuredToken?.trim();
  if (normalizedConfigured) return normalizedConfigured;

  mkdirSync(stateDir, { recursive: true });
  const tokenPath = join(stateDir, INTERNAL_WEBHOOK_TOKEN_FILE);
  const existingToken = readTokenFile(tokenPath);
  if (existingToken) return existingToken;

  const generatedToken = randomBytes(32).toString("base64url");
  try {
    writeFileSync(tokenPath, `${generatedToken}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return generatedToken;
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
    const concurrentlyCreatedToken = readTokenFile(tokenPath);
    if (concurrentlyCreatedToken) return concurrentlyCreatedToken;
    throw new Error(`Internal webhook token file is empty: ${tokenPath}`);
  }
}

export function isAuthorizedInternalWebhookRequest(
  req: IncomingMessage,
  expectedToken: string | undefined,
  requireToken: boolean,
): boolean {
  if (!isLoopbackRequest(req)) return false;
  const normalizedExpected = expectedToken?.trim();
  if (!normalizedExpected) return !requireToken;
  const provided = req.headers[INTERNAL_WEBHOOK_TOKEN_HEADER];
  if (typeof provided !== "string") return !requireToken;
  const expectedBuffer = Buffer.from(normalizedExpected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length
    && timingSafeEqual(expectedBuffer, providedBuffer);
}

function readTokenFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
