import Anthropic from "@anthropic-ai/sdk";

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Per project decision: Sonnet 4.6 — fast + cheap, quality is fine for this.
export const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
