export interface DashboardChatToolResult {
  observation: string;
  ok: boolean;
}

interface DashboardChatMemorySearchOptions<T> {
  execute: () => Promise<T>;
  formatSuccess: (value: T) => string;
  onSuccess?: () => void;
  onFailure?: (error: unknown) => void;
}

export async function executeDashboardChatMemorySearch<T>(
  options: DashboardChatMemorySearchOptions<T>,
): Promise<DashboardChatToolResult> {
  try {
    const value = await options.execute();
    const observation = options.formatSuccess(value);
    options.onSuccess?.();
    return {
      ok: true,
      observation,
    };
  } catch (error) {
    options.onFailure?.(error);
    return {
      ok: false,
      observation: [
        "Tool memory_search failed.",
        "Result metadata: ok=false, result_count=0, exhaustive=false.",
      ].join("\n"),
    };
  }
}
