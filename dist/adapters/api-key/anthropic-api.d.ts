declare const IAIAdapter: any;
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
    systemPromptCacheable?: boolean;
    tools?: ToolSpec[];
    onDelta?: (text: string) => void;
    model: string;
    maxOutputTokens: number;
    schema?: Record<string, unknown> | null;
    apiKeyEnv?: string;
    baseUrl?: string;
}
interface AdapterCompleteResponse {
    text: string | null;
    schemaJson: unknown | null;
    tokensIn: number;
    tokensOut: number;
    cachedTokensIn?: number;
    cacheCreationIn?: number;
    needsToolExecution?: boolean;
    response?: Record<string, unknown> | null;
}
declare class AnthropicAPIAdapter extends IAIAdapter {
    get provider(): string;
    complete(req: AdapterCompleteRequest): Promise<AdapterCompleteResponse>;
    estimateTokens(prompt: string): number;
}
declare const _default: {
    AnthropicAPIAdapter: typeof AnthropicAPIAdapter;
};
export = _default;
//# sourceMappingURL=anthropic-api.d.ts.map