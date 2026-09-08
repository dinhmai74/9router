import { PROVIDER_OAUTH } from "../providers/index.js";
import {
  resolveCursorSdkApiKey,
  validateCursorSdkAuth,
} from "./cursorSdkAuth.js";
import { resolveClientWorkspaceCwd } from "../utils/resolveWorkspaceCwd.js";

const SDK_CONFIG = PROVIDER_OAUTH.cursor?.sdk || {};
const AUTO_MODEL_ID = "auto";

function isCloudDeployEnv() {
  if (typeof caches !== "undefined" && typeof caches === "object") return true;
  if (typeof EdgeRuntime !== "undefined") return true;
  return false;
}

function resolveDefaultSdkRuntime() {
  const configured = process.env.CURSOR_SDK_RUNTIME?.trim();
  if (configured === "local" || configured === "cloud") return configured;
  if (isCloudDeployEnv()) return SDK_CONFIG.defaultRuntime || "cloud";
  return "local";
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function extractSystemPrompt(messages) {
  return (messages || [])
    .filter((message) => message?.role === "system")
    .map((message) => textFromContent(message.content))
    .filter(Boolean)
    .join("\n\n");
}

export function formatWorkspacePromptContext(cwd) {
  const normalized = String(cwd || "").replace(/\\/g, "/").trim();
  if (!normalized) return "";
  return [
    "Authoritative workspace (use for all file paths and repo operations):",
    `Current working directory: ${normalized}`,
    "Do not infer workspace from conversation history, proxy host, or other repos mentioned in prior turns.",
  ].join("\n");
}

function resolveSdkLocalCwd({ body, credentials }) {
  const configured = credentials?.providerSpecificData?.sdkCwd?.trim();
  if (configured) return configured;

  const headers = credentials?.rawHeaders;
  const clientBody = credentials?.clientBody;
  if (clientBody) {
    const fromClient = resolveClientWorkspaceCwd(clientBody, headers);
    if (fromClient) return fromClient;
  }

  return resolveClientWorkspaceCwd(body, headers);
}

export function validateSdkLocalRuntime({ body, messages, credentials }) {
  const runtime = credentials?.providerSpecificData?.sdkRuntime || resolveDefaultSdkRuntime();
  if (runtime !== "local") return null;
  if (resolveSdkLocalCwd({ body: body || { messages }, credentials })) return null;
  return "Could not resolve client workspace directory for local Cursor SDK runtime. Include cwd in the request, set providerSpecificData.sdkCwd, or send an x-cwd header.";
}

export function buildSdkSystemPrompt({ messages, body, credentials }) {
  const base = extractSystemPrompt(messages);
  const workspaceContext = formatWorkspacePromptContext(
    resolveSdkLocalCwd({ body: body || { messages }, credentials }),
  );
  if (!workspaceContext) return base;
  if (!base) return workspaceContext;
  return `${workspaceContext}\n\n${base}`;
}

export function buildSdkPrompt(messages, { body, credentials } = {}) {
  const workspaceContext = formatWorkspacePromptContext(
    resolveSdkLocalCwd({ body: body || { messages }, credentials }),
  );
  const system = extractSystemPrompt(messages);
  const chatMessages = (messages || []).filter((message) => message?.role !== "system");
  const lastUserIndex = chatMessages.map((message) => message?.role).lastIndexOf("user");
  const current = lastUserIndex >= 0 ? chatMessages[lastUserIndex] : chatMessages.at(-1);
  const history = lastUserIndex >= 0
    ? chatMessages.slice(0, lastUserIndex)
    : chatMessages.slice(0, -1);
  const userText = textFromContent(current?.content) || "Continue.";

  const parts = [];
  if (workspaceContext) parts.push(workspaceContext);
  if (system) parts.push(`System instructions:\n${system}`);
  if (history.length) {
    const transcript = history
      .map((message) => {
        const text = textFromContent(message?.content);
        if (!text || (message.role !== "user" && message.role !== "assistant")) return "";
        return `${message.role}: ${text}`;
      })
      .filter(Boolean)
      .join("\n\n");
    if (transcript) parts.push(`Conversation history:\n${transcript}`);
  }
  parts.push(`User:\n${userText}`);
  return parts.join("\n\n");
}

const FAST_SUFFIX = "-fast";

/** Base ids where bare route id means slow (fast=false) and `-fast` suffix means fast. */
const FAST_SLOW_MODEL_BASE_IDS = new Set([
  "composer-2.5",
  "composer-2",
  "grok-4.6",
]);

/** Default effort param paired with fast toggles (from SDK default variants). */
const DEFAULT_EFFORT_BY_BASE_ID = {
  "grok-4.6": "high",
};

function buildFastSlowParams(baseId, fast) {
  const params = [{ id: "fast", value: fast ? "true" : "false" }];
  const effort = DEFAULT_EFFORT_BY_BASE_ID[baseId];
  if (effort) params.unshift({ id: "effort", value: effort });
  return params;
}

export function resolveSdkModelSelection(model) {
  const modelId = String(model || "").split("/").pop().trim();
  if (!modelId || modelId === "default") return { id: AUTO_MODEL_ID };

  if (modelId.endsWith(FAST_SUFFIX)) {
    const baseId = modelId.slice(0, -FAST_SUFFIX.length);
    if (FAST_SLOW_MODEL_BASE_IDS.has(baseId)) {
      return { id: baseId, params: buildFastSlowParams(baseId, true) };
    }
  }

  if (FAST_SLOW_MODEL_BASE_IDS.has(modelId)) {
    return { id: modelId, params: buildFastSlowParams(modelId, false) };
  }

  return { id: modelId };
}

export function mapSdkModelId(model) {
  return resolveSdkModelSelection(model).id;
}

function resolveAgentCreateOptions({ apiKey, model, messages, body, credentials }) {
  const runtime = credentials?.providerSpecificData?.sdkRuntime || resolveDefaultSdkRuntime();
  const options = {
    apiKey,
    model: resolveSdkModelSelection(model),
  };

  if (runtime === "local") {
    const cwd = resolveSdkLocalCwd({ body: body || { messages }, credentials });
    if (!cwd) {
      return { error: validateSdkLocalRuntime({ body, messages, credentials }) };
    }
    options.local = { cwd };
    return options;
  }

  options.cloud = { repos: [] };
  return options;
}

export function normalizeSdkStreamEvent(event) {
  if (!event?.type) return null;

  if (event.type === "assistant") {
    const blocks = event.message?.content || [];
    const text = blocks
      .filter((block) => block?.type === "text" && block.text)
      .map((block) => block.text)
      .join("");
    if (!text) return null;
    return { type: "text", value: text };
  }

  if (event.type === "thinking" && event.text) {
    return { type: "thinking", value: event.text };
  }

  if (event.type === "tool_call") {
    return null;
  }

  if (event.type === "status" && event.status === "ERROR") {
    return {
      type: "error",
      value: event.message || "Cursor SDK run failed",
    };
  }

  return null;
}

async function loadCursorSdk() {
  const sdk = await import("@cursor/sdk");
  return sdk.Agent;
}

export async function consumeCursorSdkAgentEvents({
  model,
  messages,
  body,
  credentials,
  signal,
  onEvent,
}) {
  const authFailure = validateCursorSdkAuth(credentials);
  if (authFailure) {
    onEvent({ type: "error", value: authFailure.message });
    return;
  }

  if (typeof onEvent !== "function") {
    throw new TypeError("onEvent is required");
  }

  let agent;
  let run;
  let abortHandler;
  let failed = false;

  const emitError = (message) => {
    if (failed) return;
    failed = true;
    onEvent({ type: "error", value: message });
  };

  try {
    if (signal?.aborted) {
      emitError("Request aborted");
      return;
    }

    const Agent = await loadCursorSdk();
    const apiKey = resolveCursorSdkApiKey(credentials);
    const createOptions = resolveAgentCreateOptions({
      apiKey,
      model,
      messages,
      body,
      credentials,
    });
    if (createOptions.error) {
      emitError(createOptions.error);
      return;
    }
    const prompt = buildSdkPrompt(messages, { body, credentials });

    agent = await Agent.create(createOptions);
    run = await agent.send(prompt);

    abortHandler = () => {
      run?.cancel?.().catch(() => {});
    };
    signal?.addEventListener?.("abort", abortHandler, { once: true });

    for await (const event of run.stream()) {
      if (signal?.aborted) {
        await run.cancel().catch(() => {});
        emitError("Request aborted");
        break;
      }

      const normalized = normalizeSdkStreamEvent(event);
      if (!normalized) continue;
      if (normalized.type === "error") {
        onEvent(normalized);
        failed = true;
        break;
      }
      onEvent(normalized);
    }

    if (!failed) {
      const result = await run.wait();
      if (result.status === "error") {
        emitError(result.error?.message || "Cursor SDK run failed");
      } else if (result.status === "cancelled") {
        emitError("Cursor SDK run cancelled");
      }
    }
  } catch (error) {
    emitError(error?.message || "Cursor SDK request failed");
  } finally {
    if (abortHandler && signal?.removeEventListener) {
      signal.removeEventListener("abort", abortHandler);
    }
    try {
      agent?.close?.();
    } catch {}
    if (!failed) {
      onEvent({ type: "done" });
    }
  }
}
