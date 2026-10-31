import type { BenchmarkQuestion } from "./types.js";

const OPTION_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const STOP_WORDS = new Set([
  "about", "after", "again", "also", "another", "because", "before", "between",
  "could", "difference", "following", "their", "there", "these", "thing", "those",
  "throw", "video", "which", "while", "would",
]);

const SHORT_KEYWORDS = new Set([
  "ai", "aj", "bus", "car", "suv", "taxi", "van",
]);

const KEYWORD_SYNONYMS: Record<string, string[]> = {
  favorite: ["favourite", "best", "delicious", "incredible", "loved"],
  favourite: ["favorite", "best", "delicious", "incredible", "loved"],
  picture: ["photo", "photograph", "selfie"],
  pictures: ["picture", "photo", "photos", "photograph", "selfie"],
  pictured: ["picture", "photo", "photograph"],
  photographed: ["picture", "photo", "photograph"],
  photograph: ["picture", "photo"],
  photo: ["picture", "photograph"],
  photos: ["picture", "pictures", "photograph"],
  taking: ["take", "took"],
  repairing: ["repair", "fixing", "fixed"],
  listening: ["listen", "heard", "hearing"],
  talking: ["talk", "said", "speaking"],
  recommended: ["recommend", "suggest", "suggested", "comments", "comment", "viewer", "viewers"],
  recommendation: ["recommend", "suggest", "suggested", "comments", "comment", "viewer", "viewers"],
  online: ["comments", "comment", "viewer", "viewers"],
  friends: ["comments", "comment", "viewer", "viewers"],
  friend: ["comments", "comment", "viewer", "viewers"],
};

const RETRIEVAL_META_WORDS = new Set([
  "according", "answer", "answers", "based", "best", "candidate", "candidates",
  "choice", "choices", "correct", "false", "following", "footage", "incorrect",
  "letter", "option", "options", "question", "respond", "select", "statement",
  "statements", "subtitles", "subtitle", "true", "video",
]);

const QUERY_STOP_PHRASES = [
  /\bbased on (?:the )?video\b/gi,
  /\bbased on (?:the )?footage\b/gi,
  /\bin accordance with (?:the )?(?:video|footage)\b/gi,
  /\baccording to (?:the )?(?:video|footage|subtitles?)\b/gi,
  /\bwhich of the following statements? (?:is|are) (?:correct|true|accurate|right|incorrect|false|wrong)\b/gi,
  /\bwhich of the following\b/gi,
  /\bselect the best answer\b/gi,
  /\brespond with only the letter\b/gi,
];

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function normalizeQuestionForRetrieval(question: string): string {
  const lines = question
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line =>
      !/^select the best answer\b/i.test(line)
      && !/^respond with only\b/i.test(line)
      && !/^answer with\b/i.test(line)
      && !/^choose from\b/i.test(line)
      && !/^[A-Z][.)]\s+/.test(line)
    );
  const cleaned = lines.join(" ").replace(/\s+/g, " ").trim();
  return cleaned || question;
}

export function extractKeywords(text: string): string[] {
  const seen = new Set<string>();
  for (const token of normalizeText(text).split(/\s+/)) {
    if ((token.length < 4 && !SHORT_KEYWORDS.has(token)) || STOP_WORDS.has(token)) continue;
    seen.add(token);
    for (const synonym of KEYWORD_SYNONYMS[token] ?? []) seen.add(synonym);
  }
  return [...seen];
}

function compactQueryTerms(terms: string[], maxItems = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const normalized = term.trim().replace(/\s+/g, " ");
    if (!normalized || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    out.push(normalized);
    if (out.length >= maxItems) break;
  }
  return out;
}

function orderedOptionCue(option: string): string[] {
  const labels = [...option.matchAll(/\(([a-z])\)/gi)]
    .map(match => match[1]?.toLowerCase())
    .filter((label): label is string => Boolean(label));
  if (labels.length < 2) return [];
  return ["option order", ...labels];
}

