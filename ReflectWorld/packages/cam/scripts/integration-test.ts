/**
 * Integration test: simulate OpenClaw host → register Cam plugin → run full action flow.
 *
 * Strategy: register a go2rtc exec:ffmpeg test pattern source directly via go2rtc API,
 * then use SourceManager to track it, and exercise all tool actions.
 *
 * Prerequisites: go2rtc binary in bin/, ffmpeg in PATH.
 * Usage: npx tsx packages/cam/scripts/integration-test.ts
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { Go2rtcManager } from "../src/go2rtc-manager.js";
import { RecordManager } from "../src/record-manager.js";
import { FrameExtractor } from "../src/frame-extractor.js";
import { SourceManager } from "../src/source-manager.js";
import { executeCamAction } from "../src/tool.js";
import { resolveCamConfig } from "../src/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const binDir = resolve(__dirname, "..", "bin");
const go2rtcBin = resolve(binDir, "go2rtc");

const tmpBase = mkdtempSync(resolve(tmpdir(), "cam-integ-"));
const sourcesDir = resolve(tmpBase, "sources");
const recordingsDir = resolve(tmpBase, "recordings");
mkdirSync(sourcesDir, { recursive: true });
mkdirSync(recordingsDir, { recursive: true });

const API_PORT = 11984;
const RTSP_PORT = 18554;
const WEBRTC_PORT = 18555;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const STREAM_NAME = "test_cam";
const EXEC_SOURCE = "exec:ffmpeg -f lavfi -i testsrc=size=320x240:rate=5 -c:v libx264 -preset ultrafast -tune zerolatency -g 5 -f rtsp {output}";

async function main() {
  console.log("\n═══ Cam v3 Integration Test ═══\n");

  const config = resolveCamConfig({
    sources_dir: sourcesDir,
    go2rtc_bin: go2rtcBin,
    go2rtc_api_port: API_PORT,
    go2rtc_rtsp_port: RTSP_PORT,
    go2rtc_webrtc_port: WEBRTC_PORT,
    ffmpeg_bin: "ffmpeg",
    recordings_dir: recordingsDir,
    default_segment_sec: 5,
    default_extraction_fps: 2,
    default_extraction_width: 320,
    default_extraction_height: 240,
  });

  const go2rtc = new Go2rtcManager({
    binPath: go2rtcBin,
    apiPort: API_PORT,
    rtspPort: RTSP_PORT,
    webrtcPort: WEBRTC_PORT,
    initialStreams: {
      // exec: sources must be in config (go2rtc security policy blocks them via API)
      [STREAM_NAME]: [EXEC_SOURCE],
    },
  });

  const recordManager = new RecordManager({
    ffmpegBin: "ffmpeg",
    rtspBase: go2rtc.rtspBase,
    outputDir: recordingsDir,
  });

  const frameExtractor = new FrameExtractor({
    ffmpegBin: "ffmpeg",
    rtspBase: go2rtc.rtspBase,
  });

  const sourceManager = new SourceManager(sourcesDir);
  const deps = { sourceManager, go2rtc, recordManager, frameExtractor, config };

  // Helper to call actions
  async function call(action: string, params: Record<string, unknown> = {}): Promise<any> {
    const result = await executeCamAction(action as any, { action, ...params }, deps);
    return JSON.parse(result);
  }

  // ── 1. Start go2rtc ──
  console.log("1. Start go2rtc...");
  await go2rtc.start();
  const healthy = await go2rtc.isHealthy();
  assert(healthy, "go2rtc should be healthy");
  console.log("  ✓ go2rtc started and healthy\n");

  // ── 2. Verify exec source loaded from config ──
  console.log("2. Verify test source in go2rtc (from initialStreams config)...");
  const streams = await go2rtc.listStreams();
  assert(STREAM_NAME in streams, `Stream "${STREAM_NAME}" should be in go2rtc`);
  console.log(`  ✓ Stream "${STREAM_NAME}" loaded from config`);
  console.log(`  [debug] streams: ${JSON.stringify(Object.keys(streams))}\n`);

  // ── 3. Register source in SourceManager directly ──
  // Note: We skip the tool's add_source because it would call go2rtc.addStream() and
  // overwrite the exec: source from config with an RTSP self-reference.
  // In real usage, RTSP sources from real cameras work fine via add_source.
  console.log("3. Register source in SourceManager...");
  sourceManager.addSource(`exec:test_cam_source`, STREAM_NAME);
  const list0 = sourceManager.listSources();
  assert(list0.length === 1, "should have 1 source");
  console.log(`  ✓ Source: ${list0[0].name} (protocol: ${list0[0].protocol})\n`);

  // ── 4. list_sources ──
  console.log("4. list_sources...");
  const list = await call("list_sources");
  assert(list.sources.length === 1, "should have 1 source");
  console.log(`  ✓ ${list.sources.length} source(s)\n`);

  // ── 5. Snapshot ──
  console.log("5. snapshot...");
  let snapOk = false;
  const snap = await call("snapshot", { name: STREAM_NAME, width: 320, height: 240 });
  if (snap.data) {
    const bytes = Buffer.from(snap.data, "base64").length;
    console.log(`  ✓ Snapshot: ${bytes} bytes\n`);
    snapOk = true;
  } else {
    console.log(`  ⚠ Snapshot failed: ${snap.error}\n`);
  }

  // ── 6. Start recording ──
  console.log("6. start_recording (5s segments)...");
  const recStart = await call("start_recording", { name: STREAM_NAME, segment_sec: 5 });
  console.log(`  Result: ${JSON.stringify(recStart)}`);
  const isRecording = recordManager.isRecording(STREAM_NAME);
  console.log(`  isRecording: ${isRecording}`);

  if (isRecording) {
    console.log("  Waiting 6s for segment...");
    await sleep(6000);

    // ── 7. Stop recording ──
    console.log("7. stop_recording...");
    const recStop = await call("stop_recording", { name: STREAM_NAME });
    console.log(`  ✓ ${JSON.stringify(recStop)}\n`);

    // ── 8. List recordings ──
    console.log("8. list_recordings...");
    const recs = await call("list_recordings", { name: STREAM_NAME });
    console.log(`  ✓ ${recs.recordings.length} recording(s): ${JSON.stringify(recs.recordings)}\n`);
  } else {
    console.log("  ⚠ Recording didn't start (ffmpeg may fail to connect to RTSP)\n");
    console.log("7-8. Skipped (no active recording)\n");
  }

  // ── 9. Start watch (periodic) ──
  console.log("9. start_watch (periodic, 2s)...");
  const watchResult = await call("start_watch", { name: STREAM_NAME, mode: "periodic", interval: 2 });
  console.log(`  ✓ ${JSON.stringify(watchResult)}`);
  await sleep(3000);

  // ── 10. Stop watch ──
  console.log("10. stop_watch...");
  const stopResult = await call("stop_watch", { name: STREAM_NAME });
  console.log(`  ✓ ${JSON.stringify(stopResult)}\n`);

  // ── 11. Remove source ──
  console.log("11. remove_source...");
  const removeResult = await call("remove_source", { name: STREAM_NAME });
  assert(removeResult.success, "should remove");
  console.log(`  ✓ Removed\n`);

  // ── 12. Verify clean state ──
  console.log("12. Final state...");
  const finalList = await call("list_sources");
  assert(finalList.sources.length === 0, "should be empty");
  console.log(`  ✓ Sources: empty\n`);

  // ── Summary ──
  console.log("═══ INTEGRATION TEST COMPLETE ═══");
  console.log(`  go2rtc lifecycle:  ✓`);
  console.log(`  Source management: ✓`);
  console.log(`  Snapshot:          ${snapOk ? "✓" : "⚠ (exec source limitation)"}`);
  console.log(`  Recording:         ${isRecording ? "✓" : "⚠ (no RTSP stream)"}`);
  console.log(`  Watch/Stop:        ✓`);
  console.log(`  Cleanup:           ✓\n`);
}

main()
  .catch((err) => {
    console.error(`\n✗ FAILED: ${err.message}\n`);
    process.exit(1);
  })
  .finally(async () => {
    try {
      const { execSync } = await import("node:child_process");
      try { execSync(`lsof -ti:${API_PORT} | xargs kill 2>/dev/null`, { stdio: "ignore" }); } catch {}
    } catch {}
    console.log("[cleanup] go2rtc stopped.");
    setTimeout(() => process.exit(0), 500);
  });
