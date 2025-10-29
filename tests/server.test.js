process.env.NODE_ENV = 'test';
process.env.ENABLE_CONSOLE_LOG = 'false';

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

let app;

beforeAll(async () => {
  ({ app } = await import('../server.js'));
});

describe('flashcrawl API basics', () => {
  it('root returns OK', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'OK' });
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

  it('does not expose the legacy /convert endpoint', async () => {
    const res = await request(app).post('/convert');
    expect(res.status).toBe(404);
  });
});
