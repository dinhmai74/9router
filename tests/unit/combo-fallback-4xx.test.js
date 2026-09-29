import { describe, it, expect } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";

describe("handleComboChat — fallback on request-scoped 4xx", () => {
  it("Should try next combo model when first returns unsupported-model 400", async () => {
    const log = { info: () => {}, warn: () => {} };
    const tried = [];
    const handleSingleModel = async (_body, modelStr) => {
      tried.push(modelStr);
      if (modelStr === "mmf/mimo-auto") {
        return new Response(
          JSON.stringify({ error: { message: "Unsupported model mimo-auto" } }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["mmf/mimo-auto", "cl/stealth/space-bunny-alpha"],
      handleSingleModel,
      log,
      autoSwitch: false,
    });

    expect(res.ok).toBe(true);
    expect(tried).toEqual(["mmf/mimo-auto", "cl/stealth/space-bunny-alpha"]);
  });

  it("Should return 400 when only combo model fails with request-scoped 400", async () => {
    const log = { info: () => {}, warn: () => {} };
    const handleSingleModel = async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "This model's maximum context length is 1048576 tokens.",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["only/model"],
      handleSingleModel,
      log,
      autoSwitch: false,
    });

    expect(res.status).toBe(400);
  });
});
