// packages/percept/src/providers/custom/types.ts
/**
 * User-custom provider interfaces.
 *
 * Extension point for user-provided ONNX or remote inference providers.
 *
 * runtime: "onnx-builtin" + modelPath → loads custom ONNX
 * runtime: "remote" + endpoint → HTTP calls to user's service
 */
export interface UserProviderConfig {
  name: string;
  type: string;
  runtime: "onnx-builtin" | "remote";
  modelPath?: string;
  endpoint?: string;
}
