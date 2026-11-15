// packages/mem/src/config.ts
import { z } from "zod";

/**
 * Zod schema for @cortex/mem plugin configuration.
 * Values can be overridden via the plugin options object at registration time.
 */
export const MemoryConfigSchema = z.object({
  /**
   * Base URL of the Cortex FastAPI service.
   * @default "http://localhost:8219"
   */
  baseUrl: z
    .string()
    .url()
    .default("http://localhost:8219"),

  /**
   * HTTP request timeout in milliseconds.
   * @default 60000
   */
  timeoutMs: z.number().int().positive().default(60_000),

  /**
   * Default camera_id applied to all requests when not explicitly provided.
   * Leave undefined to require callers to always specify camera_id.
   */
  defaultCameraId: z.string().optional(),

  /**
   * Default user_id applied to memory tool requests when not explicitly provided.
   */
  defaultUserId: z.string().optional(),

  /**
   * Default memory type for search operations.
   * @default "all"
   */
  defaultSearchMemoryType: z
    .enum(["episodic", "semantic", "procedural", "all"])
    .default("all"),

  /**
   * Default result limit for search operations.
   * @default 20
   */
  defaultSearchLimit: z.number().int().positive().default(20),
});

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

/**
 * Parse and validate memory plugin configuration.
 * Throws a Zod error on invalid input.
 *
 * @param input - Raw (possibly partial) config object.
 * @returns Validated config with defaults applied.
 */
export function parseMemoryConfig(input: unknown): MemoryConfig {
  return MemoryConfigSchema.parse(input);
}
