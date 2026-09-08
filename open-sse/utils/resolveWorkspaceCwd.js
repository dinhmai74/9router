import fs from "node:fs";
import path from "node:path";

const EXPLICIT_BODY_CWD_KEYS = ["cwd", "working_directory", "workdir", "workspace"];
const EXPLICIT_HEADER_CWD_KEYS = [
  "x-cwd",
  "x-workdir",
  "x-workspace-root",
  "x-working-directory",
];

function pushCandidate(candidates, value) {
  if (typeof value === "string" && value.trim()) candidates.push(value.trim());
}

function resolveExplicitHeaderCwd(headers) {
  if (!headers || typeof headers !== "object") return undefined;
  for (const key of EXPLICIT_HEADER_CWD_KEYS) {
    const value = headers[key] ?? headers[key.toUpperCase()];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed && path.isAbsolute(trimmed)) return trimmed;
  }
  return undefined;
}

function resolveExplicitBodyCwd(body) {
  for (const key of EXPLICIT_BODY_CWD_KEYS) {
    for (const value of [body?.[key], body?.metadata?.[key]]) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed && path.isAbsolute(trimmed)) return trimmed;
    }
  }
  return undefined;
}

function scanSystemField(system, scanText) {
  if (!system) return;
  if (typeof system === "string") {
    scanText(system);
    return;
  }
  if (!Array.isArray(system)) return;
  for (const block of system) {
    if (typeof block === "string") scanText(block);
    else scanText(block?.text);
  }
}

function scanMessages(messages, scanText) {
  if (!Array.isArray(messages)) return;
  for (const message of messages) {
    if (!message) continue;
    if (typeof message.content === "string") scanText(message.content);
    else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part === "string") scanText(part);
        else if (part && typeof part === "object") {
          scanText(part.text);
          scanText(part.input_text);
          scanText(part.content);
        }
      }
    }
    if (typeof message === "string") scanText(message);
    if (message.type === "message" && Array.isArray(message.content)) {
      for (const part of message.content) scanText(part?.text || part?.input_text);
    }
  }
}

function scanWorkspaceText(body, scanText) {
  scanSystemField(body?.system, scanText);
  scanMessages(body?.messages, scanText);
  scanMessages(body?.input, scanText);
}

function collectWorkspaceCwdCandidates(body) {
  const candidates = [];
  const push = (value) => pushCandidate(candidates, value);
  for (const key of EXPLICIT_BODY_CWD_KEYS) {
    push(body?.[key]);
    push(body?.metadata?.[key]);
  }

  scanWorkspaceText(body, (text) => {
    if (typeof text !== "string" || !text) return;
    for (const match of text.matchAll(/<cwd>\s*([^<]+?)\s*<\/cwd>/gi)) push(match[1]);
    for (const match of text.matchAll(/Current working directory:\s*(.+?)(?:\r?\n|$)/gi)) push(match[1]);
  });

  return candidates;
}

function resolveLastPromptCwd(body) {
  let lastCwdLine;
  let lastCwdTag;

  scanWorkspaceText(body, (text) => {
    if (typeof text !== "string" || !text) return;
    for (const match of text.matchAll(/<cwd>\s*([^<]+?)\s*<\/cwd>/gi)) {
      const trimmed = match[1]?.trim();
      if (trimmed && path.isAbsolute(trimmed)) lastCwdTag = trimmed;
    }
    for (const match of text.matchAll(/Current working directory:\s*(.+?)(?:\r?\n|$)/gi)) {
      const trimmed = match[1]?.trim();
      if (trimmed && path.isAbsolute(trimmed)) lastCwdLine = trimmed;
    }
  });

  return lastCwdLine || lastCwdTag;
}

/** Resolve an absolute existing directory from client request metadata or prompt context. */
export function resolveWorkspaceCwd(body) {
  for (const candidate of collectWorkspaceCwdCandidates(body)) {
    try {
      if (path.isAbsolute(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/** Resolve client workspace for proxy hosts. Never falls back to process.cwd(). */
export function resolveClientWorkspaceCwd(body, headers) {
  const fromHeaders = resolveExplicitHeaderCwd(headers);
  if (fromHeaders) return fromHeaders;

  const explicit = resolveExplicitBodyCwd(body);
  if (explicit) return explicit;

  const promptCwd = resolveLastPromptCwd(body);
  if (promptCwd) return promptCwd;

  return resolveWorkspaceCwd(body);
}
