/**
 * Cursor live model catalog fetcher.
 *
 * SDK API keys use `Cursor.models.list()`. IDE OAuth uses AgentService
 * `GetUsableModels` on agent.api5.cursor.sh. Both return account-specific
 * catalogs; callers fall back to the static registry when live fetch fails.
 */

import crypto from "crypto";
import http2 from "http2";
import { PROVIDER_OAUTH } from "../providers/index.js";
import { resolveCursorSdkApiKey } from "./cursorSdkAuth.js";
import { buildCursorHeaders } from "../utils/cursorChecksum.js";
import { decodeMessage } from "../utils/cursorProtobuf.js";

const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60 * 1000;

// agent.v1.ModelDetails protobuf field numbers.
const MODEL_ID_FIELD = 1;
const DISPLAY_MODEL_ID_FIELD = 3;
const DISPLAY_NAME_FIELD = 4;
const DISPLAY_NAME_SHORT_FIELD = 5;
const RESPONSE_MODELS_FIELD = 1;

/** @type {Map<string, { expiresAt: number, models: { id: string, name: string }[] }>} */
const catalogCache = new Map();

function getCursorModelsUrl() {
  const config = PROVIDER_OAUTH.cursor;
  if (!config?.agentEndpoint || !config?.modelsEndpoint) return null;
  return `${config.agentEndpoint.replace(/\/$/, "")}${config.modelsEndpoint}`;
}

function cacheKey(credentials) {
  const apiKey = resolveCursorSdkApiKey(credentials);
  const seed = [
    apiKey ? `sdk:${apiKey}` : null,
    credentials?.providerSpecificData?.machineId,
    credentials?.accessToken,
  ].filter(Boolean).join(":");
  if (!seed) return "cursor-anonymous";
  return crypto.createHash("sha256").update(`cursor:${seed}`).digest("hex");
}

function modelHasFastParameter(model) {
  return (model?.parameters || []).some((param) => param?.id === "fast");
}

export function normalizeCursorCatalogModels(models) {
  if (!Array.isArray(models)) return [];
  const seen = new Set();
  const normalized = [];

  const pushModel = (id, name) => {
    const trimmedId = typeof id === "string" ? id.trim() : "";
    if (!trimmedId || seen.has(trimmedId)) return;
    seen.add(trimmedId);
    const trimmedName = (typeof name === "string" ? name : trimmedId).trim();
    normalized.push({ id: trimmedId, name: trimmedName || trimmedId });
  };

  for (const model of models) {
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    if (!id) continue;

    const baseName = (
      (typeof model?.name === "string" && model.name)
      || (typeof model?.displayName === "string" && model.displayName)
      || id
    ).trim();

    if (modelHasFastParameter(model)) {
      pushModel(id, `${baseName} (Slow)`);
      pushModel(`${id}-fast`, `${baseName} Fast`);
      continue;
    }

    pushModel(id, baseName);
  }

  return normalized;
}

function extractCursorSdkModelItems(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.items)) return response.items;
  return [];
}

function firstString(fields, fieldNumber) {
  const value = fields.get(fieldNumber)?.[0]?.value;
  if (!value || typeof value === "number") return "";
  return Buffer.from(value).toString("utf8");
}

/**
 * Decode Cursor's `agent.v1.GetUsableModelsResponse` protobuf payload.
 * The response contains repeated `agent.v1.ModelDetails` messages in field 1.
 */
export function parseCursorUsableModels(payload) {
  const response = decodeMessage(payload);
  const seen = new Set();
  const models = [];

  for (const entry of response.get(RESPONSE_MODELS_FIELD) || []) {
    if (!entry?.value || typeof entry.value === "number") continue;
    const detail = decodeMessage(entry.value);
    const id = firstString(detail, MODEL_ID_FIELD).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const name = (
      firstString(detail, DISPLAY_NAME_FIELD)
      || firstString(detail, DISPLAY_NAME_SHORT_FIELD)
      || firstString(detail, DISPLAY_MODEL_ID_FIELD)
      || id
    ).trim();
    models.push({ id, name });
  }

  return models;
}

/**
 * agent.api5.cursor.sh is HTTP/2-only; Node fetch/undici cannot speak h2.
 * Unary GetUsableModels uses an unframed protobuf body (application/proto).
 */
