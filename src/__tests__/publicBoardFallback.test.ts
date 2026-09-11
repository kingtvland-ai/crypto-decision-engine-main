/**
 * Public board URL resolution (2026-09-11)
 * ============================================================================
 * `/live` is the one page anyone with the link can open. It must NOT depend on
 * the operator's own localStorage or on a Netlify build variable that may be
 * unset — both failure modes surfaced as a bare "Failed to fetch" in the
 * browser, with a healthy worker on the other side.
 *
 * So the loader walks a candidate list ending at the hardcoded production
 * worker. These tests pin that order and the fall-through behaviour.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_PUBLIC_WORKER_URL, resolvePublicBoardUrls } from '../services/workerConfig';
import { getPublicBotsSummary } from '../services/tradingApiClient';

const PAYLOAD = { bots: [], serverTime: 123 };
const okResponse = () => ({ ok: true, status: 200, statusText: 'OK', json: async () => PAYLOAD });

// The suite runs on the bare node environment, which has no localStorage.
// workerConfig.ts guards its own access with try/catch, so production code is
// fine either way — but these tests need to SET a saved worker to reproduce the
// bug, so they bring their own store.
const store = new Map<string, string>();
const saveWorker = (baseUrl: string) => store.set('workerConfig', JSON.stringify({ baseUrl }));

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear()
  });
});
afterEach(() => { vi.unstubAllGlobals(); store.clear(); });

describe('resolvePublicBoardUrls', () => {
  it('always ends at the hardcoded production worker', () => {
    const urls = resolvePublicBoardUrls();
    expect(urls[urls.length - 1]).toBe(DEFAULT_PUBLIC_WORKER_URL);
  });

  it('puts the operator-configured worker first, so local dev still wins', () => {
    expect(resolvePublicBoardUrls('http://localhost:3001')).toEqual([
      'http://localhost:3001', DEFAULT_PUBLIC_WORKER_URL
    ]);
  });

  it('prefers a saved localStorage worker over the default', () => {
    saveWorker('https://other.example.com');
    expect(resolvePublicBoardUrls()).toEqual([
      'https://other.example.com', DEFAULT_PUBLIC_WORKER_URL
    ]);
  });

  it('does not list the same worker twice', () => {
    expect(resolvePublicBoardUrls(DEFAULT_PUBLIC_WORKER_URL)).toEqual([DEFAULT_PUBLIC_WORKER_URL]);
  });

  it('yields a usable candidate even with nothing configured anywhere', () => {
    expect(resolvePublicBoardUrls()).not.toHaveLength(0);
  });
});

describe('getPublicBotsSummary fallback', () => {
  it('falls through to the production worker when the saved one is unreachable', async () => {
    // The exact shape of the /live bug: a stale localhost URL that an https
    // page blocks as mixed content, which fetch reports as "Failed to fetch".
    saveWorker('http://localhost:3001');
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    await expect(getPublicBotsSummary()).resolves.toEqual(PAYLOAD);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(`${DEFAULT_PUBLIC_WORKER_URL}/api/public/bots-summary`);
  });

  it('falls through on a non-OK status too, not only a network error', async () => {
    saveWorker('https://stale.example.com');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 502, statusText: 'Bad Gateway' })
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    await expect(getPublicBotsSummary()).resolves.toEqual(PAYLOAD);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not call the fallback when the first worker answers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    await getPublicBotsSummary('https://primary.example.com');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://primary.example.com/api/public/bots-summary');
  });

  it('reports the address that failed, in Hebrew, when every candidate is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(getPublicBotsSummary()).rejects.toThrow(
      new RegExp(`לא ניתן להגיע אל ${DEFAULT_PUBLIC_WORKER_URL}`)
    );
  });

  it('sends no credentials or headers — the endpoint is tokenless by design', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    await getPublicBotsSummary('https://primary.example.com');
    expect(fetchMock.mock.calls[0][1]).toBeUndefined();
  });
});
