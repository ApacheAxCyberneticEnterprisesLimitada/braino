export const DEFAULT_OPENROUTER_MODEL = "google/gemini-3.5-flash-lite";
export const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterStructuredOutputClientOptions {
  model?: string;
  url?: string;
  apiToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface OpenRouterStructuredOutputRequest {
  system: string;
  prompt: string;
  schema: object;
  schemaName: string;
  maxTokens: number;
}

const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  "const",
  "default",
  "exclusiveMaximum",
  "exclusiveMinimum",
  // Gemini 3.5 Flash-Lite rejects otherwise valid structured-output schemas containing this.
  "maxItems",
  "maxLength",
  "minLength",
  "multipleOf",
  "pattern",
  "uniqueItems",
]);

function geminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(geminiSchema);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(key))
      .map(([key, item]) => [key, geminiSchema(item)]),
  );
}

export function buildOpenRouterStructuredOutputRequest(
  model: string,
  apiToken: string | undefined,
  input: OpenRouterStructuredOutputRequest,
) {
  return {
    headers: {
      "content-type": "application/json",
      ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}),
    },
    body: {
      model,
      stream: false,
      temperature: 0,
      max_tokens: input.maxTokens,
      reasoning: { effort: "minimal" },
      provider: {
        require_parameters: true,
        data_collection: "deny",
      },
      response_format: {
        type: "json_schema",
        json_schema: {
          name: input.schemaName,
          strict: true,
          schema: geminiSchema(input.schema),
        },
      },
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.prompt },
      ],
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The one strict-schema model transport used by Braino's Gemini extraction flows. */
export class OpenRouterStructuredOutputClient {
  readonly id: string;
  private readonly model: string;
  private readonly url: string;
  private readonly apiToken: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenRouterStructuredOutputClientOptions = {}) {
    this.model = options.model?.trim() || DEFAULT_OPENROUTER_MODEL;
    this.id = `openrouter:${this.model}`;
    this.url = options.url?.trim() || OPENROUTER_CHAT_COMPLETIONS_URL;
    this.apiToken = options.apiToken?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request(input: OpenRouterStructuredOutputRequest): Promise<unknown> {
    const request = buildOpenRouterStructuredOutputRequest(this.model, this.apiToken, input);
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: request.headers,
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify(request.body),
    });
    if (!response.ok) {
      throw new Error(`OpenRouter structured-output request failed with HTTP ${response.status}`);
    }
    const envelope: unknown = await response.json();
    const choice =
      isObject(envelope) && Array.isArray(envelope.choices) ? envelope.choices[0] : undefined;
    if (!isObject(choice) || !isObject(choice.message)) {
      throw new Error("OpenRouter returned an invalid structured-output envelope");
    }
    try {
      return typeof choice.message.content === "string"
        ? JSON.parse(choice.message.content)
        : choice.message.content;
    } catch {
      throw new Error("OpenRouter returned invalid structured-output JSON");
    }
  }
}
