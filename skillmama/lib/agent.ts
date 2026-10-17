// Person 3 — Claude. See worksplit.md Role 3.
// Server only: imports the Anthropic SDK and reads ANTHROPIC_API_KEY.

/** The model, in one place. Current Claude Sonnet per today's Anthropic docs. */
export const CLAUDE_MODEL = "claude-sonnet-5-5";

import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageParam, BetaTool, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { findActivities, type MontessoriToolInput } from "./skills/montessori";
import {
  CREATE_SKILL_QUESTIONS,
  draftSkill,
  withSafetyRules,
  type CompleteJson,
  type CreateSkillToolInput,
} from "./skills/create";
import type { Activity, AgentRequest, AgentResponse, Corpus, SkillCard } from "./types";

export type { AgentRequest, AgentResponse };

export const AGENT_UNAVAILABLE_ERROR =
  "The answer isn’t coming through right now. You can send the sentence again in a moment.";

/** Thrown when the key is missing or Claude can't be reached. The route turns it into a 502. */
export class AgentUnavailableError extends Error {}

const MAX_TURNS = 5;

const SYSTEM_PROMPT = `You are SkillMama. You are talking to a mom who is in the room with her baby right now.
Write short sentences. Calm, warm, concrete. No jargon.

How to decide:
- Emergency first. If the message describes a medical emergency (not breathing, unconscious, blue lips, seizure, a bad fall, poisoning), call no tool. In reply, tell her to call 112 now, and 116 117 for non-emergency medical help in Germany. Set learnPrompt to "".
- Ask at most one follow-up. The only follow-up you need is the baby's age, and only when baby.ageMonths is missing or 0 and you would need it. Then call no tool and put the one question in reply. Set learnPrompt to "Next time you can say your baby's age in months in the same sentence."
- When the question is about what to do with the baby, Montessori, play, activities, or keeping the baby busy: call montessori_activity.
- When one of her saved skills (momSkills) fits the question: follow that skill's markdown, answer in reply, and set skillUsed to that skill's name. Call no tool.
- When the question is a topic that has no skill yet, especially feelings and emotional development: call create_skill.
- The mom may write in German or English. Same rules. Answer in the language she used.

Activities:
- Use only activities from the montessori_activity tool result. Never invent one. Leave out anything that is not in the result.
- Fit what she has at home (baby.materials) and her time (baby.minutesAvailable).
- The app shows each activity as a card with how to prepare, what to observe, and why it helps. Your reply is one or two short sentences that introduce them. Do not repeat the cards.

Always:
- Offer a diagnosis zero times. Concerns about milestones or health go to the pediatrician.
- When you explain a skill, write for someone who has never written a prompt. One sentence per section.
- learnPrompt is one sentence she can say next time, starting with "Next time you can say:". Use only facts from <baby>; never invent an age or materials.

Your final answer is JSON: reply, learnPrompt, skillUsed (the momSkills name you followed, or "").`;

const TOOLS: BetaTool[] = [
  {
    name: "montessori_activity",
    description:
      "Finds 1–3 Montessori activities for the baby's age from the app's research list. Use it for any question about what to do or play with the baby.",
    input_schema: {
      type: "object",
      properties: {
        babyAgeMonths: { type: "number", description: "The baby's age in months." },
        situation: { type: "string", description: "What the mom said about the moment, in a few words." },
        avoidIds: {
          type: "array",
          items: { type: "string" },
          description: "Activity ids to leave out.",
        },
      },
      required: ["babyAgeMonths"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "create_skill",
    description:
      "Starts building a new skill with the mom when her question has no skill yet, for example feelings or emotional development. Returns 3 questions the app will ask her.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "The topic in 1–3 English words, e.g. \"emotional development\"." },
        babyAgeMonths: { type: "number" },
      },
      required: ["topic"],
      additionalProperties: false,
    },
    strict: true,
  },
];

const FINAL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    reply: { type: "string" },
    learnPrompt: { type: "string" },
    skillUsed: { type: "string" },
  },
  required: ["reply", "learnPrompt", "skillUsed"],
  additionalProperties: false,
};

type FinalAnswer = { reply: string; learnPrompt: string; skillUsed: string };

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) throw new AgentUnavailableError("ANTHROPIC_API_KEY is not set");
  return new Anthropic({ timeout: 60_000, maxRetries: 1 });
}

/** Common request fields. Server-side fallback reroutes a refused request instead of stopping. */
function baseParams() {
  return {
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default" as const,
  };
}

