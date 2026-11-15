import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DashboardVideoLibrary } from "../services/dashboard-videos.js";

describe("DashboardVideoLibrary", () => {
  let tmpRoot = "";
  let uploadsDir = "";
  let fixturesDir = "";

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "cortex-dashboard-videos-"));
    uploadsDir = join(tmpRoot, "uploads");
    fixturesDir = join(tmpRoot, "fixtures");
    mkdirSync(uploadsDir, { recursive: true });
    mkdirSync(fixturesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("lists uploaded videos before fixtures and sorts uploads by upload time", () => {
    const olderUpload = join(uploadsDir, "old.mp4");
    const newerUpload = join(uploadsDir, "new.mp4");
    const fixture2 = join(fixturesDir, "2_demo.mp4");
    const fixture10 = join(fixturesDir, "10_demo.mp4");
    writeFileSync(olderUpload, "older");
    writeFileSync(newerUpload, "newer");
    writeFileSync(fixture2, "fixture2");
    writeFileSync(fixture10, "fixture10");
    writeFileSync(`${fixture2}.json`, JSON.stringify({ duration_sec: 62.4, tags: ["office", "demo", "office"] }));
    utimesSync(olderUpload, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    utimesSync(newerUpload, new Date(1_700_000_010_000), new Date(1_700_000_010_000));
    utimesSync(fixture2, new Date(1_800_000_000_000), new Date(1_800_000_000_000));
    utimesSync(fixture10, new Date(1_800_000_010_000), new Date(1_800_000_010_000));

    const library = new DashboardVideoLibrary({
      uploadsDir,
      uploadSearchDirs: [uploadsDir],
      fixtureVideosDir: fixturesDir,
      sessionEnabled: () => false,
    });

    const videos = library.listVideos();

    expect(videos.map((video) => video.video_id)).toEqual([
      "upload/new.mp4",
      "upload/old.mp4",
      "fixture/2_demo.mp4",
      "fixture/10_demo.mp4",
    ]);
    expect(videos[0]?.updated_at).toBeGreaterThan(videos[1]?.updated_at ?? 0);
    expect(videos[2]?.duration_sec).toBe(62.4);
    expect(videos[2]?.tags).toEqual(["office", "demo"]);
  });
});
