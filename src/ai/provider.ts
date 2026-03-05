import { GoogleGenerativeAI } from "@google/generative-ai";
import { GenerateRequestSchema, LessonBundleSchema, type LessonBundle } from "@academy/shared";
import { z } from "zod";
import { env } from "../config";
import { validateChallengeQuality } from "./quality";

export interface AIProvider {
  generateLessonBundle(input: { extractedText: string; language: "en" | "sr" }): Promise<LessonBundle>;
}

const JsonResponseSchema = z.object({
  lesson: z.object({
    title: z.string(),
    summary: z.string(),
    keyTerms: z.array(z.object({ term: z.string(), definition: z.string() })),
    insights: z.array(z.object({ headline: z.string(), explanation: z.string() })),
    language: z.enum(["en", "sr"])
  }),
  challenges: z.array(z.any())
});

const InventoryItemSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["concept", "method", "comparison", "example", "edge_case", "trap"]),
  label: z.string().min(1),
  evidence: z.string().min(1),
  priority: z.number().int().min(1).max(5).default(3)
});

const InventorySchema = z.array(InventoryItemSchema).min(1);

function normalizeInventoryType(rawType: unknown, label: string): z.infer<typeof InventoryItemSchema>["type"] {
  const normalized = String(rawType ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  const aliasMap: Record<string, z.infer<typeof InventoryItemSchema>["type"]> = {
    concept: "concept",
    term: "concept",
    terminology: "concept",
    method: "method",
    function: "method",
    api: "method",
    comparison: "comparison",
    compare: "comparison",
    example: "example",
    code_example: "example",
    snippet: "example",
    edge_case: "edge_case",
    edgecase: "edge_case",
    corner_case: "edge_case",
    trap: "trap",
    pitfall: "trap",
    gotcha: "trap"
  };

  if (normalized in aliasMap) {
    return aliasMap[normalized];
  }

  const labelHint = label.toLowerCase();
  if (labelHint.includes(" vs ") || labelHint.includes("difference")) {
    return "comparison";
  }
  if (labelHint.includes("null") || labelHint.includes("edge") || labelHint.includes("case")) {
    return "edge_case";
  }

  return "concept";
}

function normalizeInventoryItem(value: unknown, index: number): z.infer<typeof InventoryItemSchema> {
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const label = String(source.label ?? source.term ?? source.name ?? `item-${index + 1}`).trim();
  const evidence = String(source.evidence ?? source.reason ?? source.note ?? label).trim();

  return {
    id: String(source.id ?? `item-${index + 1}`),
    type: normalizeInventoryType(source.type, label),
    label: label || `item-${index + 1}`,
    evidence: evidence || label || "No evidence provided.",
    priority: Number.isFinite(Number(source.priority)) ? Number(source.priority) : 3
  };
}

function extractMethodCandidates(sourceText: string): string[] {
  const matches = sourceText.match(/[A-Za-z_][A-Za-z0-9_]*\s*\(/g) ?? [];
  const cleaned = matches
    .map((match) => match.replace("(", "").trim())
    .filter((name) => name.length > 2);
  return [...new Set(cleaned)].slice(0, 40);
}

function extractComparisonCandidates(sourceText: string): string[] {
  const candidates: string[] = [];
  const lower = sourceText.toLowerCase();
  if (lower.includes("stringbuilder") && lower.includes("stringbuffer")) {
    candidates.push("StringBuilder vs StringBuffer");
  }
  if (lower.includes("null") && (lower.includes('""') || lower.includes("prazan string"))) {
    candidates.push('null vs ""');
  }
  if (lower.includes("new string") || lower.includes("literal")) {
    candidates.push("new String(...) vs string literal");
  }
  if (lower.includes("pool")) {
    candidates.push("reference equality and pooling implications");
  }
  return candidates;
}

function parseInventory(jsonLike: unknown): Array<z.infer<typeof InventoryItemSchema>> {
  if (Array.isArray(jsonLike)) {
    return InventorySchema.parse(jsonLike.map(normalizeInventoryItem));
  }
  if (typeof jsonLike === "object" && jsonLike !== null && Array.isArray((jsonLike as { items?: unknown[] }).items)) {
    return InventorySchema.parse((jsonLike as { items: unknown[] }).items.map(normalizeInventoryItem));
  }
  throw new Error("Inventory extraction did not return a valid array.");
}

function findMissingCoverageByInventory(
  bundle: LessonBundle,
  inventory: Array<z.infer<typeof InventoryItemSchema>>
): string[] {
  const challengeCorpus = bundle.challenges
    .map((challenge) => JSON.stringify(challenge).toLowerCase())
    .join("\n");

  const missing: string[] = [];
  for (const item of inventory) {
    const itemLabel = item.label.toLowerCase();
    const tokens = itemLabel.split(/[^a-z0-9_]+/i).filter((token) => token.length >= 3);
    const hasCoverage = tokens.some((token) => challengeCorpus.includes(token));
    if (!hasCoverage) {
      missing.push(item.label);
    }
  }
  return missing;
}

function toKeyTermObject(value: unknown): { term: string; definition: string } {
  if (typeof value === "object" && value !== null) {
    const candidate = value as { term?: unknown; definition?: unknown };
    return {
      term: String(candidate.term ?? "").trim(),
      definition: String(candidate.definition ?? "").trim()
    };
  }

  const raw = String(value ?? "").trim();
  if (raw.length === 0) {
    return { term: "Key term", definition: "Missing definition." };
  }

  const splitIndex = raw.indexOf(":");
  if (splitIndex > 0) {
    return {
      term: raw.slice(0, splitIndex).trim(),
      definition: raw.slice(splitIndex + 1).trim() || "Definition not provided."
    };
  }

  return {
    term: raw,
    definition: "Definition not provided."
  };
}

function toInsightObject(value: unknown): { headline: string; explanation: string } {
  if (typeof value === "object" && value !== null) {
    const candidate = value as { headline?: unknown; explanation?: unknown };
    return {
      headline: String(candidate.headline ?? "").trim(),
      explanation: String(candidate.explanation ?? "").trim()
    };
  }

  const raw = String(value ?? "").trim();
  if (raw.length === 0) {
    return { headline: "Insight", explanation: "No explanation provided." };
  }

  const splitIndex = raw.indexOf(":");
  if (splitIndex > 0) {
    return {
      headline: raw.slice(0, splitIndex).trim(),
      explanation: raw.slice(splitIndex + 1).trim() || "No explanation provided."
    };
  }

  return {
    headline: raw.length > 80 ? `${raw.slice(0, 77)}...` : raw,
    explanation: raw
  };
}

function toStringArray(values: unknown, minLength: number, fallbackPrefix: string): string[] {
  const raw = Array.isArray(values) ? values.map((v) => String(v ?? "").trim()).filter(Boolean) : [];
  const result = [...raw];
  while (result.length < minLength) {
    result.push(`${fallbackPrefix} ${result.length + 1}`);
  }
  return result.slice(0, Math.max(minLength, result.length));
}

function normalizeChallengeObject(value: unknown, index: number): Record<string, unknown> {
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const options = Array.isArray(source.options) ? source.options.map((v) => String(v ?? "").trim()).filter(Boolean) : [];
  const inferredType = source.type === "coding" || source.type === "mcq" ? source.type : options.length > 0 ? "mcq" : "coding";
  const id = String(source.id ?? `${inferredType}-${index + 1}`);
  const question = String(source.question ?? source.prompt ?? "Answer the challenge.").trim();

  if (inferredType === "mcq") {
    const normalizedOptions = toStringArray(options, 4, "Option");
    const rawCorrect = Number(source.correctIndex);
    const correctIndex = Number.isFinite(rawCorrect) && rawCorrect >= 0 && rawCorrect < 4 ? rawCorrect : 0;
    const explanation = String(source.explanation ?? source.reasoning ?? "Review the concept and try again.").trim();
    const wrongExplanations = toStringArray(source.whyWrongExplanations, 3, "Distractor explanation");
    return {
      id,
      type: "mcq",
      question,
      options: normalizedOptions,
      correctIndex,
      explanation,
      whyWrongExplanations: wrongExplanations
    };
  }

  const starterCode = String(
    source.starterCode ??
      source.codeTemplate ??
      source.template ??
      "def solve(input_value):\n    # TODO\n    return input_value"
  ).trim();
  const solution = String(source.solution ?? source.answer ?? "def solve(input_value):\n    return input_value").trim();
  const hint = String(source.hint ?? "Break the problem into smaller steps.").trim();
  const ahaInsight = String(source.ahaInsight ?? source.insight ?? "You learned how to translate concept into code.").trim();
  const rawTestCases = Array.isArray(source.testCases) ? source.testCases : [];
  const testCases = rawTestCases
    .map((testCase) => {
      const t = typeof testCase === "object" && testCase !== null ? (testCase as Record<string, unknown>) : {};
      return {
        input: String(t.input ?? ""),
        expected: String(t.expected ?? "")
      };
    })
    .filter((tc) => tc.input.length > 0 || tc.expected.length > 0);

  if (testCases.length === 0) {
    testCases.push({ input: "example", expected: "example" });
  }

  return {
    id,
    type: "coding",
    question,
    starterCode,
    solution,
    hint,
    ahaInsight,
    testCases
  };
}

export function normalizeLessonBundleShape(input: unknown): unknown {
  if (typeof input !== "object" || input === null) {
    return input;
  }

  const payload = input as {
    lesson?: {
      keyTerms?: unknown[];
      insights?: unknown[];
    };
  };

  if (!payload.lesson || typeof payload.lesson !== "object") {
    return input;
  }

  const lesson = payload.lesson;
  const normalized = { ...payload, lesson: { ...lesson } };

  if (Array.isArray(lesson.keyTerms)) {
    normalized.lesson.keyTerms = lesson.keyTerms.map(toKeyTermObject);
  }

  if (Array.isArray(lesson.insights)) {
    normalized.lesson.insights = lesson.insights.map(toInsightObject);
  }

  if (Array.isArray((payload as { challenges?: unknown[] }).challenges)) {
    const challenges = (payload as { challenges: unknown[] }).challenges;
    (normalized as { challenges?: unknown[] }).challenges = challenges.map((challenge, index) =>
      normalizeChallengeObject(challenge, index)
    );
  }

  return normalized;
}

function tryParseJson(candidate: string): unknown | null {
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function extractFirstBalancedJsonChunk(text: string): string | null {
  const startIndex = [...text].findIndex((char) => char === "{" || char === "[");
  if (startIndex < 0) {
    return null;
  }

  const opening = text[startIndex];
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === opening) {
      depth += 1;
    } else if (char === closing) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
    }
  }

  return null;
}

