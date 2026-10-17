import { SKILL_EXPLANATION, type Baby, type BuilderAnswers, type SkillDraft } from "../types";

const FALLBACK_EXAMPLE = `---
name: emotional-development
description: Helps a mom sort an everyday feelings situation with her baby and find a next step she can actually do.
age_range_months: [0, 12]
created_by: mom
created_at: 2026-10-17
---

## When to use

Use this when a mom asks about her baby's feelings, crying, or a hard moment that is not a medical emergency.

## Instructions

Listen to the situation. Offer one sentence she can say and one thing she can do in the apartment.

## Safety rules

No diagnosis. Concerns about health go to the pediatrician.

## Output format

One sentence she can say, one thing she can do, and when to call the pediatrician instead.
`;

function insertUnder(markdown: string, heading: string, block: string) {
  const needle = `## ${heading}\n`;
  if (markdown.includes(needle)) {
    return markdown.replace(needle, `${needle}\n${block}\n`);
  }
  return `${markdown.trim()}\n\n## ${heading}\n\n${block}\n`;
}

export function buildSkillDraft(
  exampleMarkdown: string,
  safetyMarkdown: string,
  answers: BuilderAnswers,
): SkillDraft {
  const base = exampleMarkdown.trim() || FALLBACK_EXAMPLE;
  const context = [
    "Start from what she told you.",
    answers.wantHelpWith ? `- She wants help with: ${answers.wantHelpWith}` : "",
    answers.recentMoment ? `- A recent moment: ${answers.recentMoment}` : "",
    answers.answerShouldLookLike
      ? `- The answer should look like: ${answers.answerShouldLookLike}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  let markdown = insertUnder(base, "Instructions", context);
  const safety = safetyMarkdown.trim();
  if (safety && !markdown.includes(safety.slice(0, 48))) {
    markdown = insertUnder(markdown, "Safety rules", safety);
  }
  if (answers.answerShouldLookLike) {
    markdown = insertUnder(
      markdown,
      "Output format",
      `She asked for: ${answers.answerShouldLookLike}`,
    );
  }

  return { markdown, explanation: SKILL_EXPLANATION };
}

// ---------------------------------------------------------------------------
// The `create_skill` tool, Claude version. No SDK import here: this file is also
// bundled into the browser through demo-agent, so lib/agent.ts passes the call in.

/** Step 1: the 3 fixed builder questions. No model call. */
export const CREATE_SKILL_QUESTIONS = [
  "What do you want help with?",
  "Describe a recent moment when you needed it.",
  "What should a good answer look like?",
];

export type CreateSkillToolInput = {
  topic: string;
  babyAgeMonths?: number;
};

export const DRAFT_FAILED_ERROR = "The skill didn’t come out right. Tap Draft again.";

export class DraftError extends Error {}

/** Sends one prompt to Claude with a JSON schema and returns the raw text. */
export type CompleteJson = (
  system: string,
  user: string,
  schema: Record<string, unknown>,
) => Promise<string>;

const SKILL_FORMAT = `---
name: <topic, lowercase, words joined with hyphens>
description: <one everyday sentence>
age_range_months: [0, 12]
created_by: mom
created_at: <today>
---
## When to use
## Instructions
## Safety rules
## Output format`;

const DRAFT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    topic: { type: "string" },
    markdown: { type: "string" },
    explanation: {
      type: "object",
      properties: {
        whenToUse: { type: "string" },
        instructions: { type: "string" },
        safetyRules: { type: "string" },
        outputFormat: { type: "string" },
      },
      required: ["whenToUse", "instructions", "safetyRules", "outputFormat"],
      additionalProperties: false,
    },
  },
  required: ["topic", "markdown", "explanation"],
  additionalProperties: false,
};

export function slugify(topic: string) {
  return (
    topic
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .slice(0, 4)
      .join("-") || "my-skill"
  );
}

