import Anthropic from "@anthropic-ai/sdk";

/**
 * Lazy + cached Anthropic client.
 *
 * Why lazy: scripts under scripts/ load .env.local via dotenv AFTER
 * Node has already begun resolving imports. If the SDK is constructed
 * at module top-level the constructor sees process.env.ANTHROPIC_API_KEY
 * as undefined and the client is permanently broken for that process,
 * even though the env var is set on disk and resolves correctly by the
 * time any code actually runs.
 *
 * Constructing on first call (via getAnthropicClient) reads the env at
 * call time, which is after dotenv injection. The result is cached, so
 * subsequent calls share one HTTP connection pool.
 */
let _client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (_client) return _client;
  _client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
  return _client;
}

/**
 * Read the Anthropic model at call time. Same race rationale as the
 * client: an override in .env.local that is loaded after module import
 * needs to be visible. No caching because the value is cheap to recompute.
 *
 * Per project decision: Sonnet 4.6 is the default. Fast, cheap, quality
 * is fine for extraction + briefing workloads.
 */
export function getAnthropicModel(): string {
  return process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
}
