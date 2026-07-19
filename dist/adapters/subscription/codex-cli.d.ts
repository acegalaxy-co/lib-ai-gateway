declare const IAIAdapter: any;
interface AdapterCompleteRequest {
    prompt: string;
    model: string;
    maxOutputTokens: number;
    schema?: Record<string, unknown> | null;
    skill?: string;
    timeoutMs?: number;
    mcpConfigPath?: string;
    baseUrl?: string;
}
interface AdapterCompleteResponse {
    text: string | null;
    schemaJson: unknown | null;
    tokensIn: number;
    tokensOut: number;
}
declare class CodexCLIAdapter extends IAIAdapter {
    get provider(): string;
    complete(req: AdapterCompleteRequest): Promise<AdapterCompleteResponse>;
    estimateTokens(prompt: string): number;
}
declare const _default: {
    CodexCLIAdapter: typeof CodexCLIAdapter;
};
export = _default;
//# sourceMappingURL=codex-cli.d.ts.map