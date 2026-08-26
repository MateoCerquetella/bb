import { describe, expect, it } from "vitest";
import { isStandaloneBuiltinClearCommand } from "../src/shared-types.js";
import type { PromptInput, PromptMentionCommandOrigin } from "../src/index.js";

function clearInput(args?: {
  origin?: PromptMentionCommandOrigin;
  text?: string;
}): PromptInput {
  const text = args?.text ?? "/clear";
  const start = text.indexOf("/clear");
  if (start === -1) throw new Error(`Missing /clear command in "${text}"`);
  return {
    type: "text",
    text,
    mentions: [
      {
        start,
        end: start + "/clear".length,
        resource: {
          kind: "command",
          trigger: "/",
          name: "clear",
          source: "command",
          origin: args?.origin ?? "builtin",
          label: "clear",
          argumentHint: null,
        },
      },
    ],
  };
}

describe("isStandaloneBuiltinClearCommand", () => {
  it("accepts only a standalone selected built-in /clear command", () => {
    expect(isStandaloneBuiltinClearCommand([clearInput()])).toBe(true);
    expect(
      isStandaloneBuiltinClearCommand([
        { type: "text", text: "/clear", mentions: [] },
      ]),
    ).toBe(false);
    expect(
      isStandaloneBuiltinClearCommand([clearInput({ origin: "user" })]),
    ).toBe(false);
    expect(
      isStandaloneBuiltinClearCommand([
        clearInput({ text: "/clear then summarize" }),
      ]),
    ).toBe(false);
  });
});
