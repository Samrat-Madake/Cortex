// Binary and model asset manifest for setup command.
// All versions and URLs pinned.

export interface BinaryAsset {
  name: string;
  version: string;
  getUrl: (os: string, arch: string) => string | null;
  filename: string;
  /** Additional binaries that may be bundled in the same archive. */
  extraFilenames?: string[];
  /** Extraction format. If undefined, inferred from URL extension at download time. */
  extract?: "tar.gz" | "tar.xz" | "zip" | "binary";
  sha256?: string;
}

/**
 * Acquisition recipe for a model that ReflectWorld cannot redistribute (AGPL or
 * non-commercial weights). The open-source weights are downloaded and converted
 * to ONNX locally, in a throwaway Python env, on the user's machine. The user
 * accepts the model's license during setup; nothing is redistributed by us.
 */
export interface ModelConvertSource {
  /** Export script under scripts/models/, e.g. "export_yolo26.py". */
  script: string;
  /** Filename for the downloaded source weight inside the conversion workdir. */
  weightFile: string;
  /** Ultralytics model name to auto-download (e.g. "yolo26m.pt"). */
  ultralytics?: string;
  /** Google Drive file id for the source weight (fetched via gdown). */
  gdriveId?: string;
}

/** Conditional gate: install this model only when process.env[env] === equals. */
export interface ModelGate {
  env: string;
  equals: string;
}

/** Download an archive and extract a single ONNX member out of it. */
export interface ModelArchiveSource {
  url: string;
  /** Path of the file inside the archive to extract as the model filename. */
  member: string;
  /** SHA-256 of the extracted ONNX (deterministic; verified after extraction). */
  sha256?: string;
}

export interface ModelAsset {
  name: string;
  filename: string;
  sizeMb: number;
  /** Direct ONNX download URL. */
  url?: string;
  /** 0 = always installed, 1 = Level 1+. Optional models use level 1 plus a gate. */
  level: number;
  /** SHA-256 of the ONNX (deterministic acquisitions: direct/archive). Verified after download. */
  sha256?: string;
  /**
   * License / usage summary. Presence means the model is NOT license-clean and must be
   * accepted by the user before it is downloaded/converted (AGPL or non-commercial weights).
   */
  license?: string;
  /** Download an archive (zip) and extract one ONNX member. */
  archive?: ModelArchiveSource;
  /** If set, weights are not redistributable: download open-source weights + convert locally. */
  convert?: ModelConvertSource;
  /** If set, only install when the environment condition is met (e.g. STT/body-reid toggles). */
  gatedBy?: ModelGate;
}

/**
 * Resolve which models to install for a requested perception level, applying
 * conditional gates (STT provider, body-reid toggle, etc.) from the environment.
 * A model is in scope when its level is within [0, requested] AND its gate (if any)
 * is satisfied. Optional models (e.g. body ReID) sit at level 1 with a gate, so they
 * never appear at Level 0.
 */
export function resolveModelPlan(level: number, env: NodeJS.ProcessEnv = process.env): ModelAsset[] {
  return MODELS.filter((m) => {
    if (m.gatedBy && env[m.gatedBy.env] !== m.gatedBy.equals) return false;
    return m.level >= 0 && m.level <= level;
  });
}

