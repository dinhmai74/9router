// Coerce an OpenAI `content` payload into plain text.
//
// The OpenAI wire contract says `content` is a string, but some upstreams send
// Anthropic-style content blocks instead:
//   [{ type: "text", text: "..." }]   structured blocks
//   { text: "..." }                   bare part object
// Forwarding either unchanged makes a strict client append String(value) per
// chunk and render a wall of "[object Object]" instead of the answer.
//
// Returns null when the value carries no text, so callers can leave the field
// alone instead of replacing it with "".
export function contentToText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    let text = "";
    for (const part of value) {
      if (typeof part === "string") text += part;
      else if (typeof part?.text === "string") text += part.text;
    }
    return text;
  }
  if (value && typeof value === "object" && typeof value.text === "string") return value.text;
  return null;
}

// Rewrite non-string `content` / `reasoning_content` on an OpenAI-shaped body,
// covering both streaming (`choices[].delta`) and non-streaming
// (`choices[].message`) payloads. Returns true when something changed.
export function normalizeContentFields(payload) {
  if (!Array.isArray(payload?.choices)) return false;
  let changed = false;
  for (const choice of payload.choices) {
    for (const target of [choice?.delta, choice?.message]) {
      if (!target || typeof target !== "object") continue;
      for (const field of ["content", "reasoning_content"]) {
        const text = contentToText(target[field]);
        if (text === null || text === target[field]) continue;
        target[field] = text;
        changed = true;
      }
    }
  }
  return changed;
}
