import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMMessage, LLMOptions, LLMResponse } from '../../types/index.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-opus-4-6';
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_TEMPERATURE = 0;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// ─── Claude Provider ──────────────────────────────────────────────────────────

export class ClaudeProvider implements LLMProvider {
  readonly name = 'claude';
  private client: Anthropic;
  private defaultModel: string;

  constructor(options: { apiKey?: string; model?: string } = {}) {
    const apiKey = options.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      throw new Error(
        'Anthropic API key not found. Set ANTHROPIC_API_KEY environment variable or pass apiKey option.'
      );
    }
    this.client = new Anthropic({ apiKey });
    this.defaultModel = options.model ?? DEFAULT_MODEL;
  }

  async complete(messages: LLMMessage[], options: LLMOptions = {}): Promise<LLMResponse> {
    const model = options.model ?? this.defaultModel;
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    const temperature = options.temperature ?? DEFAULT_TEMPERATURE;

    // Separate system message from conversation
    const systemMessages = messages.filter((m) => m.role === 'system');
    const userMessages = messages.filter((m) => m.role !== 'system');
    const systemContent = systemMessages.map((m) => m.content).join('\n\n');

    const anthropicMessages = userMessages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.client.messages.create({
          model,
          max_tokens: maxTokens,
          temperature,
          system: systemContent || undefined,
          messages: anthropicMessages,
        });

        const content = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('');

        return {
          content,
          model: response.model,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          finishReason:
            response.stop_reason === 'end_turn'
              ? 'stop'
              : response.stop_reason === 'max_tokens'
              ? 'max_tokens'
              : 'stop',
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Don't retry on auth errors or invalid requests
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.BadRequestError) {
          throw lastError;
        }

        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          await sleep(delay);
        }
      }
    }

    throw lastError ?? new Error('Claude API request failed after retries');
  }

  async *stream(messages: LLMMessage[], options: LLMOptions = {}): AsyncGenerator<string> {
    const model = options.model ?? this.defaultModel;
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    const temperature = options.temperature ?? DEFAULT_TEMPERATURE;

    const systemMessages = messages.filter((m) => m.role === 'system');
    const userMessages = messages.filter((m) => m.role !== 'system');
    const systemContent = systemMessages.map((m) => m.content).join('\n\n');

    const anthropicMessages = userMessages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const stream = this.client.messages.stream({
      model,
      max_tokens: maxTokens,
      temperature,
      system: systemContent || undefined,
      messages: anthropicMessages,
    });

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        const token = event.delta.text;
        if (options.onToken) options.onToken(token);
        yield token;
      }
    }
  }
}

// ─── JSON Extraction ──────────────────────────────────────────────────────────

export function extractJSON<T>(content: string): T {
  // Try direct parse first
  try {
    return JSON.parse(content) as T;
  } catch {
    // Try to extract JSON from markdown code blocks
    const codeBlockMatch = /```(?:json)?\s*([\s\S]+?)```/.exec(content);
    if (codeBlockMatch) {
      try {
        return JSON.parse(codeBlockMatch[1].trim()) as T;
      } catch {
        // continue
      }
    }

    // Try to find first { and last }
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(content.slice(start, end + 1)) as T;
      } catch {
        // continue
      }
    }

    throw new Error(`Failed to extract JSON from LLM response: ${content.slice(0, 200)}...`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
