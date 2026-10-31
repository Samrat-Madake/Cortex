export function displayRefFromTarget(
  target: Record<string, unknown>,
): string | null {
  const explicitRef = target.ref;
  if (typeof explicitRef === "string" || typeof explicitRef === "number") return String(explicitRef);
  const subjectIndex = typeof target.subject_index === "number" && Number.isFinite(target.subject_index)
    ? Math.max(1, Math.floor(target.subject_index))
    : null;
  if (!subjectIndex) return null;
  const rawType = typeof target.type === "string"
    ? target.type
    : typeof target.class_name === "string"
      ? target.class_name
      : "object";
  const category = rawType.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_") || "object";
  return `${category}:${subjectIndex}`;
}