function extractJsonFromText(text: string): unknown {
  const trimmed = text.trim();

  const direct = tryParseJson(trimmed);
  if (direct !== null) {
    return direct;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const fencedParsed = tryParseJson(fenced[1].trim());
    if (fencedParsed !== null) {
      return fencedParsed;
    }
  }

  const balancedChunk = extractFirstBalancedJsonChunk(trimmed);
  if (balancedChunk) {
    const balancedParsed = tryParseJson(balancedChunk);
    if (balancedParsed !== null) {
      return balancedParsed;
    }
  }

  throw new Error("AI response did not contain valid JSON.");
}

function buildCoverageChecklist(sourceText: string): string[] {
  const checks: Array<{ name: string; pattern: RegExp }> = [
    { name: "String as an object/class concept", pattern: /klasa string|string class|string object/i },
    { name: "Both instantiation styles (new String and literals)", pattern: /new string|string s1 =|literal/i },
    { name: "Immutability of strings", pattern: /imutabil|immutab/i },
    { name: "String pooling concept", pattern: /pooling|string pool/i },
    { name: "Difference between empty string and null", pattern: /empty string|prazan string|null/i },
    { name: "StringBuilder and StringBuffer distinction", pattern: /stringbuilder|stringbuffer/i }
  ];

  return checks.filter((check) => check.pattern.test(sourceText)).map((check) => check.name);
}

