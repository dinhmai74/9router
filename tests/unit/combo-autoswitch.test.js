import { describe, it, expect } from "vitest";
import { detectRequiredCapabilities } from "../../open-sse/services/combo.js";

describe("detectRequiredCapabilities", () => {
  it("text-only -> empty", () => {
    const r = detectRequiredCapabilities({ messages: [{ role: "user", content: "hi" }] });
    expect(r.size).toBe(0);
  });

  it("openai image_url -> vision", () => {
    const r = detectRequiredCapabilities({ messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: "x" } },
    ] }] });
    expect(r.has("vision")).toBe(true);
  });

  it("openai file -> pdf", () => {
    const r = detectRequiredCapabilities({ messages: [{ role: "user", content: [
      { type: "file", file: { file_data: "data:application/pdf;base64,x" } },
    ] }] });
    expect(r.has("pdf")).toBe(true);
  });

  it("gemini inlineData image -> vision", () => {
    const r = detectRequiredCapabilities({ contents: [{ role: "user", parts: [
      { inlineData: { mimeType: "image/png", data: "x" } },
    ] }] });
    expect(r.has("vision")).toBe(true);
  });

  it("antigravity request.contents image -> vision", () => {
    const r = detectRequiredCapabilities({ request: { contents: [{ role: "user", parts: [
      { inlineData: { mimeType: "image/jpeg", data: "x" } },
    ] }] } });
    expect(r.has("vision")).toBe(true);
  });

  it("web_search tool -> search", () => {
    const r = detectRequiredCapabilities({ messages: [{ role: "user", content: "q" }], tools: [
      { type: "web_search" },
    ] });
    expect(r.has("search")).toBe(true);
  });

  it("responses input_image -> vision", () => {
    const r = detectRequiredCapabilities({ input: [{ role: "user", content: [
      { type: "input_image", image_url: "x" },
    ] }] });
    expect(r.has("vision")).toBe(true);
  });
});
