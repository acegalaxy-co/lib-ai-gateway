declare const IEmbedAdapter: any;
interface AdapterEmbedRequest {
    inputs: string[];
    model: string;
    baseUrl?: string;
    apiKeyEnv?: string;
}
interface AdapterEmbedResponse {
    vectors: number[][];
    tokensIn: number;
}
declare class OpenAIEmbeddingsAdapter extends IEmbedAdapter {
    get provider(): string;
    embed(req: AdapterEmbedRequest): Promise<AdapterEmbedResponse>;
    estimateTokens(inputs: string[]): number;
}
declare const _default: {
    OpenAIEmbeddingsAdapter: typeof OpenAIEmbeddingsAdapter;
};
export = _default;
//# sourceMappingURL=openai-embeddings.d.ts.map