export const DASHBOARD_CHAT_UNAVAILABLE_MESSAGE = "Chat is temporarily unavailable. Please try again.";

export function resolveDashboardChatReply(answer: unknown, error: unknown): string {
  const errorText = typeof error === "string" ? error.trim() : "";
  if (errorText) return errorText;
  const answerText = typeof answer === "string" ? answer.trim() : "";
  return answerText || DASHBOARD_CHAT_UNAVAILABLE_MESSAGE;
}
