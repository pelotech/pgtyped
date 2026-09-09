import { verifyConnection } from './type-db.js';

describe('verifyConnection', () => {
  test('releases the client it checked out', async () => {
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ release })) };

    await verifyConnection(pool as never);

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('rejects with the connection failure', async () => {
    const pool = {
      connect: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
          code: 'ECONNREFUSED',
        });
      },
    };

    await expect(verifyConnection(pool as never)).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });
});