function trimContext(text: string): string {
  const maxChars = 18_000;
  if (text.length <= maxChars) {
    return text;
  }

  const head = text.slice(0, 12_000);
  const tail = text.slice(-6_000);
  return `${head}\n\n[...middle content omitted for token efficiency...]\n\n${tail}`;
}

export class GeminiAIProvider implements AIProvider {
  private readonly client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async generateLessonBundle(input: {
    extractedText: string;
    language: "en" | "sr";
  }): Promise<LessonBundle> {
    const parsedInput = GenerateRequestSchema.parse(input);
    const model = this.client.getGenerativeModel({
      model: env.GEMINI_MODEL,
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.35
      }
    });

    const coverageChecklist = buildCoverageChecklist(parsedInput.extractedText);
    const methodCandidates = extractMethodCandidates(parsedInput.extractedText);
    const comparisonCandidates = extractComparisonCandidates(parsedInput.extractedText);
    const contextText = trimContext(parsedInput.extractedText);
    const passOnePrompt = `You are a strict academic extractor.
Do NOT summarize. Inventory only.

Task:
Extract and list EVERY distinct concept, method, term, code example, comparison, edge case, and likely exam trap from the source text.
Miss nothing.
Return ONLY valid JSON as a flat array of items.

Required item format:
[
  {
    "id": "item-1",
    "type": "concept|method|comparison|example|edge_case|trap",
    "label": "short label",
    "evidence": "short quote or paraphrase grounded in source",
    "priority": 1-5
  }
]

language: ${parsedInput.language}
mustCoverFromSource: ${JSON.stringify(coverageChecklist)}
methodCandidatesFromSource: ${JSON.stringify(methodCandidates)}
comparisonCandidatesFromSource: ${JSON.stringify(comparisonCandidates)}
sourceMaterial:
${contextText}`;

