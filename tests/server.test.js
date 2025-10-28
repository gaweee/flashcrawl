process.env.NODE_ENV = 'test';
process.env.ENABLE_CONSOLE_LOG = 'false';

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

let app;

beforeAll(async () => {
  ({ app } = await import('../server.js'));
});

describe('flashcrawl API basics', () => {
  it('returns status snapshot', async () => {
    const res = await request(app).get('/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      uptimeSeconds: expect.any(Number),
      totalCrawls: expect.any(Number),
      successfulCrawls: expect.any(Number),
      failedCrawls: expect.any(Number),
      spinnerStatus: expect.any(String),
    });
  });

  it('rejects crawl requests without url', async () => {
    const res = await request(app).get('/crawl');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'Missing url query parameter');
  });

  it('rejects crawl requests with invalid URL', async () => {
    const res = await request(app).get('/crawl').query({ url: 'not-a-url' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'Invalid URL');
  });

  it('rejects PDF conversions without a file', async () => {
    const res = await request(app).post('/convert');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'No file provided');
  });
});
