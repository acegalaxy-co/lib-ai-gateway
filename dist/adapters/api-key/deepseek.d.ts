declare const IAIAdapter: any;
interface ChatMessage {
    role: "user" | "assistant" | "system";
    content: string | Array<Record<string, any>>;
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
    baseUrl?: string;
    apiKeyEnv?: string;
}
interface AdapterCompleteResponse {
    text: string | null;
    schemaJson: unknown | null;
    tokensIn: number;
    tokensOut: number;
    needsToolExecution?: boolean;
    response?: Record<string, unknown> | null;
}
declare class DeepSeekAdapter extends IAIAdapter {
    get provider(): string;
    complete(req: AdapterCompleteRequest): Promise<AdapterCompleteResponse>;
    estimateTokens(prompt: string): number;
}
declare const _default: {
    DeepSeekAdapter: typeof DeepSeekAdapter;
};
export = _default;
//# sourceMappingURL=deepseek.d.ts.map