export function rewriteMemorySearchQueryForSemanticSearch(query: string, maxTerms = 18): string {
  let compact = query.trim().replace(/\s+/g, " ");
  for (const pattern of QUERY_STOP_PHRASES) {
    compact = compact.replace(pattern, " ");
  }
  compact = compact.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  const uppercaseBooleanJoiners = compact.match(/\b(?:OR|AND|NOT)\b/g) ?? [];
  const hasBooleanSyntax = /[()]/.test(compact)
    || uppercaseBooleanJoiners.length >= 2
    || /["“][^"”]{2,80}["”]\s+(?:or|and)\s+["“][^"”]{2,80}["”]/i.test(compact);
  if (!hasBooleanSyntax && compact.length <= 160) {
    const terms = compact.split(/\s+/);
    const filtered = stripRetrievalMetaTerms(terms).join(" ").trim();
    return filtered || compact;
  }

  let withoutQuotedBooleanJoiners = compact;
  for (let i = 0; i < 4; i++) {
    const next = withoutQuotedBooleanJoiners.replace(
      /(["“][^"”]{2,80}["”])\s+(?:or|and)\s+(["“][^"”]{2,80}["”])/gi,
      "$1 $2",
    );
    if (next === withoutQuotedBooleanJoiners) break;
    withoutQuotedBooleanJoiners = next;
  }

  const cleaned = withoutQuotedBooleanJoiners
    .replace(/[()]/g, " ")
    .replace(/\b(?:OR|AND|NOT)\b/g, " ")
    .replace(/["'“”‘’]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return compactQueryTerms(
    cleaned.split(/\s+/).filter(term => !RETRIEVAL_META_WORDS.has(term.toLowerCase())),
    maxTerms,
  ).join(" ");
}

function stripRetrievalMetaTerms(terms: string[]): string[] {
  return terms.filter(term => !RETRIEVAL_META_WORDS.has(term.toLowerCase()));
}

export type CandidateQueryHint = {
  letter: string;
  option: string;
  query: string;
};

export function buildCandidateQueryHints(q: BenchmarkQuestion, maxItems = 6): CandidateQueryHint[] {
  if (!q.options?.length) return [];
  const questionTerms = stripRetrievalMetaTerms(extractKeywords(normalizeQuestionForRetrieval(q.question)))
    .filter(term => !/^(?:select|answer|option|candidate|provided|based|information|respond|letter|correct|choices|choice|question|multiple|following|subtitles|subtitle|directly|best|with|statements|statement|only|what|which|main|character|person|people|someone|something|visually|visual|visible|scene|segment|during|when|while|they|them)$/.test(term))
    .slice(0, 10);
  const questionAndOptions = normalizeQuestionForRetrieval(`${q.question} ${q.options.join(" ")}`).toLowerCase();
  const perceptionCues: string[] = [];
  if (/\b(?:visual|visually|visible|shown|see|seen|look|wearing|holding|color|colour|object|gesture|action|scene)\b/.test(questionAndOptions)) {
    perceptionCues.push("visible", "scene");
  }
  if (/\b(?:said|says|speech|speak|speaks|talk|talks|mention|mentions|mentioned|heard|hear|audio|sound|music|voice|subtitle|transcript)\b/.test(questionAndOptions)) {
    perceptionCues.push("speech", "transcript");
  }
  if (/\b(?:text|title|caption|sign|label|screen|display|ocr|reading|reads)\b/.test(questionAndOptions)) {
    perceptionCues.push("on-screen text");
  }
  if (/\b(?:how many|number of|count|total|score|points)\b/.test(questionAndOptions)) {
    perceptionCues.push("count", "distinct instances");
  }
  if (/\b(?:order|sequence|first|last|before|after|next|introduced|process|step)\b/.test(questionAndOptions)) {
    perceptionCues.push("timeline", "sequence");
  }
  if (/\b(?:overall|theme|purpose|best|most|least|whole video|entire video)\b/.test(questionAndOptions) || /\bmain\s+(?:idea|theme|purpose|point|message|topic|reason)\b/.test(questionAndOptions)) {
    perceptionCues.push("summary", "overall");
  }
  const scopeCues: string[] = [];
  if (/\b(?:primary\s+(?:subject|topic|focus|theme|matter)|main\s+(?:subject|topic|focus|theme|idea|purpose|point|message)|primarily\s+about|mainly\s+about|subject\s+matter|central\s+(?:topic|theme|message)|whole video|entire video|overall|theme|best\s+(?:describes?|summari[sz]es?))\b/.test(questionAndOptions)) {
    scopeCues.push("opening", "title", "introduction", "recurring topic", "conclusion");
  }
  if (/\b(?:order|sequence|first|last|before|after|next|introduced|process|step)\b/.test(questionAndOptions)) {
    scopeCues.push("earliest timestamp", "first substantive occurrence");
  }
  const hints: CandidateQueryHint[] = [];
  const seen = new Set<string>();
  for (const [index, option] of q.options.entries()) {
    const optionTerms = stripRetrievalMetaTerms(extractKeywords(option));
    const orderCue = orderedOptionCue(option);
    const query = compactQueryTerms([...orderCue, ...optionTerms, ...questionTerms, ...scopeCues, ...perceptionCues.slice(0, 4)], 18).join(" ").trim();
    if (!query) continue;
    const key = query.trim().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    hints.push({
      letter: OPTION_LETTERS[index] ?? String(index + 1),
      option,
      query,
    });
    if (hints.length >= maxItems) break;
  }
  return hints;
}

export function buildCandidateQueries(q: BenchmarkQuestion, maxItems = 6): string[] {
  return buildCandidateQueryHints(q, maxItems).map(hint => hint.query);
}
