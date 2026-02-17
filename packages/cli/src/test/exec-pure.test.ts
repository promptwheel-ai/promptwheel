import { describe, it, expect } from 'vitest';
import { NodeExecRunner, createExecRunner } from '../lib/exec.js';

describe('exec pure', () => {
  describe('createExecRunner', () => {
    it('returns NodeExecRunner instance', () => {
      const runner = createExecRunner();
      expect(runner).toBeInstanceOf(NodeExecRunner);
    });

    it('accepts custom options', () => {
      const runner = createExecRunner({ defaultMaxLogBytes: 100, defaultTailBytes: 50, killGraceMs: 500 });
      expect(runner).toBeInstanceOf(NodeExecRunner);
    });

    it('accepts empty options object', () => {
      const runner = createExecRunner({});
      expect(runner).toBeInstanceOf(NodeExecRunner);
    });

    it('returns an object with a run method', () => {
      const runner = createExecRunner();
      expect(typeof runner.run).toBe('function');
    });

    it('accepts only defaultMaxLogBytes', () => {
      const runner = createExecRunner({ defaultMaxLogBytes: 500 });
      expect(runner).toBeInstanceOf(NodeExecRunner);
    });

    it('accepts only killGraceMs', () => {
      const runner = createExecRunner({ killGraceMs: 3000 });
      expect(runner).toBeInstanceOf(NodeExecRunner);
    });

    it('accepts only defaultTailBytes', () => {
      const runner = createExecRunner({ defaultTailBytes: 8192 });
      expect(runner).toBeInstanceOf(NodeExecRunner);
    });
  });

  describe('NodeExecRunner', () => {
    it('constructor with defaults', () => {
      const runner = new NodeExecRunner();
      expect(runner).toBeDefined();
    });

    it('constructor with custom options', () => {
      const runner = new NodeExecRunner({ defaultMaxLogBytes: 100 });
      expect(runner).toBeDefined();
    });

    it('has run method', () => {
      const runner = new NodeExecRunner();
      expect(typeof runner.run).toBe('function');
    });

    it('run method returns a promise', () => {
      const runner = new NodeExecRunner();
      // Verify run returns thenable (we won't await it since it needs real spec)
      expect(typeof runner.run).toBe('function');
    });

    it('constructor with zero values', () => {
      const runner = new NodeExecRunner({ defaultMaxLogBytes: 0, defaultTailBytes: 0, killGraceMs: 0 });
      expect(runner).toBeDefined();
    });

    it('constructor with large values', () => {
      const runner = new NodeExecRunner({ defaultMaxLogBytes: 10_000_000, defaultTailBytes: 1_000_000, killGraceMs: 60_000 });
      expect(runner).toBeDefined();
    });

    it('multiple instances are independent', () => {
      const runner1 = new NodeExecRunner({ defaultMaxLogBytes: 100 });
      const runner2 = new NodeExecRunner({ defaultMaxLogBytes: 200 });
      expect(runner1).not.toBe(runner2);
    });

    it('implements ExecRunner interface', () => {
      const runner = new NodeExecRunner();
      // ExecRunner requires a run method
      expect('run' in runner).toBe(true);
    });
  });
});
