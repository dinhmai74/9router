import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspaceCwd, resolveClientWorkspaceCwd } from "../../open-sse/utils/resolveWorkspaceCwd.js";

describe("resolveWorkspaceCwd", () => {
  it("Should resolve pi Current working directory lines from system messages", () => {
    const workspace = os.tmpdir();
    expect(resolveWorkspaceCwd({
      messages: [
        {
          role: "system",
          content: `You are an assistant.\nCurrent working directory: ${workspace}\n`,
        },
        { role: "user", content: "hi" },
      ],
    })).toBe(workspace);
  });

  it("Should resolve <cwd> tags from client environment context", () => {
    const workspace = os.tmpdir();
    expect(resolveWorkspaceCwd({
      messages: [
        {
          role: "user",
          content: `<environment_context>\n  <cwd>${workspace}</cwd>\n</environment_context>\nhi`,
        },
      ],
    })).toBe(workspace);
  });

  it("Should prefer explicit body.cwd over prompt context", () => {
    const workspace = os.tmpdir();
    const other = path.dirname(workspace);
    expect(resolveWorkspaceCwd({
      cwd: workspace,
      messages: [
        { role: "system", content: `Current working directory: ${other}\n` },
      ],
    })).toBe(workspace);
  });

  it("Should return undefined when no valid absolute directory is found", () => {
    expect(resolveWorkspaceCwd({
      messages: [{ role: "system", content: "Current working directory: /definitely/not/a/real/path\n" }],
    })).toBeUndefined();
  });

  it("Should trust the last pi cwd line without requiring the path to exist locally", () => {
    expect(resolveClientWorkspaceCwd({
      messages: [
        { role: "system", content: "Current working directory: /definitely/not/a/real/path\n" },
        { role: "user", content: "Current working directory: /also/not/a/real/path\n" },
      ],
    })).toBe("/also/not/a/real/path");
  });

  it("Should resolve pi cwd from body.system before translated messages", () => {
    const workspace = "/definitely/not/a/real/path";
    expect(resolveClientWorkspaceCwd({
      system: [{ type: "text", text: `You are an assistant.\nCurrent working directory: ${workspace}\n` }],
      messages: [{ role: "user", content: "hi" }],
    })).toBe(workspace);
  });

  it("Should resolve explicit x-cwd header before body fields", () => {
    const workspace = "/definitely/not/a/real/path";
    const other = "/also/not/a/real/path";
    expect(resolveClientWorkspaceCwd({
      cwd: other,
      messages: [{ role: "user", content: "hi" }],
    }, {
      "x-cwd": workspace,
    })).toBe(workspace);
  });

  it("Should not throw when message content parts have undefined text fields", () => {
    const workspace = os.tmpdir();
    expect(resolveClientWorkspaceCwd({
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: `Current working directory: ${workspace}\n` },
            { type: "image_url" },
          ],
        },
        { role: "user", content: "hi" },
      ],
    })).toBe(workspace);
  });
});
