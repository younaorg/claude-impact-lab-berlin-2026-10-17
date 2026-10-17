// Person 3 — Claude. Thin route: read the files, call runAgent.
// If this returns 502 (no key, Claude unreachable), the page repeats the demo brain,
// so the demo still plays.

import { readFileSync } from "node:fs";
import path from "node:path";
import { AGENT_UNAVAILABLE_ERROR, runAgent } from "../../../lib/agent";
import { normalizeActivities } from "../../../lib/demo-agent";
import { DraftError, DRAFT_FAILED_ERROR } from "../../../lib/skills/create";
import type { AgentRequest } from "../../../lib/types";

function readText(relativePath: string) {
  try {
    return readFileSync(path.join(process.cwd(), relativePath), "utf8");
  } catch {
    return "";
  }
}

export async function POST(request: Request) {
  let body: AgentRequest;
  try {
    body = (await request.json()) as AgentRequest;
  } catch {
    return Response.json({ error: "Send a sentence to start." }, { status: 400 });
  }

  if (!body || typeof body.message !== "string") {
    return Response.json({ error: "Send a sentence to start." }, { status: 400 });
  }

  let parsed: unknown = [];
  try {
    parsed = JSON.parse(readText("data/activities.json") || "[]");
  } catch {
    parsed = [];
  }

  try {
    const result = await runAgent(
      {
        ...body,
        baby: {
          name: body.baby?.name ?? "",
          parentName: body.baby?.parentName ?? "",
          dateOfBirth: body.baby?.dateOfBirth ?? "",
          ageMonths: Number(body.baby?.ageMonths) || 0,
          materials: body.baby?.materials ?? "",
          minutesAvailable: Number(body.baby?.minutesAvailable) || 20,
          completedActivityIds: Array.isArray(body.baby?.completedActivityIds) ? body.baby.completedActivityIds : [],
        },
      },
      {
        activities: normalizeActivities(parsed),
        exampleMarkdown: readText("data/emotional-development-example.md"),
        safetyMarkdown: readText("skills/_safety.md"),
        seedMarkdown: readText("skills/montessori-activity-finder.md"),
      },
    );
    return Response.json(result);
  } catch (error) {
    console.error("[api/agent]", error);
    const message = error instanceof DraftError ? DRAFT_FAILED_ERROR : AGENT_UNAVAILABLE_ERROR;
    return Response.json({ error: message }, { status: 502 });
  }
}
