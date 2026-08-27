// Classification invariants shared by BB's no-argument built-in commands.
//
// These cases moved here from the legacy Codex adapter suite
// (`plugins/provider-codex/src/adapter.test.ts`) when that adapter was
// deleted. The function is shared with the canonical Codex bridge, which uses
// it to route `/compact` to `thread/compact/start`; the server uses the same
// rules for `/clear`. Their routing decisions are covered at those boundaries,
// while these cases pin classification only.

import { describe, expect, it } from "vitest";

import {
  isStandaloneBuiltinClearCommand,
  isStandaloneBuiltinCompactCommand,
} from "../src/shared-types.js";
import type { PromptInput, PromptMentionCommandOrigin } from "../src/index.js";

function promptCommandInput(
  name: string,
  args?: {
    origin?: PromptMentionCommandOrigin;
    text?: string;
  },
): PromptInput {
  const commandText = `/${name}`;
  const text = args?.text ?? commandText;
  const start = text.indexOf(commandText);
  if (start === -1) {
    throw new Error(`Missing ${commandText} command text in "${text}".`);
  }
  return {
    type: "text",
    text,
    mentions: [
      {
        start,
        end: start + commandText.length,
        resource: {
          kind: "command",
          trigger: "/",
          name,
          source: "command",
          origin: args?.origin ?? "builtin",
          label: name,
          argumentHint: null,
        },
      },
    ],
  };
}

function promptTextInput(text: string): PromptInput {
  return { type: "text", text, mentions: [] };
}

describe.each([
  ["compact", isStandaloneBuiltinCompactCommand],
  ["clear", isStandaloneBuiltinClearCommand],
] as const)("isStandaloneBuiltin%sCommand", (name, classify) => {
  it("classifies a standalone built-in mention", () => {
    expect(classify([promptCommandInput(name)])).toBe(true);
  });

  it("does not classify raw command text", () => {
    expect(classify([promptTextInput(`/${name}`)])).toBe(false);
  });

  it("does not classify user-origin commands", () => {
    expect(classify([promptCommandInput(name, { origin: "user" })])).toBe(
      false,
    );
  });

  it("does not classify mixed command input", () => {
    expect(
      classify([promptCommandInput(name, { text: `/${name} then summarize` })]),
    ).toBe(false);
  });
});
