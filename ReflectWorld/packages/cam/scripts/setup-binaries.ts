import { setupBinaries } from "../src/binary-installer.js";

setupBinaries()
  .then(({ go2rtc, ffmpeg, ffprobe, sileroVad }) => {
    console.log(`[cam] go2rtc: ${go2rtc}`);
    console.log(`[cam] ffmpeg: ${ffmpeg}`);
    console.log(`[cam] ffprobe: ${ffprobe}`);
    console.log(`[cam] silero_vad: ${sileroVad}`);
  })
  .catch((err: Error) => {
    console.error("[cam] Binary setup failed:", err.message);
    process.exit(1);
  });
