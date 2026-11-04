import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCursorModelCache,
  mergeCursorCatalogWithStatic,
  normalizeCursorCatalogModels,
  parseCursorUsableModels,
  resolveCursorModels,
} from "../../open-sse/services/cursorModels.js";

const CURSOR_SDK = "@cursor/sdk";

// GetUsableModels goes over node:http2 (agent.api5.cursor.sh is HTTP/2-only; fetch
// cannot speak h2, see 6994cd1f). These tests used to mock global.fetch, which the
// code never calls: the success case could not pass and the 403 case passed because
// a real connection failed. Fake the http2 client instead.
const h2 = vi.hoisted(() => ({ status: 200, body: new Uint8Array(), calls: [] }));
vi.mock("http2", async () => {
  const { EventEmitter } = await import("node:events");
  const connect = (origin) => {
    const client = new EventEmitter();
    client.close = () => {};
    client.request = (headers) => {
      const req = new EventEmitter();
      req.end = (body) => {
        h2.calls.push({ origin, headers, body });
        queueMicrotask(() => {
          req.emit("response", { ":status": h2.status });
          if (h2.body.length) req.emit("data", Buffer.from(h2.body));
          req.emit("end");
        });
      };
      return req;
    };
    return client;
  };
  return { default: { connect }, connect };
});

function varint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

function field(fieldNumber, value) {
  return Uint8Array.from([(fieldNumber << 3) | 2, ...varint(value.length), ...value]);
}

