import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, chmodSync, createWriteStream, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { get as httpsGet } from "node:https";
import { resolveCortexHome } from "@cortex/shared";
import { writeStdout } from "@cortex/shared";

const GO2RTC_VERSION = "1.9.14";
const FFMPEG_VERSION = "6.0.1";

export function getGo2rtcDownload(platform: string, arch: string): { url: string; format: "zip" | "binary" } {
  const archMap: Record<string, string> = { arm64: "arm64", x64: "amd64" };
  const archSuffix = archMap[arch];
  if (!archSuffix) throw new Error(`Unsupported arch: ${arch}`);

  if (platform === "darwin") {
    return {
      url: `https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/go2rtc_mac_${archSuffix}.zip`,
      format: "zip",
    };
  }
  if (platform === "linux") {
    return {
      url: `https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/go2rtc_linux_${archSuffix}`,
      format: "binary",
    };
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

export function getGo2rtcUrl(platform: string, arch: string): string {
  return getGo2rtcDownload(platform, arch).url;
}

/**
 * Get a fixed ffmpeg download URL for the given platform and architecture.
 * The setup phase pins versions so runtime never depends on a moving latest link.
 */
export function getFfmpegUrl(platform: string, arch: string): { url: string; format: "zip" | "tar.xz" } {
  const archMap: Record<string, string> = { arm64: "arm64", x64: "amd64" };
  const archSuffix = archMap[arch];
  if (!archSuffix) throw new Error(`Unsupported arch: ${arch}`);

  if (platform === "darwin") {
    return {
      url: `https://evermeet.cx/ffmpeg/ffmpeg-${FFMPEG_VERSION}.zip`,
      format: "zip",
    };
  }
  if (platform === "linux") {
    return {
      url: `https://johnvansickle.com/ffmpeg/old-releases/ffmpeg-${FFMPEG_VERSION}-${archSuffix}-static.tar.xz`,
      format: "tar.xz",
    };
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

export function getFfprobeUrl(platform: string, arch: string): { url: string; format: "zip" | "tar.xz" } {
  const ffmpeg = getFfmpegUrl(platform, arch);
  if (platform === "darwin") {
    return {
      url: `https://evermeet.cx/ffmpeg/ffprobe-${FFMPEG_VERSION}.zip`,
      format: "zip",
    };
  }
  return ffmpeg;
}

export function getFfmpegStrategy(): { type: "prepared" | "download" } {
  const binDir = getBinDir();
  return existsSync(join(binDir, "ffmpeg")) && existsSync(join(binDir, "ffprobe"))
    ? { type: "prepared" }
    : { type: "download" };
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    httpsGet(url, (response) => {
      if (
        response.statusCode &&
        [301, 302, 307, 308].includes(response.statusCode) &&
        response.headers.location
      ) {
        return downloadFile(response.headers.location, dest)
          .then(resolve)
          .catch(reject);
      }
      if (response.statusCode !== 200)
        return reject(new Error(`HTTP ${response.statusCode} for ${url}`));
      const file = createWriteStream(dest);
      response.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
      file.on("error", (err) => reject(err));
    }).on("error", reject);
  });
}

/** Extract ffmpeg and ffprobe binaries from downloaded archive (zip on macOS, tar.xz on Linux). */
function extractFfmpeg(archivePath: string, format: "zip" | "tar.xz", binDir: string): void {
  if (format === "zip") {
    execFileSync("unzip", ["-o", archivePath, "-d", binDir], { timeout: 60000, stdio: "ignore" });
  } else {
    execFileSync(
      "tar",
      ["-xf", archivePath, "-C", binDir, "--strip-components=1", "--wildcards", "*/ffmpeg", "*/ffprobe"],
      { timeout: 60000, stdio: "ignore" },
    );
  }
}

export function getBinDir(): string {
  return join(resolveCortexHome(), "bin");
}

const SILERO_VAD_URL = "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx";

function missingBinaryError(name: string, path: string): Error {
  return new Error(
    `${name} is not prepared at ${path}. Run ` +
    "`npx tsx packages/cam/scripts/setup-binaries.ts` during environment setup.",
  );
}

export function getSileroVadModelPath(): string {
  return join(resolveCortexHome(), "models", "silero_vad.onnx");
}

export function resolveGo2rtcBin(binDir = getBinDir()): string {
  const go2rtcDest = join(binDir, "go2rtc");
  if (!existsSync(go2rtcDest)) throw missingBinaryError("go2rtc", go2rtcDest);
  return go2rtcDest;
}

/** Resolve an already prepared ffmpeg binary. This never downloads at runtime. */
export function resolveFfmpegBin(binDir = getBinDir()): string {
  const ffmpegDest = join(binDir, "ffmpeg");
  if (!existsSync(ffmpegDest)) throw missingBinaryError("ffmpeg", ffmpegDest);
  return ffmpegDest;
}

/** Resolve an already prepared ffprobe binary. This never downloads at runtime. */
export function resolveFfprobeBin(binDir = getBinDir(), ffmpegBin?: string): string {
  const ffprobeDest = join(binDir, "ffprobe");
  if (existsSync(ffprobeDest)) return ffprobeDest;
  if (ffmpegBin) {
    const sibling = join(dirname(ffmpegBin), "ffprobe");
    if (existsSync(sibling)) return sibling;
  }
  throw missingBinaryError("ffprobe", ffprobeDest);
}

/** Resolve Cam runtime defaults prepared by setupBinaries(). This never downloads. */
export function resolveBinaries(): {
  go2rtc: string;
  ffmpeg: string;
  ffprobe: string;
  sileroVad: string;
} {
  const binDir = getBinDir();
  const ffmpeg = resolveFfmpegBin(binDir);
  return {
    go2rtc: resolveGo2rtcBin(binDir),
    ffmpeg,
    ffprobe: resolveFfprobeBin(binDir, ffmpeg),
    sileroVad: getSileroVadModelPath(),
  };
}

export async function setupBinaries(): Promise<{
  go2rtc: string;
  ffmpeg: string;
  ffprobe: string;
  sileroVad: string;
}> {
  const binDir = getBinDir();
  if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });

  const platform = process.platform;
  const arch = process.arch;

  // ── go2rtc ──
  const go2rtcDest = join(binDir, "go2rtc");
  if (!existsSync(go2rtcDest)) {
    const { url, format } = getGo2rtcDownload(platform, arch);
    writeStdout(
      `[cam] Downloading go2rtc v${GO2RTC_VERSION} for ${platform}-${arch}...`,
    );
    if (format === "zip") {
      const zipPath = join(binDir, "go2rtc-download.zip");
      await downloadFile(url, zipPath);
      execFileSync("unzip", ["-o", zipPath, "-d", binDir], { timeout: 30000, stdio: "ignore" });
      unlinkSync(zipPath);
    } else {
      await downloadFile(url, go2rtcDest);
    }
    chmodSync(go2rtcDest, 0o755);
    writeStdout("[cam] go2rtc downloaded.");
  }

  const ffmpeg = await setupFfmpeg(binDir);
  const ffprobe = resolveFfprobeBin(binDir, ffmpeg);
  const sileroVadDest = await downloadSileroVad();
  return { go2rtc: go2rtcDest, ffmpeg, ffprobe, sileroVad: sileroVadDest };
}

