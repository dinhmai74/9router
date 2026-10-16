import { describe, it, expect, beforeEach, afterAll } from "vitest";
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
import { decodeMessage, encodeField, wrapConnectRPCFrame } from "../../open-sse/utils/cursorProtobuf.js";

const LEN = 2;

const SAVED_CURSOR_API_KEY = process.env.CURSOR_API_KEY;
beforeEach(() => {
  delete process.env.CURSOR_API_KEY;
});
afterAll(() => {
  if (SAVED_CURSOR_API_KEY !== undefined) {
    process.env.CURSOR_API_KEY = SAVED_CURSOR_API_KEY;
  } else {
    delete process.env.CURSOR_API_KEY;
  }
});

const IDE_OAUTH_CREDENTIALS = {
  accessToken: "test-token",
  providerSpecificData: { machineId: "a".repeat(64) },
};

// Tool history keeps OAuth requests on the AgentService path (text-only → SDK).
const AGENT_SERVICE_MESSAGES = [
  {
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "agent-bootstrap",
      type: "function",
      function: { name: "bootstrap", arguments: "{}" },
    }],
  },
  { role: "tool", tool_call_id: "agent-bootstrap", content: "ok" },
  { role: "user", content: "hi" },
];

function execRequestFrame(execField) {
  const execServerMessage = Buffer.from(encodeField(execField, LEN, new Uint8Array()));
  return Buffer.from(wrapConnectRPCFrame(encodeField(2, LEN, execServerMessage)));
}

function textFrame(text) {
  const textPart = Buffer.from(encodeField(1, LEN, text));
  const update = Buffer.from(encodeField(1, LEN, textPart));
  return Buffer.from(wrapConnectRPCFrame(encodeField(1, LEN, update)));
}

function thinkingFrame(text) {
  const thinkingPart = Buffer.from(encodeField(1, LEN, text));
  const update = Buffer.from(encodeField(4, LEN, thinkingPart));
  return Buffer.from(wrapConnectRPCFrame(encodeField(1, LEN, update)));
}

function turnEndedFrame() {
  const update = Buffer.from(encodeField(14, LEN, new Uint8Array()));
  return Buffer.from(wrapConnectRPCFrame(encodeField(1, LEN, update)));
}

function stubAgentSession(executor, frames) {
  const written = [];
  const queue = [...frames];
  executor.openAgentHttp2Stream = () => ({
    responseHeaders: Promise.resolve({ ":status": 200 }),
    write: (frame) => written.push(Buffer.from(frame)),
    end() {},
    close() {},
    async read() {
      if (!queue.length) return { value: undefined, done: true };
      return { value: queue.shift(), done: false };
    },
  });
  return written;
}

const credentials = {
  accessToken: "test-token",
  providerSpecificData: { machineId: "a".repeat(64) },
};

function parseSSE(text) {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => chunk.slice("data: ".length))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

