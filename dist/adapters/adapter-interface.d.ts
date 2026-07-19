interface ChatMessage {
    role: "user" | "assistant" | "system";
    content: string | Array<Record<string, unknown>>;
}
interface ToolSpec {
    name: string;
    description?: string;
    input_schema?: Record<string, unknown>;
}
interface AdapterCompleteRequest {
    prompt?: string;
    messages?: ChatMessage[];
    systemPrompt?: string;
    tools?: ToolSpec[];
    onDelta?: (text: string) => void;
    model: string;
    maxOutputTokens: number;
    schema?: Record<string, unknown> | null;
    skill?: string;
    baseUrl?: string;
}
interface AdapterCompleteResponse {
    text: string | null;
    schemaJson: unknown | null;
    tokensIn: number;
    tokensOut: number;
    needsToolExecution?: boolean;
    response?: Record<string, unknown> | null;
}
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
declare class IAIAdapter {
    get provider(): string;
    complete(req: AdapterCompleteRequest): Promise<AdapterCompleteResponse>;
    estimateTokens(prompt: string): number;
}
declare class IEmbedAdapter {
    get provider(): string;
    embed(req: AdapterEmbedRequest): Promise<AdapterEmbedResponse>;
    estimateTokens(inputs: string[]): number;
}
declare const _default: {
    IAIAdapter: typeof IAIAdapter;
    IEmbedAdapter: typeof IEmbedAdapter;
};
export = _default;
//# sourceMappingURL=adapter-interface.d.ts.map