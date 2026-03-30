import OpenAI from 'openai';
import type { LLMProvider, LLMMessage, LLMOptions, LLMResponse } from '../../types/index.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'gpt-4o';
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_TEMPERATURE = 0;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// ─── OpenAI Provider ──────────────────────────────────────────────────────────

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  private client: OpenAI;
  private defaultModel: string;

  constructor(options: { apiKey?: string; model?: string; baseURL?: string } = {}) {
    const apiKey = options.apiKey ?? process.env['OPENAI_API_KEY'];
    if (!apiKey) {
      throw new Error(
        'OpenAI API key not found. Set OPENAI_API_KEY environment variable or pass apiKey option.'
      );
    }
    this.client = new OpenAI({
      apiKey,
      baseURL: options.baseURL,
    });
    this.defaultModel = options.model ?? DEFAULT_MODEL;
  }

  async complete(messages: LLMMessage[], options: LLMOptions = {}): Promise<LLMResponse> {
    const model = options.model ?? this.defaultModel;
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    const temperature = options.temperature ?? DEFAULT_TEMPERATURE;

    const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model,
          max_tokens: maxTokens,
          temperature,
          messages: openaiMessages,
          response_format: { type: 'json_object' },
        });

        const choice = response.choices[0];
        if (!choice) throw new Error('OpenAI returned no choices');

        const content = choice.message.content ?? '';
        const inputTokens = response.usage?.prompt_tokens ?? 0;
        const outputTokens = response.usage?.completion_tokens ?? 0;
        const finishReason =
          choice.finish_reason === 'stop'
            ? 'stop'
            : choice.finish_reason === 'length'
            ? 'max_tokens'
            : 'stop';

        return { content, model: response.model, inputTokens, outputTokens, finishReason };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Don't retry on auth errors
        if (err instanceof OpenAI.AuthenticationError) {
          throw lastError;
        }

        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          await sleep(delay);
        }
      }
    }

    throw lastError ?? new Error('OpenAI API request failed after retries');
  }

  async *stream(messages: LLMMessage[], options: LLMOptions = {}): AsyncGenerator<string> {
    const model = options.model ?? this.defaultModel;
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    const temperature = options.temperature ?? DEFAULT_TEMPERATURE;

    const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const stream = await this.client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: openaiMessages,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        if (options.onToken) options.onToken(delta);
        yield delta;
      }
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
