import { errorDetail } from './util.js';

describe('errorDetail', () => {
  test('reports an Error by its message', () => {
    expect(errorDetail(new Error('boom'))).toBe('boom');
  });

  test('stringifies a non-Error rather than printing [object Object]', () => {
    expect(errorDetail('boom')).toBe('boom');
    expect(errorDetail(42)).toBe('42');
  });

  test('has nothing to add for an absent or empty cause', () => {
    expect(errorDetail(undefined)).toBeUndefined();
    expect(errorDetail(null)).toBeUndefined();
    expect(errorDetail(new Error(''))).toBeUndefined();
  });
});
