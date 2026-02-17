import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLogger, silentLogger } from '../lib/logger.js';

describe('createLogger', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('default options: info logs to console.log', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger();
    logger.info('test message');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('default options: debug does NOT log', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger();
    logger.debug('test message');
    expect(spy).not.toHaveBeenCalled();
  });

  it('verbose=true: debug logs to console.log', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger({ verbose: true });
    logger.debug('test message');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('quiet=true: info does NOT log', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger({ quiet: true });
    logger.info('test message');
    expect(spy).not.toHaveBeenCalled();
  });

  it('quiet=true: debug does NOT log', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger({ quiet: true, verbose: true });
    logger.debug('test message');
    expect(spy).not.toHaveBeenCalled();
  });

  it('warn always logs even with quiet', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger({ quiet: true });
    logger.warn('warning message');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('error always logs to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger({ quiet: true });
    logger.error('error message');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('silentLogger', () => {
  it('all methods are no-ops and do not throw', () => {
    expect(() => {
      silentLogger.debug('test');
      silentLogger.info('test');
      silentLogger.warn('test');
      silentLogger.error('test');
    }).not.toThrow();
  });
});
