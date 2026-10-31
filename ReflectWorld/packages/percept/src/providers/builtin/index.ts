// packages/percept/src/providers/builtin/index.ts
import type { ModelManager } from "../../models/model-manager.js";
import type { AnyProvider } from "../types.js";
import { Yolo26BuiltinProvider } from "./yolo26-provider.js";
import { RetinaFaceBuiltinProvider } from "./retinaface-provider.js";
import { AdaFaceBuiltinProvider } from "./adaface-provider.js";
import { ClipReidBuiltinProvider } from "./clip-reid-provider.js";
import { RtmPoseBuiltinProvider } from "./rtmpose-provider.js";

export { OnnxBuiltinBase } from "./onnx-builtin-base.js";
export { Yolo26BuiltinProvider } from "./yolo26-provider.js";
export { RetinaFaceBuiltinProvider } from "./retinaface-provider.js";
export { AdaFaceBuiltinProvider } from "./adaface-provider.js";
export { ClipReidBuiltinProvider } from "./clip-reid-provider.js";
export { RtmPoseBuiltinProvider } from "./rtmpose-provider.js";

/**
 * Factory: create all builtin providers from a ModelManager.
 * Returns all providers — uninstalled ones will stay not-ready after initialize().
 */
export function createBuiltinProviders(
  modelManager: ModelManager,
  options: { includeBodyReId?: boolean } = {},
): AnyProvider[] {
  const providers: AnyProvider[] = [
    new Yolo26BuiltinProvider(modelManager),
    new RetinaFaceBuiltinProvider(modelManager),
    new AdaFaceBuiltinProvider(modelManager),
  ];
  if (options.includeBodyReId) {
    providers.push(
      new ClipReidBuiltinProvider(modelManager),
      new RtmPoseBuiltinProvider(modelManager),
    );
  }
  return providers;
}
