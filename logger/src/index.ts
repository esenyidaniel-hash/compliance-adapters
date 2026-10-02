/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

/**
 * Minimal structured-logging interface shared across all compliance-adapter
 * packages.  Any object that satisfies this shape — console, pino, winston,
 * a test spy, etc. — can be injected wherever a `Logger` is accepted.
 *
 * The variadic `...args: unknown[]` signature intentionally matches the
 * `console.*` family so consumers can pass `console` directly without
 * wrapping it.
 */
export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Default logger that delegates to the global `console`.
 * Suitable for production use when no custom logger is provided.
 */
export const consoleLogger: Logger = {
  debug: (...args: unknown[]) => console.debug(...args),
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};

/**
 * No-op logger that silences all output.
 * Useful in tests that don't want to assert on log output, or in
 * consumers that manage their own logging pipeline externally.
 */
export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * The four log levels supported by {@link createLeveledLogger}, ordered from
 * least to most severe.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Numeric rank used to compare log levels. Higher = more severe. */
const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Wraps a base {@link Logger} and silences any call whose level is below
 * `minLevel`.  Calls at or above `minLevel` are forwarded to the base logger
 * unchanged.
 *
 * This fills the gap between {@link consoleLogger} (emits everything) and
 * {@link noopLogger} (emits nothing), letting operators configure a minimum
 * severity without having to write a custom Logger object from scratch.
 *
 * @example
 * ```ts
 * // Emit info, warn, and error; suppress debug in production.
 * const logger = createLeveledLogger(consoleLogger, process.env.LOG_LEVEL ?? 'info');
 * ```
 *
 * @param base     The underlying logger to delegate to when the level passes.
 * @param minLevel The minimum level to emit.  Calls below this level are no-ops.
 * @returns        A new Logger instance; the `base` logger is never mutated.
 */
export function createLeveledLogger(base: Logger, minLevel: LogLevel): Logger {
  const minRank = LOG_LEVEL_RANK[minLevel];
  return {
    debug: (...args: unknown[]) => {
      if (LOG_LEVEL_RANK.debug >= minRank) base.debug(...args);
    },
    info: (...args: unknown[]) => {
      if (LOG_LEVEL_RANK.info >= minRank) base.info(...args);
    },
    warn: (...args: unknown[]) => {
      if (LOG_LEVEL_RANK.warn >= minRank) base.warn(...args);
    },
    error: (...args: unknown[]) => {
      if (LOG_LEVEL_RANK.error >= minRank) base.error(...args);
    },
  };
}
