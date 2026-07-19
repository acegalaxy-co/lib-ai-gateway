export type Tier = "fast" | "balanced" | "deep";
export type DenyReason = "L1_provider_unavailable" | "L2_authz" | "L3_budget_exhausted" | "L4_circuit_open" | "L5_audit_fatal";
export interface AICallRequest {
    skill: string;
    tier: Tier;
    prompt: string;
    schema?: Record<string, unknown> | null;
    maxOutputTokens?: number;
    metadata?: Record<string, unknown>;
}
export interface AICallResponse {
    outcome: "allow" | "deny";
    denyReason: DenyReason | null;
    text: string | null;
    schemaJson: unknown | null;
    provider: string | null;
    model: string | null;
    tokensIn: number;
    tokensOut: number;
    latencyMs: number;
}
export interface OutcomeRecord {
    ts: string;
    skill: string;
    tier: Tier;
    provider: string | null;
    model: string | null;
    tokensIn: number;
    tokensOut: number;
    outcome: "allow" | "deny";
    denyReason: DenyReason | null;
    latencyMs: number;
}
export interface ProviderPickResult {
    provider: string;
    model: string;
}
declare const _default: {};
export = _default;
//# sourceMappingURL=types.d.ts.map