    const passOneResult = await model.generateContent(passOnePrompt);
    const passOneText = passOneResult.response.text();
    const inventory = parseInventory(extractJsonFromText(passOneText));

    const finalPrompt = `Generate a strict JSON object with keys "lesson" and "challenges".
Requirements:
- language: ${parsedInput.language}
- based only on this educational text:
${contextText}
- lesson must contain: title, summary, keyTerms, insights, language.
- summary must be detailed and teaching-focused (minimum 220 chars).
- keyTerms must include at least 5 terms.
- keyTerms must be objects: [{ "term": "...", "definition": "..." }]
- insights must be objects: [{ "headline": "...", "explanation": "..." }]
- challenges must include both mcq and coding.
- For EACH inventory item, generate at least one challenge that requires knowing that specific item.
- For EACH named method, include at least one "what is output / what does this method do" challenge.
- For EACH explicit comparison, include at least one "which would you choose and why" challenge.
- For EACH code example, include at least one "output or bug spotting" challenge.
- each MCQ needs exactly 4 options, correctIndex, explanation, whyWrongExplanations (3 items).
- each coding challenge needs starterCode, solution, hint, ahaInsight, and testCases.
- ensure explicit coverage of: ${JSON.stringify(coverageChecklist)}
- use this full inventory as a checklist:
${JSON.stringify(inventory)}
- SELF-AUDIT REQUIRED:
  1) After drafting challenges, compare against inventory.
  2) List missing inventory items internally.
  3) Generate extra challenges for each missing item.
  4) Do not stop until every inventory item has challenge coverage.
- respond with valid JSON only`;

    const result = await model.generateContent(finalPrompt);
    const responseText = result.response.text();
    let json = normalizeLessonBundleShape(extractJsonFromText(responseText));

    try {
      JsonResponseSchema.parse(json);
      const parsed = LessonBundleSchema.parse(json);
      const issues = validateChallengeQuality(parsed, parsedInput.extractedText);
      const missingCoverage = findMissingCoverageByInventory(parsed, inventory);
      const allIssues = [...issues, ...missingCoverage.map((label) => `Missing challenge coverage for inventory item: ${label}`)];
      if (allIssues.length === 0) {
        return parsed;
      }

      const repairPrompt = `Repair this JSON lesson bundle so it passes validation issues.
Validation issues: ${JSON.stringify(allIssues)}
Critical rule: every inventory item needs at least one challenge.
Inventory:
${JSON.stringify(inventory)}
Do not change language.
Return valid JSON only with keys lesson and challenges.

Current JSON:
${JSON.stringify(json)}`;
      const repairResult = await model.generateContent(repairPrompt);
      const repairText = repairResult.response.text();
      json = normalizeLessonBundleShape(extractJsonFromText(repairText));
      JsonResponseSchema.parse(json);
      return LessonBundleSchema.parse(json);
    } catch (error) {
      throw new Error(`Gemini output validation failed: ${String(error)}`);
    }
  }
}

export function createAIProvider(): AIProvider {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is required. Runtime mock data has been removed.");
  }
  return new GeminiAIProvider(env.GEMINI_API_KEY);
}
