import { describe, it, expect } from "vitest";
import os from "node:os";

import { CursorExecutor } from "../../open-sse/executors/cursor.js";
import {
  buildSdkPrompt,
  buildSdkSystemPrompt,
  formatWorkspacePromptContext,
  mapSdkModelId,
  normalizeSdkStreamEvent,
  resolveSdkModelSelection,
} from "../../open-sse/services/cursorAgentSdk.js";

const IDE_OAUTH_CREDENTIALS = {
  accessToken: "test-token",
  providerSpecificData: { machineId: "a".repeat(64) },
};

describe("CursorExecutor SDK agent path", () => {
  it("Should return cursor_sdk_api_key_required when only IDE OAuth credentials are present", async () => {
    const executor = new CursorExecutor();
    const result = await executor.executeAgent({
      model: "gpt-5.2",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: IDE_OAUTH_CREDENTIALS,
    });

    expect(result.url).toBe("cursor-sdk://agent");
    expect(result.response.status).toBe(400);
    const payload = await result.response.json();
    expect(payload.error.code).toBe("cursor_sdk_api_key_required");
    expect(payload.error.message).toContain("API key");
  });

  it("Should emit an SSE error frame instead of assistant text when SDK auth is missing", async () => {
    const executor = new CursorExecutor();
    const result = await executor.executeAgent({
      model: "gpt-5.2",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: IDE_OAUTH_CREDENTIALS,
    });

    const body = await result.response.text();
    expect(body).toContain("cursor_sdk_api_key_required");
    expect(body).toContain("invalid_request_error");
    expect(body).not.toMatch(/delta.*content.*API key/);
  });

  it("Should route tool-call conversations to ChatService when only IDE OAuth credentials are present", async () => {
    const executor = new CursorExecutor();
    const buildUrlSpy = executor.buildUrl.bind(executor);
    let capturedUrl = "";
    executor.buildUrl = () => {
      capturedUrl = buildUrlSpy();
      return capturedUrl;
    };

    executor.makeHttp2Request = async () => ({
      status: 200,
      headers: {},
      body: Buffer.alloc(0),
    });

    await executor.execute({
      model: "gpt-5.2",
      body: {
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "c1",
              type: "function",
              function: { name: "get_weather", arguments: "{}" },
            }],
          },
          { role: "tool", tool_call_id: "c1", content: "sunny" },
          { role: "user", content: "thanks" },
        ],
      },
      stream: true,
      credentials: IDE_OAUTH_CREDENTIALS,
    });

    expect(capturedUrl).toContain("ChatService");
    expect(capturedUrl).not.toContain("cursor-sdk://agent");
  });

  it("Should route tool-call conversations to the SDK agent path when an API key is present", async () => {
    const executor = new CursorExecutor();
    const buildUrlSpy = executor.buildUrl.bind(executor);
    let capturedUrl = "";
    executor.buildUrl = () => {
      capturedUrl = buildUrlSpy();
      return capturedUrl;
    };

    const result = await executor.execute({
      model: "gpt-5.2",
      body: {
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "c1",
              type: "function",
              function: { name: "get_weather", arguments: "{}" },
            }],
          },
          { role: "tool", tool_call_id: "c1", content: "sunny" },
          { role: "user", content: "thanks" },
        ],
      },
      stream: false,
      credentials: {
        apiKey: "cursor-test-api-key",
      },
    });

    expect(capturedUrl).toBe("");
    expect(result.url).toBe("cursor-sdk://agent");
  });

  it("Should route text turns with client tool schemas to the SDK agent path when an API key is present", async () => {
    const executor = new CursorExecutor();

    const result = await executor.execute({
      model: "cu/composer-2.5",
      body: {
        messages: [{ role: "user", content: "record what you observe" }],
        tools: [{
          type: "function",
          function: {
            name: "record_observations",
            description: "Persist observations",
            parameters: { type: "object", properties: {} },
          },
        }],
      },
      stream: false,
      credentials: {
        apiKey: "cursor-test-api-key",
      },
    });

    expect(result.url).toBe("cursor-sdk://agent");
  });
});

