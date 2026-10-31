// packages/percept/src/analyzers/face-pose.ts

/**
 * Estimate face pose (yaw / pitch / roll) from RetinaFace 5-point landmarks.
 *
 * Landmarks order: [left_eye, right_eye, nose, left_mouth, right_mouth].
 * All angles in degrees. Yaw: positive = face turns right. Pitch: positive = face looks up.
 * Roll: positive = head tilts clockwise.
 *
 * Pure geometry — no model, no dependencies, sub-microsecond.
 */

export interface FacePose {
  /** Left-right rotation in degrees. 0 = frontal, positive = face turns right. */
  yaw: number;
  /** Up-down tilt in degrees. Positive = looking up. */
  pitch: number;
  /** Head tilt (clockwise) in degrees. */
  roll: number;
}

const RAD2DEG = 180 / Math.PI;

/**
 * Estimate face pose from 5-point landmarks.
 *
 * Returns undefined if landmarks are missing or have fewer than 5 points.
 */
export function estimateFacePose(landmarks: Array<{ x: number; y: number }> | undefined): FacePose | undefined {
  if (!landmarks || landmarks.length < 5) return undefined;

  const [leftEye, rightEye, nose, leftMouth, rightMouth] = landmarks as [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ];

  // Eye midpoint and inter-ocular distance
  const eyeMidX = (leftEye.x + rightEye.x) / 2;
  const eyeMidY = (leftEye.y + rightEye.y) / 2;
  const eyeDist = Math.sqrt((rightEye.x - leftEye.x) ** 2 + (rightEye.y - leftEye.y) ** 2);

  if (eyeDist < 1) return undefined; // degenerate landmarks

  // Yaw: nose horizontal offset relative to eye midpoint, normalized by half eye distance
  const yawRatio = (nose.x - eyeMidX) / (eyeDist / 2);
  const yaw = Math.asin(Math.max(-1, Math.min(1, yawRatio))) * RAD2DEG;

  // Pitch: nose vertical position between eye line and mouth line
  const mouthMidY = (leftMouth.y + rightMouth.y) / 2;
  const faceHeight = mouthMidY - eyeMidY;
  let pitch = 0;
  if (faceHeight > 1) {
    // Normal nose position is ~55% from eyes to mouth
    const noseRelativeY = (nose.y - eyeMidY) / faceHeight;
    const pitchRatio = (0.55 - noseRelativeY) * 2;
    pitch = Math.asin(Math.max(-1, Math.min(1, pitchRatio))) * RAD2DEG;
  }

  // Roll: angle of eye line relative to horizontal
  const roll = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x) * RAD2DEG;

  return { yaw, pitch, roll };
}

/**
 * Compute a quality penalty factor based on face pose (yaw + pitch).
 *
 * Frontal faces produce more discriminative embeddings. This factor
 * is multiplied into the detection-based quality score.
 *
 * Takes the worse of yaw penalty and pitch penalty (min), because
 * a face can be frontal in yaw but looking straight down — still bad.
 *
 * Yaw bands:   |yaw| < 15° → 1.0, < 30° → 0.85, < 45° → 0.6, else → 0.3
 * Pitch bands:  |pitch| < 20° → 1.0, < 35° → 0.85, < 50° → 0.6, else → 0.3
 * (pitch thresholds are slightly more relaxed since vertical variation is smaller)
 */
export function poseFactor(yaw: number, pitch?: number): number {
  const absYaw = Math.abs(yaw);
  let yawFactor: number;
  if (absYaw < 15) yawFactor = 1.0;
  else if (absYaw < 30) yawFactor = 0.85;
  else if (absYaw < 45) yawFactor = 0.6;
  else yawFactor = 0.3;

  if (pitch === undefined) return yawFactor;

  const absPitch = Math.abs(pitch);
  let pitchFactor: number;
  if (absPitch < 20) pitchFactor = 1.0;
  else if (absPitch < 35) pitchFactor = 0.85;
  else if (absPitch < 50) pitchFactor = 0.6;
  else pitchFactor = 0.3;

  return Math.min(yawFactor, pitchFactor);
}