function textOf(content: Anthropic.Beta.BetaContentBlock[]) {
  return content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function parseFinal(text: string): FinalAnswer {
  try {
    const json = JSON.parse(text) as Partial<FinalAnswer>;
    return {
      reply: typeof json.reply === "string" ? json.reply : "",
      learnPrompt: typeof json.learnPrompt === "string" ? json.learnPrompt : "",
      skillUsed: typeof json.skillUsed === "string" ? json.skillUsed : "",
    };
  } catch {
    // Not JSON: still show what Claude wrote.
    return { reply: text.trim(), learnPrompt: "", skillUsed: "" };
  }
}

function skillList(request: AgentRequest, corpus: Corpus) {
  const seed = withSafetyRules(corpus.seedMarkdown, corpus.safetyMarkdown);
  const mom = (request.momSkills ?? []).map((skill: SkillCard) => ({
    name: skill.name,
    description: skill.description,
    markdown: withSafetyRules(skill.markdown, corpus.safetyMarkdown),
  }));
  return { seed, mom };
}

function contextMessage(request: AgentRequest, corpus: Corpus) {
  const { seed, mom } = skillList(request, corpus);
  return [
    `<baby>${JSON.stringify(request.baby ?? {})}</baby>`,
    `<seed_skill tool="montessori_activity">\n${seed}\n</seed_skill>`,
    mom.length
      ? `<mom_skills>\n${mom
          .map((skill) => `<skill name="${skill.name}">\n${skill.markdown}\n</skill>`)
          .join("\n")}\n</mom_skills>`
      : "<mom_skills>none saved yet</mom_skills>",
    `<message>${request.message}</message>`,
  ].join("\n\n");
}

export async function runAgent(request: AgentRequest, corpus: Corpus): Promise<AgentResponse> {
  const client = getClient();
  const baby = request.baby;

  try {
    // Step 2 of the builder: she answered the 3 questions. Skip the router.
    if (request.builderAnswers) {
      const complete: CompleteJson = async (system, user, schema) => {
        const response = await client.beta.messages.create({
          ...baseParams(),
          output_config: { effort: "low", format: { type: "json_schema", schema } },
          system,
          messages: [{ role: "user", content: user }],
        });
        return response.stop_reason === "refusal" ? "" : textOf(response.content);
      };
      const draft = await draftSkill(complete, {
        request: request.message,
        baby,
        answers: request.builderAnswers,
        exampleMarkdown: corpus.exampleMarkdown,
        safetyMarkdown: corpus.safetyMarkdown,
      });
      return {
        reply:
          "This is a new skill, written from what you just told me. Read what each part means, change anything you want, then save it.",
        skillUsed: "create_skill",
        mode: "draft",
        results: draft,
        learnPrompt: "Next time you can say what you want help with, and the moment it happened.",
      };
    }

    const messages: BetaMessageParam[] = [{ role: "user", content: contextMessage(request, corpus) }];
    let activities: Activity[] | null = null;
    let createdSkill = false;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await client.beta.messages.create({
        ...baseParams(),
        output_config: { effort: "low", format: { type: "json_schema", schema: FINAL_SCHEMA } },
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });

      if (response.stop_reason === "refusal") {
        throw new AgentUnavailableError(`Refused: ${response.stop_details?.category ?? "unknown"}`);
      }

      const toolUses = response.content.filter(
        (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use",
      );
      // Thinking blocks go back unchanged with the rest of the turn.
      messages.push({ role: "assistant", content: response.content });

      if (toolUses.length === 0 || response.stop_reason !== "tool_use") {
        const final = parseFinal(textOf(response.content));
        if (createdSkill) {
          return {
            reply: final.reply,
            skillUsed: "create_skill",
            mode: "create",
            results: CREATE_SKILL_QUESTIONS,
            learnPrompt: final.learnPrompt,
          };
        }
        if (activities) {
          return {
            reply: final.reply,
            skillUsed: "montessori_activity",
            mode: "use",
            results: activities,
            learnPrompt: final.learnPrompt,
          };
        }
        const momSkill = (request.momSkills ?? []).find((skill) => skill.name === final.skillUsed);
        return {
          reply: final.reply,
          skillUsed: momSkill ? momSkill.name : "",
          mode: "use",
          results: [],
          learnPrompt: final.learnPrompt,
        };
      }

      const results: BetaToolResultBlockParam[] = toolUses.map((tool) => {
        if (tool.name === "montessori_activity") {
          const input = tool.input as MontessoriToolInput;
          activities = findActivities(corpus.activities, baby, {
            ...input,
            babyAgeMonths: baby?.ageMonths > 0 ? baby.ageMonths : input.babyAgeMonths,
          });
          return { type: "tool_result", tool_use_id: tool.id, content: JSON.stringify(activities) };
        }
        if (tool.name === "create_skill") {
          const input = tool.input as CreateSkillToolInput;
          createdSkill = true;
          return {
            type: "tool_result",
            tool_use_id: tool.id,
            content: JSON.stringify({
              topic: input.topic,
              questions: CREATE_SKILL_QUESTIONS,
              note: "The app now asks her these 3 questions. In reply, tell her in one sentence that there is no skill for this yet and that 3 short questions will build one.",
            }),
          };
        }
        return { type: "tool_result", tool_use_id: tool.id, content: `Unknown tool ${tool.name}`, is_error: true };
      });
      messages.push({ role: "user", content: results });
    }

    throw new AgentUnavailableError("Too many tool turns");
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      throw new AgentUnavailableError(`Claude API error ${error.status}: ${error.message}`);
    }
    throw error;
  }
}
