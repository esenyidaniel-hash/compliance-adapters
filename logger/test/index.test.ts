/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

import { consoleLogger, noopLogger, createLeveledLogger } from '../src/index';

// ---------------------------------------------------------------------------
// consoleLogger
// ---------------------------------------------------------------------------

describe('consoleLogger', () => {
  let debugSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => undefined);
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('forwards debug() to console.debug with the exact arguments', () => {
    consoleLogger.debug('debug message', { key: 'value' });
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith('debug message', { key: 'value' });
  });

  it('forwards info() to console.info with the exact arguments', () => {
    consoleLogger.info('info message', 42);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith('info message', 42);
  });

  it('forwards warn() to console.warn with the exact arguments', () => {
    consoleLogger.warn('warn message', [1, 2, 3]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('warn message', [1, 2, 3]);
  });

  it('forwards error() to console.error with the exact arguments', () => {
    const err = new Error('boom');
    consoleLogger.error('error message', err);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('error message', err);
  });

  it('forwards multiple variadic arguments correctly', () => {
    consoleLogger.info('a', 'b', 'c', 'd');
    expect(infoSpy).toHaveBeenCalledWith('a', 'b', 'c', 'd');
  });

  it('does not cross-call other console methods when debug() is called', () => {
    consoleLogger.debug('only debug');
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('does not cross-call other console methods when error() is called', () => {
    consoleLogger.error('only error');
    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// noopLogger
// ---------------------------------------------------------------------------

describe('noopLogger', () => {
  let debugSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => undefined);
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('debug() does not throw', () => {
    expect(() => noopLogger.debug('anything', { x: 1 })).not.toThrow();
  });

  it('info() does not throw', () => {
    expect(() => noopLogger.info('anything', 123)).not.toThrow();
  });

  it('warn() does not throw', () => {
    expect(() => noopLogger.warn('anything')).not.toThrow();
  });

  it('error() does not throw', () => {
    expect(() => noopLogger.error('anything', new Error('e'))).not.toThrow();
  });

  it('debug() produces no console output', () => {
    noopLogger.debug('silent');
    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('info() produces no console output', () => {
    noopLogger.info('silent');
    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('warn() produces no console output', () => {
    noopLogger.warn('silent');
    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('error() produces no console output', () => {
    noopLogger.error('silent');
    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('returns undefined from every method', () => {
    expect(noopLogger.debug('x')).toBeUndefined();
    expect(noopLogger.info('x')).toBeUndefined();
    expect(noopLogger.warn('x')).toBeUndefined();
    expect(noopLogger.error('x')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createLeveledLogger
// ---------------------------------------------------------------------------

describe('createLeveledLogger', () => {
  const levels = ['debug', 'info', 'warn', 'error'] as const;

  function makeSpyLogger() {
    return {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
  }

  it('returns a new Logger object and does not mutate the base logger', () => {
    const base = makeSpyLogger();
    const leveled = createLeveledLogger(base, 'info');
    expect(leveled).not.toBe(base);
    // calling leveled must not have touched base yet
    expect(base.debug).not.toHaveBeenCalled();
  });

  it('forwards all levels when minLevel is "debug"', () => {
    const base = makeSpyLogger();
    const leveled = createLeveledLogger(base, 'debug');
    leveled.debug('d');
    leveled.info('i');
    leveled.warn('w');
    leveled.error('e');
    expect(base.debug).toHaveBeenCalledWith('d');
    expect(base.info).toHaveBeenCalledWith('i');
    expect(base.warn).toHaveBeenCalledWith('w');
    expect(base.error).toHaveBeenCalledWith('e');
  });

  it('suppresses debug when minLevel is "info"', () => {
    const base = makeSpyLogger();
    const leveled = createLeveledLogger(base, 'info');
    leveled.debug('should be suppressed');
    expect(base.debug).not.toHaveBeenCalled();
  });

  it('forwards info, warn, error when minLevel is "info"', () => {
    const base = makeSpyLogger();
    const leveled = createLeveledLogger(base, 'info');
    leveled.info('i');
    leveled.warn('w');
    leveled.error('e');
    expect(base.info).toHaveBeenCalledWith('i');
    expect(base.warn).toHaveBeenCalledWith('w');
    expect(base.error).toHaveBeenCalledWith('e');
  });

  it('suppresses debug and info when minLevel is "warn"', () => {
    const base = makeSpyLogger();
    const leveled = createLeveledLogger(base, 'warn');
    leveled.debug('d');
    leveled.info('i');
    expect(base.debug).not.toHaveBeenCalled();
    expect(base.info).not.toHaveBeenCalled();
  });

  it('forwards warn and error when minLevel is "warn"', () => {
    const base = makeSpyLogger();
    const leveled = createLeveledLogger(base, 'warn');
    leveled.warn('w');
    leveled.error('e');
    expect(base.warn).toHaveBeenCalledWith('w');
    expect(base.error).toHaveBeenCalledWith('e');
  });

  it('suppresses debug, info, warn when minLevel is "error"', () => {
    const base = makeSpyLogger();
    const leveled = createLeveledLogger(base, 'error');
    leveled.debug('d');
    leveled.info('i');
    leveled.warn('w');
    expect(base.debug).not.toHaveBeenCalled();
    expect(base.info).not.toHaveBeenCalled();
    expect(base.warn).not.toHaveBeenCalled();
  });

  it('forwards only error when minLevel is "error"', () => {
    const base = makeSpyLogger();
    const leveled = createLeveledLogger(base, 'error');
    leveled.error('e');
    expect(base.error).toHaveBeenCalledWith('e');
  });

  it('passes multiple variadic arguments through to the base logger', () => {
    const base = makeSpyLogger();
    const leveled = createLeveledLogger(base, 'debug');
    leveled.info('msg', { context: true }, 42);
    expect(base.info).toHaveBeenCalledWith('msg', { context: true }, 42);
  });

  it('works with noopLogger as the base (no throws at any level)', () => {
    const leveled = createLeveledLogger(noopLogger, 'warn');
    expect(() => {
      leveled.debug('d');
      leveled.info('i');
      leveled.warn('w');
      leveled.error('e');
    }).not.toThrow();
  });

  it('each minLevel suppresses exactly the levels below it', () => {
    const levelRank = { debug: 0, info: 1, warn: 2, error: 3 };
    for (const minLevel of levels) {
      const base = makeSpyLogger();
      const leveled = createLeveledLogger(base, minLevel);
      for (const level of levels) {
        leveled[level](level);
      }
      for (const level of levels) {
        if (levelRank[level] >= levelRank[minLevel]) {
          expect(base[level]).toHaveBeenCalledWith(level);
        } else {
          expect(base[level]).not.toHaveBeenCalled();
        }
      }
    }
  });
});
