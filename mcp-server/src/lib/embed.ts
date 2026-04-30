export interface EmbedAdapter {
  embed(text: string): Promise<number[] | null>;
}

/** Expected dimension count for all production embedding vectors. */
export const REQUIRED_EMBEDDING_DIMENSIONS = 3072;

/** Validate that a vector has the correct dimensionality. Throws on mismatch. */
export function assertEmbeddingDimensions(vector: number[], label?: string): void {
  if (vector.length !== REQUIRED_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding dimension mismatch${label ? ` (${label})` : ""}: got ${vector.length}, expected ${REQUIRED_EMBEDDING_DIMENSIONS}. ` +
      "Ensure EMBEDDING_PROVIDER=openrouter with google/gemini-embedding-2-preview."
    );
  }
}

export interface OllamaEmbedAdapterConfig {
  model?: string;
  baseUrl?: string;
}

export class OllamaEmbedAdapter implements EmbedAdapter {
  private readonly endpoint: string;
  private readonly model: string;

  constructor(config: OllamaEmbedAdapterConfig = {}) {
    this.endpoint = (config.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    this.model = config.model ?? process.env.OLLAMA_EMBEDDING_MODEL ?? "nomic-embed-text";
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.endpoint}/api/embeddings`, {
      method: "POST",
      body: JSON.stringify({
        model: this.model,
        prompt: text,
      }),
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Ollama embeddings failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as { embedding?: number[] };
    if (!payload.embedding || payload.embedding.length === 0) {
      throw new Error("Ollama embedding response missing vector");
    }

    return payload.embedding;
  }
}

/** @deprecated OpenAI embeddings are disabled in production. OpenRouter Gemini embeddings are the hosted default. */
export class OpenAIEmbedAdapter implements EmbedAdapter {
  constructor(_apiKey?: string) {
    throw new Error(
      "OpenAI embeddings are disabled. Set EMBEDDING_PROVIDER=openrouter (or omit it). " +
      "All vectors must be google/gemini-embedding-2-preview / 3072 dimensions."
    );
  }

  async embed(_text: string): Promise<number[] | null> {
    throw new Error("OpenAI embeddings are disabled.");
  }
}

export class OpenRouterGeminiEmbedAdapter implements EmbedAdapter {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(config: { apiKey?: string; model?: string } = {}) {
    const resolvedApiKey = config.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!resolvedApiKey) {
      throw new Error("OPENROUTER_API_KEY is required for OpenRouterGeminiEmbedAdapter");
    }
    this.apiKey = resolvedApiKey;
    this.model = config.model ?? process.env.OPENROUTER_EMBEDDING_MODEL ?? "google/gemini-embedding-2-preview";
  }

  async embed(text: string): Promise<number[] | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: text,
          dimensions: REQUIRED_EMBEDDING_DIMENSIONS,
          encoding_format: "float",
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`OpenRouter embeddings failed: ${response.status} ${response.statusText}`);
      }

      const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
      const values = payload.data?.[0]?.embedding;
      if (!values || values.length === 0) {
        throw new Error("OpenRouter embedding response missing vector");
      }

      if (values.length !== REQUIRED_EMBEDDING_DIMENSIONS) {
        throw new Error(
          `OpenRouter embedding dimension mismatch: got ${values.length}, expected ${REQUIRED_EMBEDDING_DIMENSIONS}`
        );
      }

      return values;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const getEmbedAdapter = (): EmbedAdapter => {
  const provider = (process.env.EMBEDDING_PROVIDER ?? "openrouter").toLowerCase();

  switch (provider) {
    case "openrouter":
    case "gemini":
      return new OpenRouterGeminiEmbedAdapter();
    case "ollama":
      return new OllamaEmbedAdapter();
    case "openai":
      throw new Error(
        "OpenAI embeddings are disabled in production. Set EMBEDDING_PROVIDER=openrouter. " +
        "All vectors must use google/gemini-embedding-2-preview / 3072 dimensions."
      );
    default:
      throw new Error(`Unsupported EMBEDDING_PROVIDER \"${provider}\". Use \"openrouter\", \"gemini\", or \"ollama\".`);
  }
};