/** The server adds _safety.md under `## Safety rules`, so a mom cannot edit it away. */
export function withSafetyRules(markdown: string, safetyMarkdown: string) {
  const safety = safetyMarkdown.trim();
  if (!safety || markdown.includes(safety.slice(0, 48))) return markdown;
  return insertUnder(markdown, "Safety rules", safety);
}

function setFrontmatter(markdown: string, key: string, value: string) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return `---\n${key}: ${value}\n---\n${markdown.trim()}\n`;
  const lines = match[1].split("\n");
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (index >= 0) lines[index] = `${key}: ${value}`;
  else lines.push(`${key}: ${value}`);
  return markdown.replace(match[0], `---\n${lines.join("\n")}\n---`);
}

function parseDraft(text: string): (SkillDraft & { topic?: string }) | null {
  try {
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as SkillDraft & {
      topic?: string;
    };
    const e = json.explanation;
    const ok =
      typeof json.markdown === "string" &&
      ["When to use", "Instructions", "Safety rules", "Output format"].every((h) =>
        json.markdown.includes(`## ${h}`),
      ) &&
      e &&
      [e.whenToUse, e.instructions, e.safetyRules, e.outputFormat].every(
        (s) => typeof s === "string" && s.trim().length > 0,
      );
    return ok ? json : null;
  } catch {
    return null;
  }
}

/** Step 2: one Claude call that drafts and explains the skill. Tries twice, then throws DraftError. */
export async function draftSkill(
  complete: CompleteJson,
  args: {
    /** Her sentence, e.g. "Help me figure out emotional development for my kid." */
    request: string;
    /** Set when the router already named the topic. */
    topic?: string;
    baby: Baby;
    answers: BuilderAnswers;
    exampleMarkdown: string;
    safetyMarkdown: string;
  },
): Promise<SkillDraft> {
  const today = new Date().toISOString().slice(0, 10);
  const system = [
    "You write short skill files for a mom who has never written a prompt.",
    "A skill is a saved note that tells Claude how to help her with one kind of question.",
    "Write in everyday words, short sentences, calm. No jargon. No diagnosis, ever.",
    "Return JSON with `topic` (1-3 words, English, e.g. \"emotional development\"), `markdown` (the full skill file) and `explanation`:",
    "one plain sentence per section that tells her what that part of the skill does for her.",
  ].join("\n");
  const user = [
    `Her request: ${args.request}`,
    args.topic ? `Topic: ${args.topic}` : "Name the topic from her request.",
    "The frontmatter name is the topic, lowercase, with hyphens.",
    `Today: ${today}`,
    `Baby: ${args.baby.ageMonths} months old. At home: ${args.baby.materials || "not said"}. Time: ${args.baby.minutesAvailable || "not said"} minutes.`,
    "",
    "Her 3 answers:",
    `1. What she wants help with: ${args.answers.wantHelpWith}`,
    `2. A recent moment: ${args.answers.recentMoment}`,
    `3. What a good answer looks like: ${args.answers.answerShouldLookLike}`,
    "",
    "The skill format (four sections, in this order):",
    SKILL_FORMAT,
    "",
    "An example to aim for:",
    args.exampleMarkdown.trim() || FALLBACK_EXAMPLE,
    "",
    "Shared safety rules. Put them under ## Safety rules, word for word:",
    args.safetyMarkdown.trim(),
  ].join("\n");

  for (let attempt = 0; attempt < 2; attempt++) {
    const draft = parseDraft(await complete(system, user, DRAFT_SCHEMA));
    if (!draft) continue;
    const name = slugify(args.topic || draft.topic || args.request);
    let markdown = setFrontmatter(draft.markdown.trim(), "name", name);
    markdown = setFrontmatter(markdown, "created_by", "mom");
    markdown = setFrontmatter(markdown, "created_at", today);
    markdown = withSafetyRules(markdown, args.safetyMarkdown);
    return { markdown, explanation: draft.explanation };
  }
  throw new DraftError(DRAFT_FAILED_ERROR);
}
