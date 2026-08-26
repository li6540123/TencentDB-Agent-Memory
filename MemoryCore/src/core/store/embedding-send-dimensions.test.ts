import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIEmbeddingService } from "./embedding.js";

const baseConfig = {
  provider: "openai",
  baseUrl: "https://embedding.example/v1",
  apiKey: "sk-test",
  model: "Qwen3-Embedding",
  dimensions: 4096,
} as const;

function mockEmbeddingFetch() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        data: [{ index: 0, embedding: [0.1, 0.2] }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
}

describe("OpenAIEmbeddingService sendDimensions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("omits dimensions when sendDimensions is false (Qwen3 / BGE-M3)", async () => {
    const fetchMock = mockEmbeddingFetch();
    const svc = new OpenAIEmbeddingService(
      { ...baseConfig, sendDimensions: false },
    );

    await svc.embed("hello");

    const init = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body));
    expect(body.dimensions).toBeUndefined();
    expect(body.model).toBe("Qwen3-Embedding");
  });

  it("includes dimensions when sendDimensions is true (OpenAI text-embedding-3)", async () => {
    const fetchMock = mockEmbeddingFetch();
    const svc = new OpenAIEmbeddingService(
      { ...baseConfig, sendDimensions: true },
    );

    await svc.embed("hello");

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.dimensions).toBe(4096);
  });

  it("defaults sendDimensions to true when omitted", async () => {
    const fetchMock = mockEmbeddingFetch();
    const svc = new OpenAIEmbeddingService({ ...baseConfig });

    await svc.embed("hello");

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.dimensions).toBe(4096);
  });
});
