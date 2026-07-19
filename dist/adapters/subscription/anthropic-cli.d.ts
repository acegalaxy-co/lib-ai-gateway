declare const IAIAdapter: any;
interface AdapterCompleteRequest {
    prompt: string;
    model: string;
    maxOutputTokens: number;
    schema?: Record<string, unknown> | null;
    skill?: string;
    systemPromptCacheable?: boolean;
    timeoutMs?: number;
    allowedTools?: string;
    mcpConfigPath?: string;
    baseUrl?: string;
}
interface AdapterCompleteResponse {
    text: string | null;
    schemaJson: unknown | null;
    tokensIn: number;
    tokensOut: number;
}
declare function _toCliModel(model: string): string;
declare class AnthropicCLIAdapter extends IAIAdapter {
    get provider(): string;
    complete(req: AdapterCompleteRequest): Promise<AdapterCompleteResponse>;
    estimateTokens(prompt: string): number;
}
declare const _default: {
    AnthropicCLIAdapter: typeof AnthropicCLIAdapter;
    _toCliModel: typeof _toCliModel;
};
export = _default;
//# sourceMappingURL=anthropic-cli.d.ts.map