export const BINARIES: BinaryAsset[] = [
  {
    name: "qdrant",
    version: "1.17.1",
    filename: "qdrant",
    extract: "tar.gz",
    getUrl: (os, arch) => {
      const target =
        os === "darwin"
          ? arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
          : os === "linux"
            ? arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl"
            : null;
      if (!target) return null;
      return `https://github.com/qdrant/qdrant/releases/download/v1.17.1/qdrant-${target}.tar.gz`;
    },
  },
  {
    name: "go2rtc",
    version: "1.9.14",
    filename: "go2rtc",
    getUrl: (os, arch) => {
      const archMap: Record<string, string> = { arm64: "arm64", x64: "amd64" };
      const a = archMap[arch];
      if (!a) return null;
      if (os === "darwin")
        return `https://github.com/AlexxIT/go2rtc/releases/download/v1.9.14/go2rtc_mac_${a}.zip`;
      if (os === "linux")
        return `https://github.com/AlexxIT/go2rtc/releases/download/v1.9.14/go2rtc_linux_${a}`;
      return null;
    },
  },
  {
    name: "ffmpeg",
    version: "6.0.1",
    filename: "ffmpeg",
    extraFilenames: ["ffprobe"],
    getUrl: (os, arch) => {
      const archMap: Record<string, string> = { arm64: "arm64", x64: "amd64" };
      const a = archMap[arch];
      if (!a) return null;
      if (os === "darwin")
        return `https://evermeet.cx/ffmpeg/ffmpeg-6.0.1.zip`;
      if (os === "linux")
        return `https://johnvansickle.com/ffmpeg/old-releases/ffmpeg-6.0.1-${a}-static.tar.xz`;
      return null;
    },
  },
  {
    name: "ffprobe",
    version: "6.0.1",
    filename: "ffprobe",
    getUrl: (os, arch) => {
      const archMap: Record<string, string> = { arm64: "arm64", x64: "amd64" };
      const a = archMap[arch];
      if (!a) return null;
      if (os === "darwin")
        return `https://evermeet.cx/ffmpeg/ffprobe-6.0.1.zip`;
      if (os === "linux")
        return `https://johnvansickle.com/ffmpeg/old-releases/ffmpeg-6.0.1-${a}-static.tar.xz`;
      return null;
    },
  },
  {
    name: "uv",
    version: "0.7.12",
    filename: "uv",
    extract: "tar.gz",
    getUrl: (os, arch) => {
      const target =
        os === "darwin"
          ? arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
          : os === "linux"
            ? arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl"
            : null;
      if (!target) return null;
      return `https://github.com/astral-sh/uv/releases/download/0.7.12/uv-${target}.tar.gz`;
    },
  },
];

export const MODELS: ModelAsset[] = [
  {
    name: "Silero VAD",
    filename: "silero_vad.onnx",
    sizeMb: 2,
    level: 0,
    url: "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx",
  },
  {
    name: "YOLO26m",
    filename: "yolo26m.onnx",
    sizeMb: 78,
    level: 1,
    license: "AGPL-3.0 (Ultralytics) — commercial use requires an Ultralytics Enterprise License",
    convert: {
      script: "export_yolo26.py",
      weightFile: "yolo26m.pt",
      ultralytics: "yolo26m.pt",
    },
  },
  {
    name: "RetinaFace ResNet50",
    filename: "retinaface-resnet50.onnx",
    sizeMb: 110,
    level: 1,
    license: "code MIT (biubug6); weights NON-COMMERCIAL / research-only (WIDER FACE training data)",
    convert: {
      script: "export_retinaface.py",
      weightFile: "Resnet50_Final.pth",
      gdriveId: "14KX6VqF69MdSPk3Tr9PlDYbq7ArpdNUW",
    },
  },
  {
    name: "ArcFace MBF",
    filename: "w600k_mbf.onnx",
    sizeMb: 170, // downloads InsightFace buffalo_s pack (~170MB); extracts w600k_mbf.onnx (~14MB)
    level: 1,
    license: "InsightFace model — NON-COMMERCIAL / research-only. Verify before commercial use.",
    archive: {
      url: "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_s.zip",
      member: "w600k_mbf.onnx",
      sha256: "9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f",
    },
  },
  {
    name: "RTMPose-s (body pose)",
    filename: "rtmpose-s.onnx",
    sizeMb: 21,
    level: 1,
    license: "code Apache-2.0 (MMPose); weights trained on body7 datasets — verify dataset licenses before commercial use",
    archive: {
      url: "https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-s_simcc-body7_pt-body7_420e-256x192-acd4a1ef_20230504.zip",
      member: "20230831/rtmpose_onnx/rtmpose-s_simcc-body7_pt-body7_420e-256x192-acd4a1ef_20230504/end2end.onnx",
      sha256: "9aeb635b83f86aea45cf45d85798f7eba1a162de8e0d721c44e54fe5eebaf47d",
    },
    gatedBy: { env: "REFLECTWORLD_BODY_REID_ENABLED", equals: "true" },
  },
  {
    name: "CLIP-ReID ViT-B",
    filename: "clip-reid-vitb.onnx",
    sizeMb: 350,
    level: 1,
    license: "code MIT (Syliz517); weights RESEARCH-ONLY (Market-1501 training data)",
    convert: {
      script: "export_clipreid.py",
      weightFile: "clip_reid_market.pth",
      gdriveId: "1GnyAVeNOg3Yug1KBBWMKKbT2x43O5Ch7",
    },
    gatedBy: { env: "REFLECTWORLD_BODY_REID_ENABLED", equals: "true" },
  },
];
