import type { RawVlmResponse } from "./types.js";

/** Attempt to repair truncated JSON by closing open strings, arrays, and objects. */
export function repairTruncatedJson(text: string): string {
  // Strip trailing incomplete key-value pairs (e.g. `"key": "val` or `"key":`)
  let s = text.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"{}[\]]*$/, "");
  // Close open strings
  const quoteCount = (s.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) s += '"';
  // Close open arrays and objects
  const stack: string[] = [];
  for (const ch of s) {
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" && stack.at(-1) === "{") stack.pop();
    else if (ch === "]" && stack.at(-1) === "[") stack.pop();
  }
  while (stack.length) {
    const open = stack.pop();
    s += open === "{" ? "}" : "]";
  }
  return s;
}

export function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

export function extractJsonObject(text: string): string {
  const stripped = stripJsonFences(text);
  const first = stripped.indexOf("{");
  const last = stripped.lastIndexOf("}");
  if (first >= 0 && last > first) return stripped.slice(first, last + 1);
  return stripped;
}

export function removeTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, "$1");
}

export function parseJsonResponse(text: string): RawVlmResponse {
  const candidates = [
    stripJsonFences(text),
    extractJsonObject(text),
  ];

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as RawVlmResponse;
    } catch {
      // Try normalized variants below.
    }
    const noTrailingCommas = removeTrailingCommas(candidate);
    try {
      return JSON.parse(noTrailingCommas) as RawVlmResponse;
    } catch {
      // Try truncation repair below.
    }
    try {
      return JSON.parse(removeTrailingCommas(repairTruncatedJson(noTrailingCommas))) as RawVlmResponse;
    } catch {
      // Continue to next candidate.
    }
  }

  return JSON.parse(removeTrailingCommas(repairTruncatedJson(extractJsonObject(text)))) as RawVlmResponse;
}

export function extractClosedJsonStringField(text: string, field: string): string | undefined {
  const key = `"${field.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
  const keyIndex = text.indexOf(key);
  if (keyIndex < 0) return undefined;
  let i = keyIndex + key.length;
  while (i < text.length && /\s/.test(text[i]!)) i += 1;
  if (text[i] !== ":") return undefined;
  i += 1;
  while (i < text.length && /\s/.test(text[i]!)) i += 1;
  if (text[i] !== '"') return undefined;

  const start = i;
  i += 1;
  let escaped = false;
  while (i < text.length) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === '"') {
      try {
        return JSON.parse(text.slice(start, i + 1)) as string;
      } catch {
        return undefined;
      }
    }
    i += 1;
  }
  return undefined;
}

export function extractClosedJsonValueField(text: string, field: string): unknown {
  const key = `"${field.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
  const keyIndex = text.indexOf(key);
  if (keyIndex < 0) return undefined;
  let i = keyIndex + key.length;
  while (i < text.length && /\s/.test(text[i]!)) i += 1;
  if (text[i] !== ":") return undefined;
  i += 1;
  while (i < text.length && /\s/.test(text[i]!)) i += 1;
  const start = i;
  const first = text[i];
  if (!first) return undefined;

  if (first === '"') {
    const value = extractClosedJsonStringField(text, field);
    return value === undefined ? undefined : value;
  }

  if (first === "{" || first === "[") {
    const stack = [first];
    i += 1;
    let escaped = false;
    let inString = false;
    while (i < text.length) {
      const ch = text[i]!;
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
      } else if (ch === '"') {
        inString = true;
      } else if (ch === "{" || ch === "[") {
        stack.push(ch);
      } else if (ch === "}" || ch === "]") {
        const expected = stack[stack.length - 1] === "{" ? "}" : "]";
        if (ch !== expected) return undefined;
        stack.pop();
        if (stack.length === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1)) as unknown;
          } catch {
            return undefined;
          }
        }
      }
      i += 1;
    }
    return undefined;
  }

  const literalMatch = text.slice(start).match(/^(true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*[,}])/);
  if (!literalMatch) return undefined;
  try {
    return JSON.parse(literalMatch[1]!) as unknown;
  } catch {
    return undefined;
  }
}
