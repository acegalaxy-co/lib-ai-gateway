"use strict";

export type Tier = "fast" | "balanced" | "deep";

export type DenyReason =
  | "L1_provider_unavailable"
  | "L2_authz"
  | "L3_budget_exhausted"
  | "L4_circuit_open"
  | "L5_audit_fatal";

export interface AICallRequest {
  skill: string;                    // e.g. "invoice-enrich.summarize"
  tier: Tier;
  prompt: string;
  schema?: Record<string, unknown> | null;
  maxOutputTokens?: number;         // hard cap per call; budget guard may lower it
  metadata?: Record<string, unknown>;
}

export interface AICallResponse {
  outcome: "allow" | "deny";
  denyReason: DenyReason | null;
  text: string | null;
  schemaJson: unknown | null;
  provider: string | null;          // e.g. "anthropic-api"
  model: string | null;             // e.g. "claude-opus-4-7"
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

export interface OutcomeRecord {
  ts: string;                       // ISO
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

// @ts-expect-error — TS migration: type unverified, fix when polishing
export = {};