function http2PostProto(url, headers, body, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = http2.connect(`https://${urlObj.host}`);
    const chunks = [];
    let responseHeaders = {};
    let settled = false;

    const finish = (fn) => (...args) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      try { client.close(); } catch {}
      fn(...args);
    };

    const timeoutId = setTimeout(finish(() => {
      reject(new Error("Cursor GetUsableModels timed out"));
    }), timeoutMs);

    client.on("error", finish(reject));

    const req = client.request({
      ":method": "POST",
      ":path": urlObj.pathname,
      ":authority": urlObj.host,
      ":scheme": "https",
      ...headers,
    });

    req.on("response", (hdrs) => { responseHeaders = hdrs; });
    req.on("data", (chunk) => { chunks.push(chunk); });
    req.on("end", finish(() => {
      resolve({
        status: Number(responseHeaders[":status"] || 0),
        body: Buffer.concat(chunks),
      });
    }));
    req.on("error", finish(reject));

    if (signal) {
      const onAbort = finish(() => reject(new Error("Request aborted")));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    req.end(body && body.length ? Buffer.from(body) : undefined);
  });
}

async function fetchCursorCatalog(credentials, signal) {
  const accessToken = credentials?.accessToken;
  const machineId = credentials?.providerSpecificData?.machineId;
  const url = getCursorModelsUrl();
  if (!accessToken || !machineId || !url) return null;

  const headers = {
    ...buildCursorHeaders(accessToken, machineId, credentials?.providerSpecificData?.ghostMode !== false),
    // Connect unary calls use an unframed protobuf body, unlike Cursor chat's
    // streaming `application/connect+proto` endpoint.
    accept: "application/proto",
    "content-type": "application/proto",
  };
  delete headers["connect-accept-encoding"];
  delete headers["connect-protocol-version"];

  const response = await http2PostProto(url, headers, new Uint8Array(), signal, FETCH_TIMEOUT_MS);
  if (response.status !== 200) {
    const error = new Error(`Cursor GetUsableModels returned ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return parseCursorUsableModels(new Uint8Array(response.body));
}

async function fetchCursorSdkCatalog(credentials) {
  const apiKey = resolveCursorSdkApiKey(credentials);
  if (!apiKey) return null;

  const { Cursor } = await import("@cursor/sdk");
  const response = await Cursor.models.list({ apiKey });
  return normalizeCursorCatalogModels(extractCursorSdkModelItems(response));
}

async function fetchLiveCursorCatalog(credentials, signal, log) {
  const apiKey = resolveCursorSdkApiKey(credentials);
  if (apiKey) {
    try {
      const models = await fetchCursorSdkCatalog(credentials);
      if (models?.length) return models;
    } catch (error) {
      log?.warn?.("CURSOR_MODELS", `Cursor SDK model list failed: ${error?.message || error}`);
    }
  }

  const accessToken = credentials?.accessToken;
  const machineId = credentials?.providerSpecificData?.machineId;
  if (!accessToken || !machineId) return null;

  return fetchCursorCatalog(credentials, signal);
}

/**
 * Resolve the live Cursor catalog for the authenticated account.
 * Returns null on any failure so callers can fall back to static models.
 */
export async function resolveCursorModels(credentials, options = {}) {
  const apiKey = resolveCursorSdkApiKey(credentials);
  const hasIdeOAuth = Boolean(
    credentials?.accessToken?.trim()
    && credentials?.providerSpecificData?.machineId?.trim(),
  );
  if (!apiKey && !hasIdeOAuth) {
    options.log?.debug?.("CURSOR_MODELS", "No Cursor SDK API key or IDE OAuth credentials; skipping live fetch");
    return null;
  }

  const key = cacheKey(credentials);
  const now = Date.now();
  if (!options.forceRefresh) {
    const cached = catalogCache.get(key);
    if (cached?.expiresAt > now) return { models: cached.models };
  }

  try {
    const models = await fetchLiveCursorCatalog(credentials, options.signal, options.log);
    if (!models?.length) return null;
    catalogCache.set(key, { expiresAt: now + CACHE_TTL_MS, models });
    return { models };
  } catch (error) {
    options.log?.warn?.("CURSOR_MODELS", `Live model fetch failed: ${error?.message || error}`);
    return null;
  }
}

export function clearCursorModelCache() {
  catalogCache.clear();
}
