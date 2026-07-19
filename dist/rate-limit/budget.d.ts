interface ReserveResult {
    ok: boolean;
    reason?: string;
    reservationId?: string;
}
declare function reserve(skill: string, estimatedTokens: number, dailyTokenQuota: number): Promise<ReserveResult>;
declare function commit(reservationId: string, actualTokens: number): Promise<void>;
declare function refund(reservationId: string): Promise<void>;
declare function _reset(): void;
declare function _spent(skill: string): number;
declare const _default: {
    reserve: typeof reserve;
    commit: typeof commit;
    refund: typeof refund;
    _reset: typeof _reset;
    _spent: typeof _spent;
    WINDOW_MS: number;
};
export = _default;
//# sourceMappingURL=budget.d.ts.map