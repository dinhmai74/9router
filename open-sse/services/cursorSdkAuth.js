import { PROVIDER_OAUTH } from "../providers/index.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { FORMATS } from "../translator/formats.js";

const SDK_CONFIG = PROVIDER_OAUTH.cursor?.sdk || {};

export const CURSOR_SDK_PACKAGE = SDK_CONFIG.packageName || "@cursor/sdk";
export const CURSOR_SDK_MIN_NODE = SDK_CONFIG.minNodeVersion || "22.13.0";
export const CURSOR_SDK_API_KEY_ENV = SDK_CONFIG.apiKeyEnvVar || "CURSOR_API_KEY";

export const CURSOR_SDK_AUTH_ERROR_CODE = "cursor_sdk_api_key_required";
export const CURSOR_SDK_NODE_ERROR_CODE = "cursor_sdk_node_version_unsupported";

export const CURSOR_SDK_STREAM_EVENT_TYPES = [
  "system",
  "user",
  "assistant",
  "thinking",
  "tool_call",
  "status",
  "task",
  "request",
  "usage",
];

export const CURSOR_SDK_EXPORTS = {
  Agent: ["create", "prompt", "resume"],
  Cursor: ["models.list", "auth.login"],
  Run: ["stream", "wait", "cancel", "conversation"],
};

function parseNodeVersion(version) {
  const [major = 0, minor = 0, patch = 0] = String(version || "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  return { major, minor, patch };
}

function isNodeVersionAtLeast(current, minimum) {
  const left = parseNodeVersion(current);
  const right = parseNodeVersion(minimum);
  if (left.major !== right.major) return left.major > right.major;
  if (left.minor !== right.minor) return left.minor > right.minor;
  return left.patch >= right.patch;
}

function hasIdeOAuthOnly(credentials) {
  const accessToken = credentials?.accessToken?.trim();
  const machineId = credentials?.providerSpecificData?.machineId?.trim();
  return Boolean(accessToken && machineId);
}

export function resolveCursorSdkApiKey(credentials) {
  const fromConnection = credentials?.apiKey?.trim();
  if (fromConnection) return fromConnection;

  const fromProviderData = credentials?.providerSpecificData?.sdkApiKey?.trim();
  if (fromProviderData) return fromProviderData;

  const fromEnv = process.env[CURSOR_SDK_API_KEY_ENV]?.trim();
  if (fromEnv) return fromEnv;

  return null;
}

export function validateCursorSdkAuth(credentials) {
  if (!isNodeVersionAtLeast(process.versions.node, CURSOR_SDK_MIN_NODE)) {
    return {
      code: CURSOR_SDK_NODE_ERROR_CODE,
      message: `Cursor SDK requires Node.js ${CURSOR_SDK_MIN_NODE} or later (current: ${process.versions.node}).`,
    };
  }

  const apiKey = resolveCursorSdkApiKey(credentials);
  if (apiKey) return null;

  if (hasIdeOAuthOnly(credentials)) {
    return {
      code: CURSOR_SDK_AUTH_ERROR_CODE,
      message: "Cursor SDK requires a Cursor API key (connection apiKey, providerSpecificData.sdkApiKey, or CURSOR_API_KEY). IDE OAuth access tokens and machine IDs cannot authenticate @cursor/sdk.",
    };
  }

  return {
    code: CURSOR_SDK_AUTH_ERROR_CODE,
    message: `Cursor SDK requires a Cursor API key. Set ${CURSOR_SDK_API_KEY_ENV} or add an apiKey to the Cursor connection.`,
  };
}

export function buildCursorSdkAuthFailureResponse({ credentials, body, url = "" }) {
  const failure = validateCursorSdkAuth(credentials);
  if (!failure) return null;

  return {
    response: new Response(JSON.stringify({
      error: {
        message: failure.message,
        type: "invalid_request_error",
        code: failure.code,
      },
    }), {
      status: HTTP_STATUS.BAD_REQUEST,
      headers: { "Content-Type": "application/json" },
    }),
    url,
    headers: {},
    transformedBody: body,
    responseFormat: FORMATS.OPENAI,
  };
}
