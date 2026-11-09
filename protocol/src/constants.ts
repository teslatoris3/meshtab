export const PROTOCOL_TAG = 'MT1';
export const CURRENCY = 'USD';
/** Largest single offline voucher, in cents. Limits the loss from one double-spend. */
export const MAX_VOUCHER_CENTS = 5_000;
/** Largest memo, in UTF-8 bytes. */
export const MAX_MEMO_BYTES = 64;
/** A voucher time more than this far in the future is suspicious (clock skew allowance). */
export const FUTURE_SKEW_MS = 10 * 60 * 1000;
