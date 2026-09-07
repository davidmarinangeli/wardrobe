// The judging step of the Mirror: a model reads the perceived facts and decides
// which of the catalogue's rules genuinely apply to THIS outfit.
//
// It is deliberately not allowed to write the critique. It returns rule ids and
// the indices of the garments it is citing as evidence; style-rules.mjs then
// re-derives whether that evidence actually holds and drops anything that
// doesn't. So the model contributes the one thing a rules engine was hopeless
// at — telling a deliberate look from an accident, and knowing which of nine
// possible observations is the one worth making about this particular photo —
// while never being in a position to invent a fact.
//
// It also never sees the wardrobe. Which garment to offer as a fix is decided
// afterwards, deterministically, so the critique and its remedy cannot drift
// apart the way they did when one free-form call did both.

import { NO_JUDGMENT_PROMPT } from "../shared/prompt-guardrails.mjs";
import { MIRROR_RULE_IDS, describeRuleCatalogue, rulesForRegister } from "../shared/style-catalogue.mjs";

const JUDGE_CONFIDENCE = ["low", "medium", "high"];

/** The perceived outfit as a numbered list the judge can cite by index. */
export function describeGarments(garments) {
  return garments
    .map((garment, index) => {
      const detail = [
        garment.material && garment.material !== "other" ? garment.material : null,
        `${garment.volume} fit`,
        `formality ${garment.formality}/5`,
        garment.patterned ? `${garment.patternScale || "medium"} pattern` : "solid",
        garment.hemNotes ? `hem ${garment.hemSeverity}: ${garment.hemNotes}` : null,
        garment.confidence !== "high" ? `read at ${garment.confidence} confidence` : null,
      ].filter(Boolean);
      return `#${index} ${garment.region} — ${garment.color} ${garment.description} (${detail.join(", ")})`;
    })
    .join("\n");
}

export function buildJudgePrompt(perception) {
  const { garments, register, photoQuality } = perception;
  return `A photo of someone's outfit has been read into the facts below. Your job is to decide which — if any — of a fixed list of styling observations genuinely apply to it.

THE OUTFIT (cite garments by their number):
${describeGarments(garments)}

Overall this outfit reads as: ${register}.
Photo quality: ${photoQuality}.

OBSERVATIONS YOU MAY MAKE. These are the only ones available to you, and they have already been narrowed to the ones that can apply to a ${register} outfit:
${describeRuleCatalogue(register)}

RULES OF THE JOB:
- Report every observation above that genuinely applies, up to 4. Do not stop at one because the outfit is broadly working — if three of these are separately true of it, report three. Equally, do not pad: reporting nothing is a valid and common answer, and an outfit with no real problem must get an empty list rather than the least-bad item from the list above.
- Only report an observation if the facts above actually demonstrate it. You have no access to the photo; you may not rely on anything not listed.
- For each one, cite the garment numbers that are the evidence for it. Cite the garments the observation is ABOUT, not every garment in the outfit.
- Set confidence honestly. Use "low" when the facts are suggestive rather than conclusive, or when the garments you are citing were read at low confidence. Low-confidence observations are filtered out downstream, which is the correct outcome — do not inflate confidence to get an observation through.
- Write each summary as one plain sentence naming the specific garments involved. No preamble, no fix — the fix is decided elsewhere.
- Write for the person in the photo, not about the data. The scales and field names above are internal scaffolding: never quote a formality number, a confidence level, a pattern scale, a region name or the id of an observation. Say "everything here is pitched at the same easy, casual level", never "every piece sits at formality 2/5".
- Separately, report 1 to 2 things that genuinely work about this outfit, each citing the garments involved. These are not consolation prizes: name something specific and true, and if the outfit is well put together say so plainly.
${photoQuality === "poor" ? "- This photo was hard to read. Be markedly more conservative: report an observation only if it is unmistakable from the facts.\n" : ""}
${NO_JUDGMENT_PROMPT}`;
}

const judgeSchema = (strict) => {
  const finding = {
    type: "object",
    ...(strict ? { additionalProperties: false } : {}),
    properties: {
      ruleId: { type: "string", enum: MIRROR_RULE_IDS },
      garmentIndices: { type: "array", items: { type: "integer" }, maxItems: 10 },
      confidence: { type: "string", enum: JUDGE_CONFIDENCE },
      summary: { type: "string" },
    },
    required: ["ruleId", "garmentIndices", "confidence", "summary"],
  };
  const work = {
    type: "object",
    ...(strict ? { additionalProperties: false } : {}),
    properties: {
      text: { type: "string" },
      garmentIndices: { type: "array", items: { type: "integer" }, maxItems: 10 },
    },
    required: ["text", "garmentIndices"],
  };
  return {
    type: "object",
    ...(strict ? { additionalProperties: false } : {}),
    properties: {
      findings: { type: "array", maxItems: 4, items: finding },
      works: { type: "array", maxItems: 2, items: work },
    },
    required: ["findings", "works"],
  };
};

// Anything the judge returned that isn't structurally sound is dropped here.
// The semantic gate — does the cited evidence actually hold? — lives in
// style-rules.mjs, because that is where the facts are interpreted.
export function normalizeJudgment(parsed, perception) {
  const allowed = new Set(rulesForRegister(perception.register).map((rule) => rule.id));
  const inRange = (index) => Number.isInteger(index) && index >= 0 && index < perception.garments.length;
  const findings = (Array.isArray(parsed?.findings) ? parsed.findings : [])
    .filter((finding) => allowed.has(finding?.ruleId))
    .map((finding) => ({
      ruleId: finding.ruleId,
      garmentIndices: [...new Set((finding.garmentIndices || []).filter(inRange))],
      confidence: JUDGE_CONFIDENCE.includes(finding.confidence) ? finding.confidence : "low",
      summary: String(finding.summary || "").trim(),
    }))
    .filter((finding) => finding.summary && finding.garmentIndices.length)
    .slice(0, 4);
  const works = (Array.isArray(parsed?.works) ? parsed.works : [])
    .map((work) => ({
      text: String(work?.text || "").trim(),
      garmentIndices: [...new Set((work?.garmentIndices || []).filter(inRange))],
    }))
    .filter((work) => work.text)
    .slice(0, 2);
  return { findings, works };
}

export async function geminiJudgeOutfit({ key, model, perception }) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: buildJudgePrompt(perception) }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: judgeSchema(false), temperature: 0.2 },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `Gemini judgment failed (${response.status})`);
  const outputText = result.candidates?.[0]?.content?.parts?.find((part) => typeof part.text === "string")?.text;
  if (!outputText) throw new Error("Gemini judgment returned no structured result");
  return normalizeJudgment(JSON.parse(outputText), perception);
}

export async function openAIJudgeOutfit({ key, baseUrl, model, perception }) {
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content: [{ type: "input_text", text: buildJudgePrompt(perception) }] }],
      text: { format: { type: "json_schema", name: "mirror_judgment", strict: true, schema: judgeSchema(true) } },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `OpenAI judgment failed (${response.status})`);
  const outputText = result.output_text || result.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  if (!outputText) throw new Error("OpenAI judgment returned no structured result");
  return normalizeJudgment(JSON.parse(outputText), perception);
}
