// packages/percept/src/analyzers/face-body-associator.ts
import type { BoundingBox } from "@cortex/shared";
import type { FaceDetection } from "../types.js";

export interface FaceBodyAssociation {
  /** Index into detections[] array (the person). */
  body_index: number;
  /** Index into face detections array. */
  face_index: number;
  /** Association quality score [0,1]. */
  score: number;
}

/**
 * Associates face detections with person body detections.
 * Port from Python: the reference face-body association module
 *
 * Algorithm:
 * 1. Hard filter: intersection(face, person)/area(face) >= tau_face
 * 2. Score: s = w_h * horizontal_alignment + w_v * vertical_top_preference + w_iou * iou
 * 3. Greedy assignment (sufficient for typical <10 persons per frame)
 */
export class FaceBodyAssociator {
  private tauFace: number;
  private sigmaMin: number;
  private wH: number;
  private wV: number;
  private wIou: number;

  constructor(opts?: {
    tauFace?: number;
    sigmaMin?: number;
    wH?: number;
    wV?: number;
    wIou?: number;
  }) {
    this.tauFace = opts?.tauFace ?? 0.9;
    this.sigmaMin = opts?.sigmaMin ?? 0.5;
    this.wH = opts?.wH ?? 0.35;
    this.wV = opts?.wV ?? 0.15;
    this.wIou = opts?.wIou ?? 0.5;
  }

  /**
   * Associate faces to person bodies.
   * Only processes bodies with label "person".
   */
  associate(
    bodies: Array<{ label: string; bbox: BoundingBox }>,
    faces: FaceDetection[],
  ): FaceBodyAssociation[] {
    const personIndices: number[] = [];
    const persons: BoundingBox[] = [];
    for (let i = 0; i < bodies.length; i++) {
      if (bodies[i]!.label.toLowerCase() === "person") {
        personIndices.push(i);
        persons.push(bodies[i]!.bbox);
      }
    }

    if (persons.length === 0 || faces.length === 0) return [];

    const P = persons.length;
    const F = faces.length;
    const BIG = 1e6;
    const costMatrix: number[][] = Array.from({ length: P }, () => Array(F).fill(BIG) as number[]);
    const scoreMatrix: number[][] = Array.from({ length: P }, () => Array(F).fill(0) as number[]);

    for (let i = 0; i < P; i++) {
      for (let j = 0; j < F; j++) {
        const sIou = this.intersectionOverFaceArea(faces[j]!.bbox, persons[i]!);
        if (sIou < this.tauFace) continue;

        const sH = this.horizontalAlignment(faces[j]!.bbox, persons[i]!);
        const sV = this.verticalTopPreference(faces[j]!.bbox, persons[i]!);
        const score = this.wH * sH + this.wV * sV + this.wIou * sIou;
        scoreMatrix[i]![j] = score;
        costMatrix[i]![j] = 1 - score;
      }
    }

    const matches = this.greedyAssign(costMatrix, scoreMatrix, BIG);

    return matches.map(([pIdx, fIdx]) => ({
      body_index: personIndices[pIdx]!,
      face_index: fIdx,
      score: scoreMatrix[pIdx]![fIdx]!,
    }));
  }

  private intersectionOverFaceArea(face: BoundingBox, person: BoundingBox): number {
    const fx1 = face.x, fy1 = face.y, fx2 = face.x + face.width, fy2 = face.y + face.height;
    const px1 = person.x, py1 = person.y, px2 = person.x + person.width, py2 = person.y + person.height;

    const ix1 = Math.max(fx1, px1), iy1 = Math.max(fy1, py1);
    const ix2 = Math.min(fx2, px2), iy2 = Math.min(fy2, py2);
    const interArea = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
    const faceArea = Math.max(1, face.width * face.height);
    return interArea / faceArea;
  }

  private horizontalAlignment(face: BoundingBox, person: BoundingBox): number {
    const cxF = face.x + face.width / 2;
    const cxP = person.x + person.width / 2;
    const personW = Math.max(1, person.width);
    const dx = Math.abs(cxF - cxP);
    return 1 - Math.min(1, dx / (personW / 2));
  }

  private verticalTopPreference(face: BoundingBox, person: BoundingBox): number {
    const cyF = face.y + face.height / 2;
    const personH = Math.max(1, person.height);
    const yRel = Math.max(0, Math.min(1, (cyF - person.y) / personH));
    return 1 - yRel;
  }

  private greedyAssign(
    cost: number[][],
    score: number[][],
    big: number,
  ): Array<[number, number]> {
    const P = cost.length;
    const F = cost[0]?.length ?? 0;
    const usedFaces = new Set<number>();
    const matches: Array<[number, number]> = [];

    for (let i = 0; i < P; i++) {
      let bestCost = big;
      let bestJ = -1;
      for (let j = 0; j < F; j++) {
        if (usedFaces.has(j)) continue;
        if (cost[i]![j]! < bestCost) {
          bestCost = cost[i]![j]!;
          bestJ = j;
        }
      }
      if (bestJ >= 0 && bestCost < big && score[i]![bestJ]! >= this.sigmaMin) {
        matches.push([i, bestJ]);
        usedFaces.add(bestJ);
      }
    }
    return matches;
  }
}
