import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicBatchScoutBackend } from '../scout/anthropic-batch-runner.js';

/**
 * Mock Anthropic client factory.
 * Returns a mock client and the functions that control its behavior.
 */
function createMockClient() {
  const mockCreate = vi.fn();
  const mockRetrieve = vi.fn();
  const mockResults = vi.fn();
  const mockCancel = vi.fn();
  const mockMessagesCreate = vi.fn();

  const client = {
    messages: {
      create: mockMessagesCreate,
      batches: {
        create: mockCreate,
        retrieve: mockRetrieve,
        results: mockResults,
        cancel: mockCancel,
      },
    },
  };

  return { client, mockCreate, mockRetrieve, mockResults, mockCancel, mockMessagesCreate };
}

/**
 * Inject a mock client into the backend (bypasses dynamic import).
 */
function injectClient(backend: AnthropicBatchScoutBackend, client: ReturnType<typeof createMockClient>['client']) {
  // Access private field via bracket notation
  (backend as unknown as { client: unknown }).client = client;
}

describe('AnthropicBatchScoutBackend', () => {
  let backend: AnthropicBatchScoutBackend;
  let mock: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    backend = new AnthropicBatchScoutBackend({ apiKey: 'test-key', model: 'claude-sonnet-4-20250514' });
    mock = createMockClient();
    injectClient(backend, mock.client);
  });

  describe('run() — single-batch fallback', () => {
    it('calls messages.create and returns output', async () => {
      mock.mockMessagesCreate.mockResolvedValue({
        content: [{ type: 'text', text: '{"proposals": []}' }],
      });

      const result = await backend.run({
        prompt: 'test prompt',
        cwd: '/tmp',
        timeoutMs: 0,
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe('{"proposals": []}');
      expect(mock.mockMessagesCreate).toHaveBeenCalledWith({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 16384,
        messages: [{ role: 'user', content: 'test prompt' }],
      });
    });

    it('returns error on API failure', async () => {
      mock.mockMessagesCreate.mockRejectedValue(new Error('Rate limited'));

      const result = await backend.run({
        prompt: 'test prompt',
        cwd: '/tmp',
        timeoutMs: 0,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Rate limited');
    });

    it('returns early when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await backend.run({
        prompt: 'test prompt',
        cwd: '/tmp',
        timeoutMs: 0,
        signal: controller.signal,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Aborted before start');
      expect(mock.mockMessagesCreate).not.toHaveBeenCalled();
    });
  });

  describe('runAll() — batch API path', () => {
    it('delegates to run() for a single-item batch', async () => {
      mock.mockMessagesCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'output-0' }],
      });

      const results = await backend.runAll!([
        { prompt: 'prompt-0', cwd: '/tmp', timeoutMs: 0 },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].output).toBe('output-0');
      // Should NOT call batch create for single item
      expect(mock.mockCreate).not.toHaveBeenCalled();
    });

    it('submits batch, polls, and maps results correctly', async () => {
      // Batch create returns a batch ID
      mock.mockCreate.mockResolvedValue({
        id: 'batch-abc123',
        processing_status: 'in_progress',
      });

      // First poll returns in_progress, second returns ended
      mock.mockRetrieve
        .mockResolvedValueOnce({ id: 'batch-abc123', processing_status: 'in_progress' })
        .mockResolvedValueOnce({ id: 'batch-abc123', processing_status: 'ended' });

      // Results returns entries out of order
      mock.mockResults.mockResolvedValue(
        (async function* () {
          yield {
            custom_id: 'batch-1',
            result: {
              type: 'succeeded',
              message: { content: [{ type: 'text', text: 'result-for-1' }] },
            },
          };
          yield {
            custom_id: 'batch-0',
            result: {
              type: 'succeeded',
              message: { content: [{ type: 'text', text: 'result-for-0' }] },
            },
          };
          yield {
            custom_id: 'batch-2',
            result: {
              type: 'succeeded',
              message: { content: [{ type: 'text', text: 'result-for-2' }] },
            },
          };
        })(),
      );

      const results = await backend.runAll!([
        { prompt: 'p0', cwd: '/tmp', timeoutMs: 0 },
        { prompt: 'p1', cwd: '/tmp', timeoutMs: 0 },
        { prompt: 'p2', cwd: '/tmp', timeoutMs: 0 },
      ]);

      expect(results).toHaveLength(3);
      // Results should be mapped back in order despite out-of-order delivery
      expect(results[0].success).toBe(true);
      expect(results[0].output).toBe('result-for-0');
      expect(results[1].success).toBe(true);
      expect(results[1].output).toBe('result-for-1');
      expect(results[2].success).toBe(true);
      expect(results[2].output).toBe('result-for-2');

      // Verify batch creation payload
      expect(mock.mockCreate).toHaveBeenCalledWith({
        requests: [
          { custom_id: 'batch-0', params: { model: 'claude-sonnet-4-20250514', max_tokens: 16384, messages: [{ role: 'user', content: 'p0' }] } },
          { custom_id: 'batch-1', params: { model: 'claude-sonnet-4-20250514', max_tokens: 16384, messages: [{ role: 'user', content: 'p1' }] } },
          { custom_id: 'batch-2', params: { model: 'claude-sonnet-4-20250514', max_tokens: 16384, messages: [{ role: 'user', content: 'p2' }] } },
        ],
      });
    });

    it('handles partial failures (errored, canceled, expired)', async () => {
      mock.mockCreate.mockResolvedValue({
        id: 'batch-xyz',
        processing_status: 'in_progress',
      });

      mock.mockRetrieve.mockResolvedValue({
        id: 'batch-xyz',
        processing_status: 'ended',
      });

      mock.mockResults.mockResolvedValue(
        (async function* () {
          yield {
            custom_id: 'batch-0',
            result: {
              type: 'succeeded',
              message: { content: [{ type: 'text', text: 'ok' }] },
            },
          };
          yield {
            custom_id: 'batch-1',
            result: {
              type: 'errored',
              error: { message: 'context_length_exceeded' },
            },
          };
          yield {
            custom_id: 'batch-2',
            result: { type: 'expired' },
          };
        })(),
      );

      const results = await backend.runAll!([
        { prompt: 'p0', cwd: '/tmp', timeoutMs: 0 },
        { prompt: 'p1', cwd: '/tmp', timeoutMs: 0 },
        { prompt: 'p2', cwd: '/tmp', timeoutMs: 0 },
      ]);

      expect(results[0].success).toBe(true);
      expect(results[0].output).toBe('ok');

      expect(results[1].success).toBe(false);
      expect(results[1].error).toBe('context_length_exceeded');

      expect(results[2].success).toBe(false);
      expect(results[2].error).toBe('Batch request expired');
    });

    it('handles batch creation failure', async () => {
      mock.mockCreate.mockRejectedValue(new Error('Insufficient credits'));

      const results = await backend.runAll!([
        { prompt: 'p0', cwd: '/tmp', timeoutMs: 0 },
        { prompt: 'p1', cwd: '/tmp', timeoutMs: 0 },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('Batch creation failed');
      expect(results[1].success).toBe(false);
    });

    it('fills missing results with error', async () => {
      mock.mockCreate.mockResolvedValue({
        id: 'batch-partial',
        processing_status: 'in_progress',
      });

      mock.mockRetrieve.mockResolvedValue({
        id: 'batch-partial',
        processing_status: 'ended',
      });

      // Only return result for batch-0, skip batch-1
      mock.mockResults.mockResolvedValue(
        (async function* () {
          yield {
            custom_id: 'batch-0',
            result: {
              type: 'succeeded',
              message: { content: [{ type: 'text', text: 'got-it' }] },
            },
          };
        })(),
      );

      const results = await backend.runAll!([
        { prompt: 'p0', cwd: '/tmp', timeoutMs: 0 },
        { prompt: 'p1', cwd: '/tmp', timeoutMs: 0 },
      ]);

      expect(results[0].success).toBe(true);
      expect(results[0].output).toBe('got-it');
      expect(results[1].success).toBe(false);
      expect(results[1].error).toBe('No result returned for batch');
    });

    it('returns early when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const results = await backend.runAll!([
        { prompt: 'p0', cwd: '/tmp', timeoutMs: 0, signal: controller.signal },
        { prompt: 'p1', cwd: '/tmp', timeoutMs: 0, signal: controller.signal },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toBe('Aborted before start');
      expect(mock.mockCreate).not.toHaveBeenCalled();
    });

    it('cancels batch when abort signal fires during polling', async () => {
      const controller = new AbortController();

      mock.mockCreate.mockResolvedValue({
        id: 'batch-abort',
        processing_status: 'in_progress',
      });

      // Polling will be interrupted by abort
      mock.mockRetrieve.mockImplementation(async () => {
        // Abort during first poll
        controller.abort();
        return { id: 'batch-abort', processing_status: 'in_progress' };
      });

      mock.mockCancel.mockResolvedValue({});

      const results = await backend.runAll!([
        { prompt: 'p0', cwd: '/tmp', timeoutMs: 0, signal: controller.signal },
        { prompt: 'p1', cwd: '/tmp', timeoutMs: 0, signal: controller.signal },
      ]);

      expect(results[0].success).toBe(false);
      expect(results[0].error).toBe('Aborted by signal');
      expect(mock.mockCancel).toHaveBeenCalledWith('batch-abort');
    });
  });

  describe('name property', () => {
    it('returns anthropic-batch', () => {
      expect(backend.name).toBe('anthropic-batch');
    });
  });

  describe('constructor defaults', () => {
    it('defaults to claude-sonnet-4-20250514', () => {
      const b = new AnthropicBatchScoutBackend();
      expect((b as unknown as { model: string }).model).toBe('claude-sonnet-4-20250514');
    });

    it('accepts custom model', () => {
      const b = new AnthropicBatchScoutBackend({ model: 'claude-opus-4-20250514' });
      expect((b as unknown as { model: string }).model).toBe('claude-opus-4-20250514');
    });
  });
});
