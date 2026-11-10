import Anthropic from '@anthropic-ai/sdk';

/**
 * Builds the Claude client. Two ways to reach Claude:
 *   ANTHROPIC_API_KEY  -> Anthropic API directly (model IDs like "claude-opus-5-5")
 *   OPENROUTER_API_KEY -> OpenRouter's Anthropic-compatible endpoint (model IDs like "anthropic/claude-opus-5.5")
 * Returns null when neither is set (the agent then uses rule-based assessments).
 */
export function createClaudeClient(env: NodeJS.ProcessEnv = process.env): { client: Anthropic; provider: 'anthropic' | 'openrouter'; defaultModel: string } | null {
  const openrouter = env.OPENROUTER_API_KEY?.trim();
  if (openrouter) {
    return {
      client: new Anthropic({ baseURL: 'https://openrouter.ai/api', apiKey: null, authToken: openrouter, maxRetries: 2 }),
      provider: 'openrouter',
      defaultModel: 'anthropic/claude-opus-5.5',
    };
  }
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (key) return { client: new Anthropic({ apiKey: key, baseURL: 'https://api.anthropic.com', maxRetries: 2 }), provider: 'anthropic', defaultModel: 'claude-opus-5-5' };
  return null;
}
