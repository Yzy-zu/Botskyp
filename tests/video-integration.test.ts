import { describe, it, expect } from 'vitest';
import {
  saveVideoSearchSession,
  getLatestVideoSearchSession,
  findVideoByRef,
  type NormalizedVideoResult,
} from '../src/modules/video/session.js';
import { liveResource } from '../src/core/policy-v2/references.js';
import type { ExecutionContextV2 } from '../src/core/policy-v2/types.js';
import { videoTools, formatDuration } from '../src/modules/video/index.js';

describe('Video module: session and references', () => {
  it('formats duration correctly', () => {
    expect(formatDuration(252)).toBe('4:12');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(undefined)).toBe('0:00');
    expect(formatDuration(3665)).toBe('1:01:05');
  });

  it('manages video search sessions and finds video by ref', async () => {
    const fakeDb: { query: string; params: unknown[] }[] = [];
    const mockResults: NormalizedVideoResult[] = [
      {
        id: 'vid1',
        videoRef: 'vid1',
        title: 'Video Test 1',
        webpageUrl: 'https://dailymotion.com/video/vid1',
        duration: 252,
        provider: 'Dailymotion',
      },
    ];

    const mockClient = {
      query: async (sql: string, params: unknown[]) => {
        fakeDb.push({ query: sql, params });
        if (sql.includes('INSERT INTO video_search_sessions')) {
          return { rows: [{ id: 'session-uuid-1' }], rowCount: 1 };
        }
        if (sql.includes('SELECT id, chat_id, actor_id, query, source, results')) {
          return {
            rows: [
              {
                id: 'session-uuid-1',
                chat_id: 'chat1@g.us',
                actor_id: 'user1@s.whatsapp.net',
                query: 'test query',
                source: 'auto',
                results: mockResults,
                created_at: new Date(),
                expires_at: new Date(Date.now() + 15 * 60_000),
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('SELECT results')) {
          return { rows: [{ results: mockResults }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as import('pg').PoolClient;

    const sessionId = await saveVideoSearchSession(
      mockClient,
      'chat1@g.us',
      'user1@s.whatsapp.net',
      'test query',
      'auto',
      mockResults
    );
    expect(sessionId).toBe('session-uuid-1');

    const session = await getLatestVideoSearchSession(
      mockClient,
      'chat1@g.us',
      'user1@s.whatsapp.net'
    );
    expect(session).toBeDefined();
    expect(session?.query).toBe('test query');
    expect(session?.results).toHaveLength(1);
    expect(session?.results[0]?.title).toBe('Video Test 1');

    const found = await findVideoByRef(
      mockClient,
      'chat1@g.us',
      'user1@s.whatsapp.net',
      'vid1'
    );
    expect(found).toBeDefined();
    expect(found?.title).toBe('Video Test 1');

    const notFound = await findVideoByRef(
      mockClient,
      'chat1@g.us',
      'user1@s.whatsapp.net',
      'vid_unknown'
    );
    expect(notFound).toBeUndefined();
  });

  it('resolves liveResource for videoRef with active session', async () => {
    const mockResults = [
      {
        id: 'vid1',
        videoRef: 'vid1',
        title: 'Video Test 1',
        webpageUrl: 'https://dailymotion.com/video/vid1',
        provider: 'Dailymotion',
      },
    ];

    const mockClient = {
      query: async (sql: string) => {
        if (sql.includes('video_search_sessions')) {
          return { rows: [{ results: mockResults }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };

    const ctx = {
      chatId: 'chat1@g.us',
      actorId: 'user1@s.whatsapp.net',
      legacy: { c: mockClient, config: {} },
    } as unknown as ExecutionContextV2;

    const res = await liveResource(ctx, 'videoRef', 'vid1');
    expect(res).toBeDefined();
    expect(res?.owner_id).toBe('user1@s.whatsapp.net');
    expect(res?.state).toBe('https://dailymotion.com/video/vid1');

    const resNone = await liveResource(ctx, 'videoRef', 'vid_nonexistent');
    expect(resNone).toBeUndefined();
  });

  it('executes video.download and inserts job in queue', async () => {
    const mockResults = [
      {
        id: 'vid1',
        videoRef: 'vid1',
        title: 'Video Test 1',
        webpageUrl: 'https://dailymotion.com/video/vid1',
        duration: 252,
        provider: 'Dailymotion',
      },
    ];

    let insertedPayload: Record<string, unknown> | null = null;

    const downloadTool = videoTools.find(t => t.name === 'video.download')!;
    const ctx = {
      c: {
        query: async (sql: string, params?: unknown[]) => {
          if (sql.includes('SELECT results')) {
            return { rows: [{ results: mockResults }], rowCount: 1 };
          }
          if (sql.includes('INSERT INTO jobs') && params) {
            insertedPayload = JSON.parse(params[0] as string);
            return { rows: [{ id: '999' }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
      },
      chat: { id: 'chat1@g.us' },
      actor: { id: 'user1@s.whatsapp.net' },
      msg: { id: 'msg123' },
    } as unknown as import('../src/core/tools.js').ToolCtx;

    const outcome = await downloadTool.run(ctx, { videoRef: 'vid1', mode: 'video', quality: '720p' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.facts.jobId).toBe('999');
      expect(insertedPayload).not.toBeNull();
      const p = insertedPayload as unknown as Record<string, unknown>;
      expect(p.url).toBe('https://dailymotion.com/video/vid1');
      expect(p.quality).toBe('720p');
      expect(p.mode).toBe('video');
    }
  });
});
