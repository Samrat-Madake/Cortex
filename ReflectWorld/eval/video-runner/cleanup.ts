/**
 * Cleanup reflectworld_test_* Qdrant collections and e2e-* go2rtc streams.
 * Called at startup (clear residue) and in finally block (cleanup after test).
 */

const logger = {
  info: (msg: string) => console.log(`[e2e:cleanup] ${msg}`),
  warn: (msg: string) => console.warn(`[e2e:cleanup] ${msg}`),
};

const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const GO2RTC_URL = process.env.GO2RTC_URL ?? "http://localhost:1984";
const COLLECTION_PREFIX = "reflectworld_test";
const STREAM_PREFIX = "e2e-";

export interface CleanupOptions {
  collectionPrefix?: string;
  streamPrefix?: string;
  quietIfUnavailable?: boolean;
}

export async function cleanupQdrantCollections(options?: CleanupOptions): Promise<number> {
  const collectionPrefix = options?.collectionPrefix ?? COLLECTION_PREFIX;
  const quietIfUnavailable = options?.quietIfUnavailable === true;
  let resp: Response;
  try {
    resp = await fetch(`${QDRANT_URL}/collections`);
  } catch (err) {
    if (!quietIfUnavailable) {
      logger.warn(`Failed to reach Qdrant during cleanup: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 0;
  }
  if (!resp.ok) {
    if (!quietIfUnavailable) {
      logger.warn(`Failed to list Qdrant collections: ${resp.status}`);
    }
    return 0;
  }
  const data = (await resp.json()) as {
    result: { collections: Array<{ name: string }> };
  };
  let count = 0;
  for (const c of data.result.collections) {
    if (c.name.startsWith(collectionPrefix)) {
      const del = await fetch(`${QDRANT_URL}/collections/${c.name}`, {
        method: "DELETE",
      });
      if (del.ok) {
        count++;
        logger.info(`Deleted Qdrant collection: ${c.name}`);
      }
    }
  }
  return count;
}

export async function cleanupGo2rtcStreams(options?: CleanupOptions): Promise<number> {
  const streamPrefix = options?.streamPrefix ?? STREAM_PREFIX;
  const quietIfUnavailable = options?.quietIfUnavailable === true;
  let resp: Response;
  try {
    resp = await fetch(`${GO2RTC_URL}/api/streams`);
  } catch (err) {
    if (!quietIfUnavailable) {
      logger.warn(`Failed to reach go2rtc during cleanup: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 0;
  }
  if (!resp.ok) {
    if (!quietIfUnavailable) {
      logger.warn(`Failed to list go2rtc streams: ${resp.status}`);
    }
    return 0;
  }
  const streams = (await resp.json()) as Record<string, unknown>;
  let count = 0;
  for (const name of Object.keys(streams)) {
    if (name.startsWith(streamPrefix)) {
      const del = await fetch(
        `${GO2RTC_URL}/api/streams?name=${encodeURIComponent(name)}`,
        { method: "DELETE" },
      );
      if (del.ok) {
        count++;
        logger.info(`Deleted go2rtc stream: ${name}`);
      }
    }
  }
  return count;
}

export async function cleanupAll(options?: CleanupOptions): Promise<void> {
  const [qCount, gCount] = await Promise.all([
    cleanupQdrantCollections(options),
    cleanupGo2rtcStreams(options),
  ]);
  if (qCount > 0 || gCount > 0) {
    logger.info(
      `Cleaned up ${qCount} test collection(s) + ${gCount} e2e stream(s)`,
    );
  }
}