async function runAgent({ frames, stream, model = "gpt-5.2", tools }) {
  const executor = new CursorExecutor();
  const written = stubAgentSession(executor, frames);
  const result = await executor.executeAgent({
    model,
    body: { messages: AGENT_SERVICE_MESSAGES, ...(tools ? { tools } : {}) },
    stream,
    credentials,
  });
  return { result, written };
}

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

  it("Should route tool-call conversations to AgentService when only IDE OAuth credentials are present", async () => {
    const executor = new CursorExecutor();
    let agentStreamOpened = false;
    executor.openAgentHttp2Stream = () => {
      agentStreamOpened = true;
      return {
        responseHeaders: Promise.resolve({ ":status": 200 }),
        write() {},
        end() {},
        close() {},
        async read() {
          return { value: undefined, done: true };
        },
      };
    };

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

    expect(agentStreamOpened).toBe(true);
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

describe("CursorExecutor AgentService exec_request handling", () => {
  for (const intent of [{ reasoning_effort: "high" }, { reasoning: { effort: "high" } }]) {
    it(`passes ${Object.keys(intent)[0]} through the AgentService executor`, async () => {
      const executor = new CursorExecutor();
      const written = stubAgentSession(executor, [textFrame("hello"), turnEndedFrame()]);
      const result = await executor.executeAgent({
        model: "gpt-5.2",
        body: { messages: AGENT_SERVICE_MESSAGES, ...intent },
        stream: false,
        credentials,
      });
      expect(result.response.status).toBe(200);
      const run = decodeMessage(decodeMessage(written[0].subarray(5)).get(1)[0].value);
      const requested = decodeMessage(run.get(9)[0].value);
      const parameter = decodeMessage(requested.get(3)[0].value);
      expect(Buffer.from(parameter.get(1)[0].value).toString()).toBe("reasoning");
      expect(Buffer.from(parameter.get(2)[0].value).toString()).toBe("high");
    });
  }

  for (const frames of [[], [turnEndedFrame()]]) {
    it(`rejects an empty ${frames.length ? "explicit turn" : "EOF"} without a successful SSE stop`, async () => {
      const { result } = await runAgent({ frames, stream: true });
      const text = await result.response.text();
      const events = parseSSE(text);
      expect(events.filter((event) => event.error)).toHaveLength(1);
      expect(events.some((event) => event.choices?.[0]?.finish_reason === "stop")).toBe(false);
      expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
    });

    it(`rejects an empty ${frames.length ? "explicit turn" : "EOF"} for non-stream clients`, async () => {
      const { result } = await runAgent({ frames, stream: false });
      expect(result.response.status).toBe(400);
      expect((await result.response.json()).error.message).toContain("empty turn");
    });
  }

  it("does not emit successful completion when reading the stream fails", async () => {
    const executor = new CursorExecutor();
    const written = stubAgentSession(executor, []);
    const open = executor.openAgentHttp2Stream;
    executor.openAgentHttp2Stream = (...args) => ({
      ...open(...args),
      async read() { throw new Error("transport interrupted"); },
    });
    const { response } = await executor.executeAgent({
      model: "gpt-5.2",
      body: { messages: AGENT_SERVICE_MESSAGES },
      stream: true,
      credentials,
    });
    await expect(response.text()).rejects.toThrow("transport interrupted");
    expect(written).toHaveLength(1);
  });
  it("acknowledges a request-context exec request without ending the turn", async () => {
    const { result, written } = await runAgent({
      frames: [execRequestFrame(10), textFrame("hello")],
      stream: true,
    });

    expect(written.length).toBe(2);
    const events = parseSSE(await result.response.text());
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("hello");
  });

  it("does not echo client tools on the request_context ack", async () => {
    const { written, result } = await runAgent({
      tools: [{ function: { name: "read_file", parameters: { type: "object" } } }],
      frames: [execRequestFrame(10), textFrame("hello")],
      stream: true,
    });

    expect(written.length).toBe(2);
    expect(written[1].toString("utf8")).not.toContain("read_file");
    const content = parseSSE(await result.response.text())
      .map((e) => e.choices?.[0]?.delta?.content || "")
      .join("");
    expect(content).toBe("hello");
  });

  it("does not render an unsupported exec request as assistant content", async () => {
    const { result, written } = await runAgent({
      frames: [textFrame("partial answer"), execRequestFrame(2), textFrame(" more")],
      stream: true,
    });

    const body = await result.response.text();
    expect(body).not.toContain("unsupported IDE tool");
    const events = parseSSE(body);
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("partial answer more");
    expect(events.some((e) => e.error)).toBe(false);
    expect(written.length).toBe(2);
  });

  it("still emits later text after rejecting an IDE exec in the same read", async () => {
    const { result } = await runAgent({
      frames: [Buffer.concat([execRequestFrame(2), textFrame("late")])],
      stream: true,
    });

    const body = await result.response.text();
    expect(body).not.toContain("unsupported IDE tool");
    expect(body).toContain("late");
  });

  it("returns a non-200 error body for an unsupported exec request when not streaming", async () => {
    const { result } = await runAgent({
      frames: [execRequestFrame(11)],
      stream: false,
    });

    expect(result.response.status).not.toBe(200);
    const payload = await result.response.json();
    expect(payload.error.message).toContain("unsupported IDE tool");
  });

  it("streams Composer visible content from thinking_delta after </think>", async () => {
    const { result } = await runAgent({
      model: "composer-2.5",
      frames: [
        thinkingFrame("private reasoning that must not leak</think>OK"),
        turnEndedFrame(),
      ],
      stream: true,
    });

    const events = parseSSE(await result.response.text());
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("OK");
    expect(JSON.stringify(events)).not.toContain("private reasoning");
  });

  it("flushes Grok thinking as visible content when the turn has no text_delta", async () => {
    const { result } = await runAgent({
      model: "grok-4.5",
      frames: [thinkingFrame("hello from grok"), turnEndedFrame()],
      stream: true,
    });

    const events = parseSSE(await result.response.text());
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("hello from grok");
  });
});

describe("Cursor long-session empty-turn recovery", () => {
  function runFrameHasHistory(frame) {
    const run = decodeMessage(decodeMessage(frame.subarray(5)).get(1)[0].value);
    const userAction = decodeMessage(decodeMessage(run.get(2)[0].value).get(1)[0].value);
    return userAction.has(7);
  }

  const longBody = {
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "long-bootstrap",
          type: "function",
          function: { name: "bootstrap", arguments: "{}" },
        }],
      },
      { role: "tool", tool_call_id: "long-bootstrap", content: "ok" },
      ...Array.from({ length: 79 }, (_, i) => ({ role: "user", content: `m${i}` })),
      { role: "user", content: "answer me" },
    ],
  };

  function stubSequentialAgentSessions(executor, attempts) {
    const writtenPerAttempt = [];
    let call = 0;
    executor.openAgentHttp2Stream = () => {
      const frames = attempts[Math.min(call, attempts.length - 1)];
      const written = [];
      writtenPerAttempt.push(written);
      const queue = [...frames];
      call++;
      return {
        responseHeaders: Promise.resolve({ ":status": 200 }),
        write: (frame) => written.push(Buffer.from(frame)),
        end() {},
        close() {},
        async read() {
          if (!queue.length) return { value: undefined, done: true };
          return { value: queue.shift(), done: false };
        },
      };
    };
    return writtenPerAttempt;
  }

  it("retries a wedged long session once with a tail-only frame (streaming)", async () => {
    const executor = new CursorExecutor();
    const writtenPerAttempt = stubSequentialAgentSessions(executor, [
      [],
      [textFrame("recovered"), turnEndedFrame()],
    ]);
    const result = await executor.executeAgent({
      model: "gpt-5.2", body: longBody, stream: true, credentials,
    });

    const text = await result.response.text();
    expect(writtenPerAttempt).toHaveLength(2);
    expect(runFrameHasHistory(writtenPerAttempt[0][0])).toBe(true);
    expect(runFrameHasHistory(writtenPerAttempt[1][0])).toBe(false);

    const events = parseSSE(text);
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("recovered");
    expect(events.filter((e) => e.error)).toHaveLength(0);
    expect(events.filter((e) => e.choices?.[0]?.finish_reason === "stop")).toHaveLength(1);
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("recovers a wedged long session for non-stream clients", async () => {
    const executor = new CursorExecutor();
    stubSequentialAgentSessions(executor, [
      [],
      [textFrame("ok"), turnEndedFrame()],
    ]);
    const result = await executor.executeAgent({
      model: "gpt-5.2", body: longBody, stream: false, credentials,
    });
    expect(result.response.status).toBe(200);
    const payload = await result.response.json();
    expect(payload.choices[0].message.content).toBe("ok");
  });

  it("does not retry a short session — first-message empty stays an error", async () => {
    const executor = new CursorExecutor();
    const writtenPerAttempt = stubSequentialAgentSessions(executor, [[]]);
    const result = await executor.executeAgent({
      model: "gpt-5.2",
      body: { messages: AGENT_SERVICE_MESSAGES },
      stream: true,
      credentials,
    });

    expect(writtenPerAttempt).toHaveLength(1);
    const text = await result.response.text();
    const events = parseSSE(text);
    expect(events.filter((e) => e.error)).toHaveLength(1);
    expect(events.some((e) => e.choices?.[0]?.finish_reason === "stop")).toBe(false);
  });

  it("does not retry once real content has streamed", async () => {
    const executor = new CursorExecutor();
    const writtenPerAttempt = stubSequentialAgentSessions(executor, [
      [textFrame("partial")],
    ]);
    const result = await executor.executeAgent({
      model: "gpt-5.2", body: longBody, stream: true, credentials,
    });

    expect(writtenPerAttempt).toHaveLength(1);
    const events = parseSSE(await result.response.text());
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("partial");
    expect(events.filter((e) => e.error)).toHaveLength(0);
  });

  it("tailOnlyCursorMessages keeps system, drops bulk history, keeps the live turn", async () => {
    const { tailOnlyCursorMessages } = await import("../../open-sse/executors/cursor.js");
    const messages = [
      { role: "system", content: "be helpful" },
      ...Array.from({ length: 90 }, (_, i) => ({ role: "user", content: `m${i}` })),
      { role: "assistant", content: "working on it" },
      { role: "tool", content: "result" },
      { role: "user", content: "final ask" },
    ];
    const trimmed = tailOnlyCursorMessages(messages);
    expect(trimmed[0]).toEqual({ role: "system", content: "be helpful" });
    expect(trimmed).toHaveLength(3);
    expect(trimmed[1].content).toContain("94 messages trimmed");
    expect(trimmed[2].content).toBe("final ask");

    const again = tailOnlyCursorMessages(trimmed);
    expect(again.filter((m) => String(m.content).includes("[9router]"))).toHaveLength(1);
  });
});
