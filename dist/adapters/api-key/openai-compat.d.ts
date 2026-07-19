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
declare function _maxTokensField(modelId: string): string;
declare function _convertTools(tools: ToolSpec[]): any[];
declare function _convertMessages(messages: ChatMessage[], systemPrompt?: string): any[];
declare class OpenAICompatAdapter extends IAIAdapter {
    get provider(): string;
    complete(req: AdapterCompleteRequest): Promise<AdapterCompleteResponse>;
    estimateTokens(prompt: string): number;
}
declare function _consumeStream(resp: Response, req: AdapterCompleteRequest): Promise<AdapterCompleteResponse>;
declare const _default: {
    OpenAICompatAdapter: typeof OpenAICompatAdapter;
    _maxTokensField: typeof _maxTokensField;
    _convertTools: typeof _convertTools;
    _convertMessages: typeof _convertMessages;
    _consumeStream: typeof _consumeStream;
    REQUEST_TIMEOUT_MS: number;
};
export = _default;
//# sourceMappingURL=openai-compat.d.ts.map