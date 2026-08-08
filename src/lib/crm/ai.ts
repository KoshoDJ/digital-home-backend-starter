import Anthropic from "@anthropic-ai/sdk";
import type { AdminClient } from "./types";

/**
 * The copywriter model. Claude writes ALL email and marketing copy —
 * sequences, rewrites, batches, single-email briefs. Copy quality is the
 * moat; don't migrate this to save pennies.
 */
const DEFAULT_CRM_MODEL = "claude-sonnet-4-6";
export const CRM_AI_MODEL = process.env.CRM_AI_MODEL || DEFAULT_CRM_MODEL;

function crmModel(): string {
  return process.env.CRM_AI_MODEL || DEFAULT_CRM_MODEL;
}

/** Loads the brand brain (brand_context rows) as one prompt-ready block. */
export async function loadBrandContext(supabase: AdminClient): Promise<string> {
  const { data } = await supabase.from("brand_context").select("key, category, content");
  if (!data?.length) return "(no brand context found — write in a clear, warm, direct voice)";
  const MAX_PER_SECTION = 6000;
  return data
    .map((r) => `### ${r.category}: ${r.key}\n${r.content.slice(0, MAX_PER_SECTION)}`)
    .join("\n\n");
}

/** Loads active offers so sequences can point at real destinations. */
export async function loadOffers(supabase: AdminClient): Promise<string> {
  const { data } = await supabase
    .from("offers")
    .select("slug, name, tagline, description, price_display, benefits, cta_text, cta_url, who_its_for")
    .eq("status", "active")
    .order("position_in_ladder", { ascending: true, nullsFirst: false });
  if (!data?.length) return "(no offers configured yet — use your website's contact page as the CTA destination)";
  return data
    .map(
      (o) =>
        `- ${o.name} (${o.slug})${o.price_display ? ` — ${o.price_display}` : ""}\n` +
        `  For: ${o.who_its_for || "n/a"}\n` +
        `  ${o.tagline || o.description || ""}\n` +
        `  Benefits: ${(o.benefits || []).join("; ")}\n` +
        `  CTA: ${o.cta_url || "(no URL set — use the website contact page)"}`
    )
    .join("\n");
}

/** Extracts a JSON object from a model response (handles code fences, prose). */
export function extractJson<T>(text: string): T {
  let candidate = text.trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidate = fenced[1].trim();
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error("No JSON object found in AI response");
  candidate = candidate.slice(first, last + 1);
  try {
    return JSON.parse(candidate) as T;
  } catch {
    // Common repair: raw newlines / control chars inside string values
    const repaired = candidate
      .replace(/\r/g, "")
      .replace(/"(?:[^"\\]|\\[^\n])*"/g, (m) => m.replace(/\n/g, "\\n").replace(/\t/g, "\\t"))
      .replace(/[\u0000-\u0008\u000B-\u001F]/g, "");
    return JSON.parse(repaired) as T;
  }
}

/**
 * Repair broken JSON caused by unescaped double quotes inside string values
 * (e.g. quoted dialogue the model writes into email/article copy). In valid
 * JSON a closing " is always followed by : , } ] or whitespace before one of
 * those; a " followed by anything else is an interior quote — escape it.
 * No-op on already-valid JSON. Callers should replace control characters
 * with spaces first so formatting newlines don't confuse the look-ahead.
 * (Long-proven in the write-article pipeline; shared here for sequences.)
 */
export function repairJsonQuotes(text: string): string {
  const result: string[] = [];
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (escapeNext) {
      result.push(char);
      escapeNext = false;
      continue;
    }

    if (char === "\\") {
      result.push(char);
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      if (!inString) {
        inString = true;
        result.push(char);
      } else {
        let j = i + 1;
        while (j < text.length && text[j] === " ") j++;
        const next = text[j];

        if (next === ":" || next === "," || next === "}" || next === "]" || next === undefined) {
          inString = false;
          result.push(char);
        } else {
          result.push("\\");
          result.push(char);
        }
      }
      continue;
    }

    result.push(char);
  }

  return result.join("");
}

