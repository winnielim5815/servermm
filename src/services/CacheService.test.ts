import { flushCache, getCache, invalidateCacheByPrefix, setCache } from './CacheService';

describe('invalidateCacheByPrefix', () => {
  beforeEach(() => flushCache());
  afterEach(() => flushCache());

  it('invalidates every matching game cache without touching unrelated entries', () => {
    setCache('games_context_v3:7:1:m1:b1:a1', { stale: true });
    setCache('game_detail_v2:7:1:10:b1:a1', { stale: true });
    setCache('games_context_v3:8:1:m1:b1:a1', { keep: true });

    invalidateCacheByPrefix(['games_context_v3:7:', 'game_detail_v2:7:']);

    expect(getCache('games_context_v3:7:1:m1:b1:a1')).toBeUndefined();
    expect(getCache('game_detail_v2:7:1:10:b1:a1')).toBeUndefined();
    expect(getCache('games_context_v3:8:1:m1:b1:a1')).toEqual({ keep: true });
  });
});
