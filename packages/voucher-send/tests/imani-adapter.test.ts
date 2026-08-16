import { describe, it, expect, vi } from 'vitest';
import { ImaniApiAdapter } from '../src/integrations/imani/ImaniApiAdapter';

describe('ImaniApiAdapter.splitExecute', () => {
  it('does not synthesize SAT currency metadata when the backend omits it', async () => {
    const gatewayApi = {
      splitPreview: vi.fn(),
      splitExecute: vi.fn().mockResolvedValue({
        send_token: 'cashuAsend...',
        keep_token: 'cashuAkeep...',
        send_face_value: 500,
        keep_face_value: 500,
        send_token_amount: 500,
        keep_token_amount: 500,
        rounding_applied: false,
      }),
      sendTokenDm: vi.fn(),
      getProfile: vi.fn(),
    };
    const adapter = new ImaniApiAdapter({ api: gatewayApi });

    const result = await adapter.splitExecute('cashuAtest...', 500, 'memo');

    expect(result.sendToken).toBe('cashuAsend...');
    expect(result.keepToken).toBe('cashuAkeep...');
    expect(result.faceUnit).toBeUndefined();
    expect(result.faceDecimals).toBeUndefined();
    expect(result.issuerId).toBeUndefined();
    expect(result.backingStrategy).toBeUndefined();
  });
});