export async function callModel(system: string, user: string, maxTokens = 8192): Promise<{ text: string; tokens: number }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
  const anthropic = new Anthropic();
  const message = await anthropic.messages.create({
    model: crmModel(),
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  const text = message.content[0]?.type === "text" ? message.content[0].text : "";
  const tokens = (message.usage?.input_tokens || 0) + (message.usage?.output_tokens || 0);
  return { text, tokens };
}

/**
 * Structured generation via forced tool call — the API constrains the output
 * to the given JSON schema, so long email copy can't break parsing (unescaped
 * quotes/newlines were breaking plain-text JSON output).
 */
export async function callModelStructured<T>(
  system: string,
  user: string,
  schema: Record<string, unknown>,
  maxTokens = 8192
): Promise<{ result: T; tokens: number }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
  const anthropic = new Anthropic();
  // Stream + finalMessage: large maxTokens (long sequences) trips the SDK's
  // non-streaming 10-minute guard, and streaming avoids HTTP idle timeouts.
  const stream = anthropic.messages.stream({
    model: crmModel(),
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
    tools: [
      {
        name: "deliver_result",
        description: "Deliver the finished result in the required structure.",
        input_schema: schema as Anthropic.Tool["input_schema"],
      },
    ],
    tool_choice: { type: "tool", name: "deliver_result" },
  });
  const message = await stream.finalMessage();
  const block = message.content.find((c) => c.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("AI did not return a structured result");
  }
  if (message.stop_reason === "max_tokens") {
    // Truncated mid-tool-call: the input JSON is incomplete (this is what
    // produced "no usable emails" on long sequences). Fail loud so callers
    // raise maxTokens or ask for fewer/shorter items instead of limping on.
    throw new Error(
      `AI output hit the ${maxTokens}-token limit and was cut off — request fewer/shorter items or raise maxTokens`
    );
  }
  const tokens = (message.usage?.input_tokens || 0) + (message.usage?.output_tokens || 0);
  return { result: block.input as T, tokens };
}

export const SEQUENCE_SCHEMA = {
  type: "object",
  required: ["name", "description", "goal", "emails"],
  properties: {
    name: { type: "string", description: "Short workflow name" },
    description: { type: "string", description: "One line: who this is for and where it leads" },
    goal: { type: "string", description: "The single conversion goal" },
    emails: {
      type: "array",
      description: "The emails, as a JSON array of objects — NEVER as a JSON-encoded string",
      items: {
        type: "object",
        required: ["position", "wait_before", "subject", "preheader", "body_md", "purpose"],
        properties: {
          position: { type: "integer" },
          wait_before: {
            type: "object",
            required: ["days"],
            properties: {
              days: { type: "integer", description: "Days after the previous email (first email: 0)" },
              hours: { type: "integer" },
            },
          },
          subject: { type: "string" },
          preheader: { type: "string" },
          body_md: { type: "string", description: "Markdown body with merge tags like {{first_name|there}}" },
          purpose: { type: "string", description: "What this email accomplishes in the arc" },
        },
      },
    },
  },
} as const;

export const REWRITE_SCHEMA = {
  type: "object",
  required: ["subject", "preheader", "body_md"],
  properties: {
    subject: { type: "string" },
    preheader: { type: "string" },
    body_md: { type: "string" },
  },
} as const;

export const SEQUENCE_CRAFT_RULES = `
## Email craft rules (non-negotiable)
- Write like a real person emailing someone they respect. No corporate voice, no "marketing speak".
- Every email earns its place: teach something, shift a belief, or remove an objection. Value first; the offer is the natural next step, never the opener.
- ONE clear call to action per email. A CTA link goes on its own line as a markdown link so it renders as a button, e.g. [Book your call](https://...).
- Subject lines: under 50 characters, specific + curiosity, never clickbait. Sentence case.
- Preheader: complements (not repeats) the subject, under 90 characters.
- Open with the reader, not the sender. First line must hook — it shows in inbox preview.
- Short paragraphs (1-3 lines). Write for mobile. Use line breaks generously.
- Personalize with merge tags: {{first_name|there}} (always include the fallback), and reference where they came from when it fits.
- Sequence arc: (1) instant welcome — deliver the promise + set expectations, (2) story/belief-shift, (3) teach a quick win, (4) proof (case study/result), (5) direct offer with urgency that is honest, (6+) objection handling or a short "9-word" style nudge.
- Timing: first email immediately, then roughly 2, 3, 4 day gaps — widen as the sequence progresses. Adjust to the brief.
- Do NOT include an unsubscribe line or signature block — the system appends those automatically.
- Do NOT invent testimonials, numbers, or claims not present in the brand context or offers.
`;