function text(value) {
  return new TextEncoder().encode(value);
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function model(id, name) {
  return field(1, concat(field(1, text(id)), field(4, text(name))));
}

describe("Cursor live model catalog", () => {
  beforeEach(() => {
    clearCursorModelCache();
    vi.resetModules();
    h2.calls.length = 0;
  });

  afterEach(() => {
    clearCursorModelCache();
    vi.doUnmock(CURSOR_SDK);
    vi.restoreAllMocks();
  });

  it("decodes the GetUsableModels protobuf response", () => {
    const payload = concat(
      model("default", "Auto"),
      model("gpt-5.3-codex", "GPT 5.3 Codex"),
      model("gpt-5.3-codex", "Duplicate"),
    );

    expect(parseCursorUsableModels(payload)).toEqual([
      { id: "default", name: "Auto" },
      { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    ]);
  });

  it("normalizes SDK model list entries", () => {
    expect(normalizeCursorCatalogModels([
      { id: "gpt-5.2", displayName: "GPT 5.2" },
      { id: "default", name: "Auto" },
      { displayName: "Missing id" },
    ])).toEqual([
      { id: "gpt-5.2", name: "GPT 5.2" },
      { id: "default", name: "Auto" },
    ]);
  });

  it("Should expose slow and fast picker entries for SDK models with a fast parameter", () => {
    expect(normalizeCursorCatalogModels([
      {
        id: "composer-2.5",
        displayName: "Composer 2.5",
        parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }],
      },
      {
        id: "grok-4.6",
        displayName: "Cursor Grok 4.6",
        parameters: [
          { id: "effort", values: [{ value: "high" }] },
          { id: "fast", values: [{ value: "false" }, { value: "true" }] },
        ],
      },
      {
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        parameters: [{ id: "reasoning", values: [{ value: "low" }] }],
      },
    ])).toEqual([
      { id: "composer-2.5", name: "Composer 2.5 (Slow)" },
      { id: "composer-2.5-fast", name: "Composer 2.5 Fast" },
      { id: "grok-4.6", name: "Cursor Grok 4.6 (Slow)" },
      { id: "grok-4.6-fast", name: "Cursor Grok 4.6 Fast" },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    ]);
  });

  it("Should accept SDK model lists returned as arrays", async () => {
    const list = vi.fn().mockResolvedValue([
      { id: "composer-2.5", displayName: "Composer 2.5" },
    ]);
    vi.doMock(CURSOR_SDK, () => ({
      Cursor: { models: { list } },
    }));

    const { resolveCursorModels: resolveWithSdk } = await import("../../open-sse/services/cursorModels.js");

    const result = await resolveWithSdk({
      apiKey: "cursor-sdk-key",
    });
    expect(result?.models).toEqual(expect.arrayContaining([
      { id: "composer-2.5", name: "Composer 2.5 (Slow)" },
      { id: "composer-2.5-fast", name: "Composer 2.5 Fast" },
    ]));
  });

  it("Should keep static composer-2.5-fast when live catalog only returns composer-2", async () => {
    const list = vi.fn().mockResolvedValue({
      items: [{
        id: "composer-2",
        displayName: "Composer 2",
        parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }],
      }],
    });
    vi.doMock(CURSOR_SDK, () => ({
      Cursor: { models: { list } },
    }));

    const { resolveCursorModels: resolveWithSdk } = await import("../../open-sse/services/cursorModels.js");
    const result = await resolveWithSdk({ apiKey: "cursor-sdk-key" });

    expect(result?.models).toEqual(expect.arrayContaining([
      { id: "composer-2", name: "Composer 2 (Slow)" },
      { id: "composer-2-fast", name: "Composer 2 Fast" },
      { id: "composer-2.5", name: "Composer 2.5 (Slow)" },
      { id: "composer-2.5-fast", name: "Composer 2.5 Fast" },
    ]));
  });

  it("Should merge static registry rows under a live-only catalog", () => {
    expect(mergeCursorCatalogWithStatic([
      { id: "composer-2", name: "Composer 2 (Slow)" },
      { id: "composer-2-fast", name: "Composer 2 Fast" },
    ])).toEqual(expect.arrayContaining([
      { id: "composer-2", name: "Composer 2 (Slow)" },
      { id: "composer-2-fast", name: "Composer 2 Fast" },
      { id: "composer-2.5", name: "Composer 2.5 (Slow)" },
      { id: "composer-2.5-fast", name: "Composer 2.5 Fast" },
    ]));
  });

  it("Should fetch models via Cursor SDK when only an API key is configured", async () => {
    const list = vi.fn().mockResolvedValue({
      items: [{ id: "gpt-5.2", displayName: "GPT 5.2" }],
    });
    vi.doMock(CURSOR_SDK, () => ({
      Cursor: { models: { list } },
    }));

    const { resolveCursorModels: resolveWithSdk } = await import("../../open-sse/services/cursorModels.js");

    const result = await resolveWithSdk({
      apiKey: "cursor-sdk-key",
    });
    expect(result?.models).toEqual(expect.arrayContaining([
      { id: "gpt-5.2", name: "GPT 5.2" },
      { id: "composer-2.5-fast", name: "Composer 2.5 Fast" },
    ]));
    expect(list).toHaveBeenCalledWith({ apiKey: "cursor-sdk-key" });
  });

  it("Should fail open when the Cursor SDK model list request fails", async () => {
    const list = vi.fn().mockRejectedValue(new Error("invalid api key"));
    vi.doMock(CURSOR_SDK, () => ({
      Cursor: { models: { list } },
    }));

    const { resolveCursorModels: resolveWithSdk } = await import("../../open-sse/services/cursorModels.js");

    await expect(resolveWithSdk({
      apiKey: "bad-key",
    })).resolves.toBeNull();
  });

  it("fetches the account-specific catalog and caches it", async () => {
    h2.status = 200;
    h2.body = concat(model("claude-4.6-opus", "Claude 4.6 Opus"));
    const credentials = {
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    };

    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });
    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });

    expect(h2.calls).toHaveLength(1);
    expect(h2.calls[0].origin).toBe("https://agent.api5.cursor.sh");
    expect(h2.calls[0].headers).toEqual(expect.objectContaining({
      ":method": "POST",
      ":path": "/agent.v1.AgentService/GetUsableModels",
      "content-type": "application/proto",
      accept: "application/proto",
    }));
  });

  it("fails open when the Cursor catalog request fails", async () => {
    h2.status = 403;
    h2.body = new TextEncoder().encode("no");

    await expect(resolveCursorModels({
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    })).resolves.toBeNull();
    expect(h2.calls).toHaveLength(1);
  });
});
