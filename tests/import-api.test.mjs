import test from 'node:test';
import assert from 'node:assert/strict';
import previewHandler from '../api/import/preview.js';
import applyHandler from '../api/import/apply.js';

function responseHarness() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function dataSource(properties = {}) {
  return {
    object: 'data_source',
    id: 'source',
    properties: {
      '생성 경로': { type: 'select', select: { options: [{ id: 'manual', name: '수동', color: 'gray' }] } },
      ...properties
    }
  };
}

test('가져오기 API는 미리보기에서 쓰지 않고 승인된 적용에서만 후보 페이지를 만든다', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    NOTION_TOKEN: process.env.NOTION_TOKEN,
    NOTION_PAPERS_DATA_SOURCE_ID: process.env.NOTION_PAPERS_DATA_SOURCE_ID,
    NOTION_CONCEPTS_DATA_SOURCE_ID: process.env.NOTION_CONCEPTS_DATA_SOURCE_ID,
    NOTION_RELATIONS_DATA_SOURCE_ID: process.env.NOTION_RELATIONS_DATA_SOURCE_ID,
    ROADMAP_WRITE_KEY: process.env.ROADMAP_WRITE_KEY
  };
  Object.assign(process.env, {
    NOTION_TOKEN: 'test-token',
    NOTION_PAPERS_DATA_SOURCE_ID: 'papers',
    NOTION_CONCEPTS_DATA_SOURCE_ID: 'concepts',
    NOTION_RELATIONS_DATA_SOURCE_ID: 'relations',
    ROADMAP_WRITE_KEY: 'test-write-key'
  });
  const createdPapers = [];
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const method = options.method || 'GET';
    requests.push({ path, method, body: options.body ? JSON.parse(options.body) : null });
    if (path === '/v1/data_sources/papers/query') return Response.json({ results: createdPapers, has_more: false, next_cursor: null });
    if (path === '/v1/data_sources/concepts/query' || path === '/v1/data_sources/relations/query') return Response.json({ results: [], has_more: false, next_cursor: null });
    if (path === '/v1/data_sources/papers') return Response.json(dataSource());
    if (path === '/v1/data_sources/concepts') return Response.json(dataSource({
      분야: { type: 'multi_select', multi_select: { options: [] } },
      별칭: { type: 'multi_select', multi_select: { options: [] } }
    }));
    if (path === '/v1/data_sources/relations') return Response.json(dataSource());
    if (path.startsWith('/v1/data_sources/') && method === 'PATCH') return Response.json(dataSource());
    if (path === '/v1/pages' && method === 'POST') {
      const body = JSON.parse(options.body);
      const page = {
        id: `00000000-0000-4000-8000-${String(createdPapers.length + 1).padStart(12, '0')}`,
        url: `https://www.notion.so/paper-${createdPapers.length + 1}`,
        properties: body.properties
      };
      createdPapers.push(page);
      assert.ok(body.children.length > 3);
      assert.equal(body.properties['검증 상태'].select.name, '후보');
      assert.equal(body.properties['생성 경로'].select.name, 'Notion Agent');
      return Response.json(page);
    }
    return new Response('not found', { status: 404 });
  };

  try {
    const previewResponse = responseHarness();
    await previewHandler({ method: 'POST', headers: { 'x-roadmap-write-key': 'test-write-key' }, body: { scope: 'nodes', nodeIds: ['rl-ppo'] } }, previewResponse);
    assert.equal(previewResponse.statusCode, 200);
    assert.equal(previewResponse.body.preview.counts.concepts, 1);
    assert.equal(previewResponse.body.preview.counts.relations, 0);
    assert.equal(createdPapers.length, 0);
    assert.equal(requests.some((request) => request.method === 'PATCH' || request.path === '/v1/pages'), false);

    requests.length = 0;
    const applyResponse = responseHarness();
    await applyHandler({
      method: 'POST',
      headers: { 'x-roadmap-write-key': 'test-write-key' },
      body: {
        batchId: previewResponse.body.batchId,
        approvalToken: previewResponse.body.approvalToken,
        phase: 'papers',
        cursor: 0
      }
    }, applyResponse);
    assert.equal(applyResponse.statusCode, 200);
    assert.equal(createdPapers.length, 2);
    assert.deepEqual(applyResponse.body.next, { done: false, phase: 'concepts', cursor: 0 });
    assert.ok(requests.some((request) => request.method === 'PATCH'));
    assert.equal(applyResponse.body.results.every((result) => result.status === '후보'), true);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