/** Prepare ffmpeg during setup. Runtime code should use resolveFfmpegBin(). */
export async function setupFfmpeg(binDir = getBinDir()): Promise<string> {
  if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });

  const platform = process.platform;
  const arch = process.arch;
  const ffmpegDest = join(binDir, "ffmpeg");
  const ffprobeDest = join(binDir, "ffprobe");
  if (!existsSync(ffmpegDest) || !existsSync(ffprobeDest)) {
    const { url, format } = getFfmpegUrl(platform, arch);
    const ext = format === "zip" ? "zip" : "tar.xz";
    const archivePath = join(binDir, `ffmpeg-${FFMPEG_VERSION}-download.${ext}`);
    writeStdout(`[cam] Downloading ffmpeg v${FFMPEG_VERSION} static build for ${platform}-${arch}...`);
    await downloadFile(url, archivePath);
    extractFfmpeg(archivePath, format, binDir);
    chmodSync(ffmpegDest, 0o755);
    if (existsSync(ffprobeDest)) chmodSync(ffprobeDest, 0o755);
    unlinkSync(archivePath);
    writeStdout("[cam] ffmpeg/ffprobe downloaded and extracted.");
  }
  if (!existsSync(ffprobeDest)) {
    const { url, format } = getFfprobeUrl(platform, arch);
    const ext = format === "zip" ? "zip" : "tar.xz";
    const archivePath = join(binDir, `ffprobe-${FFMPEG_VERSION}-download.${ext}`);
    writeStdout(`[cam] Downloading ffprobe v${FFMPEG_VERSION} static build for ${platform}-${arch}...`);
    await downloadFile(url, archivePath);
    extractFfmpeg(archivePath, format, binDir);
    chmodSync(ffprobeDest, 0o755);
    unlinkSync(archivePath);
    writeStdout("[cam] ffprobe downloaded and extracted.");
  }
  return ffmpegDest;
}

async function downloadSileroVad(): Promise<string> {
  const modelsDir = join(resolveCortexHome(), "models");
  if (!existsSync(modelsDir)) mkdirSync(modelsDir, { recursive: true });
  const dest = join(modelsDir, "silero_vad.onnx");
  if (existsSync(dest)) return dest;
  writeStdout("[cam] Downloading Silero VAD ONNX model...");
  await downloadFile(SILERO_VAD_URL, dest);
  writeStdout("[cam] Silero VAD model downloaded.");
  return dest;
}