describe("Cursor SDK adapter (cursorAgentSdk.js)", () => {
  it("Should map default model id to auto", () => {
    expect(mapSdkModelId("cu/default")).toBe("auto");
    expect(mapSdkModelId("gpt-5.2")).toBe("gpt-5.2");
  });

  it("Should map slow and fast Cursor SDK route ids to model params", () => {
    expect(resolveSdkModelSelection("cu/composer-2.5")).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: "false" }],
    });
    expect(resolveSdkModelSelection("cu/composer-2.5-fast")).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: "true" }],
    });
    expect(resolveSdkModelSelection("cu/grok-4.6")).toEqual({
      id: "grok-4.6",
      params: [
        { id: "effort", value: "high" },
        { id: "fast", value: "false" },
      ],
    });
    expect(resolveSdkModelSelection("cu/grok-4.6-fast")).toEqual({
      id: "grok-4.6",
      params: [
        { id: "effort", value: "high" },
        { id: "fast", value: "true" },
      ],
    });
  });

  it("Should fold system and history into the SDK prompt", () => {
    const workspace = os.tmpdir();
    const prompt = buildSdkPrompt([
      { role: "system", content: "be brief" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "again" },
    ], {
      body: {
        cwd: workspace,
      },
    });
    expect(prompt).toContain("Authoritative workspace");
    expect(prompt).toContain(`Current working directory: ${workspace}`);
    expect(prompt).toContain("System instructions:\nbe brief");
    expect(prompt).toContain("Conversation history:");
    expect(prompt).toContain("User:\nagain");
  });

  it("Should prepend resolved pi workspace to the SDK system prompt", () => {
    const workspace = os.tmpdir();
    const systemPrompt = buildSdkSystemPrompt({
      messages: [{
        role: "system",
        content: `You are an assistant.\nCurrent working directory: ${workspace}\n`,
      }],
      body: {
        messages: [{
          role: "system",
          content: `You are an assistant.\nCurrent working directory: ${workspace}\n`,
        }],
      },
    });
    expect(systemPrompt.startsWith("Authoritative workspace")).toBe(true);
    expect(systemPrompt).toContain(`Current working directory: ${workspace}`);
    expect(systemPrompt).toContain("You are an assistant.");
  });

  it("Should format workspace prompt context with normalized slashes", () => {
    expect(formatWorkspacePromptContext("C:\\repo\\app")).toContain("Current working directory: C:/repo/app");
  });

  it("Should omit workspace prompt context when no client cwd is resolved", () => {
    const prompt = buildSdkPrompt([
      { role: "user", content: "hello" },
    ], {
      body: {
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(prompt).not.toContain("Authoritative workspace");
    expect(prompt).toContain("User:\nhello");
  });

  it("Should resolve client workspace from credentials.clientBody when translation strips system", () => {
    const workspace = os.tmpdir();
    const systemPrompt = buildSdkSystemPrompt({
      messages: [{ role: "user", content: "hi" }],
      body: {
        messages: [{ role: "user", content: "hi" }],
      },
      credentials: {
        clientBody: {
          system: [{ type: "text", text: `Current working directory: ${workspace}\n` }],
          messages: [
            { role: "system", content: `Current working directory: ${workspace}\n` },
            { role: "user", content: "hi" },
          ],
        },
      },
    });
    expect(systemPrompt).toContain(`Current working directory: ${workspace}`);
  });

  it("Should ignore tool_call stream events while the local SDK executes tools", () => {
    expect(normalizeSdkStreamEvent({ type: "tool_call", name: "shell", status: "started" })).toBeNull();
    expect(normalizeSdkStreamEvent({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "write", input: {} }] },
    })).toBeNull();
  });
});
