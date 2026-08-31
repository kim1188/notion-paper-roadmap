import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNotionConcept,
  findConceptMatches,
  mapNotionRoadmap,
  normalizeConceptTerm,
  normalizeDoi
} from '../lib/notion-roadmap.mjs';

const rich = (type, value) => ({ type, [type]: value ? [{ plain_text: value }] : [] });
const select = (name) => ({ type: 'select', select: name ? { name } : null });
const multi = (names) => ({ type: 'multi_select', multi_select: names.map((name) => ({ name })) });
const relation = (ids) => ({ type: 'relation', relation: ids.map((id) => ({ id })) });

function paper(id, { title, status = '승인' }) {
  return {
    id,
    url: `https://www.notion.so/${id}`,
    last_edited_time: '2026-08-27T00:00:00.000Z',
    properties: {
      논문명: rich('title', title),
      요약: rich('rich_text', `${title} 요약`),
      '검증 상태': select(status),
      '핵심 개념': relation([])
    }
  };
}

function concept(id, { title, aliases = [], domains, summary, papers = [], status = '승인', positions = {} }) {
  return {
    id,
    url: `https://www.notion.so/${id}`,
    last_edited_time: '2026-08-27T00:00:00.000Z',
    properties: {
      개념명: rich('title', title),
      별칭: multi(aliases),
      분야: multi(domains),
      설명: rich('rich_text', summary),
      '연결 논문': relation(papers),
      '검증 상태': select(status),
      '중복 검사 상태': select('일치 없음'),
      '그래프 위치': rich('rich_text', JSON.stringify(positions))
    }
  };
}

function edge(id, { source, target, type = '확장', papers = [], status = '승인' }) {
  return {
    id,
    url: `https://www.notion.so/${id}`,
    properties: {
      관계명: rich('title', `${source} → ${target}`),
      '출발 개념': relation([source]),
      '도착 개념': relation([target]),
      '관계 유형': select(type),
      '근거 논문': relation(papers),
      '관계 설명': rich('rich_text', '관계 설명'),
      '검증 상태': select(status),
      '포털 위치': rich('rich_text', '{}')
    }
  };
}

const dataSource = {
  properties: {
    분야: {
      type: 'multi_select',
      multi_select: {
        options: [
          { id: 'deep-id', name: 'AI 딥러닝', color: 'blue' },
          { id: 'medical-id', name: '의료 AI', color: 'red' }
        ]
      }
    }
  }
};

test('3개 DB를 복수 분야 노드와 방향성 관계로 변환한다', () => {
  const snapshot = mapNotionRoadmap({
    conceptDataSource: dataSource,
    paperPages: [paper('paper-a', { title: 'Attention' }), paper('paper-b', { title: 'Medical AI' })],
    conceptPages: [
      concept('concept-a', {
        title: 'Transformer',
        aliases: ['트랜스포머'],
        domains: ['AI 딥러닝', '의료 AI'],
        summary: '기반 구조',
        papers: ['paper-a', 'paper-b'],
        positions: { all: { x: 100, y: 120 } }
      }),
      concept('concept-b', {
        title: 'Medical VLM',
        domains: ['의료 AI'],
        summary: '의료 응용',
        papers: ['paper-b']
      })
    ],
    relationPages: [edge('edge-a', { source: 'concept-a', target: 'concept-b', type: '응용', papers: ['paper-b'] })],
    databaseUrl: 'https://www.notion.so/atlas'
  });

  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.nodes.length, 2);
  assert.equal(snapshot.nodes[0].domains.length, 2);
  assert.equal(snapshot.nodes[0].papers.length, 2);
  assert.equal(snapshot.nodes[0].positions.all.x, 100);
  assert.equal(snapshot.edges.length, 1);
  assert.equal(snapshot.edges[0].type, 'applies_to');
  assert.equal(snapshot.edges[0].paper, 'Medical AI');
});

test('후보 데이터는 기본 응답에서 숨기고 관리자 응답에서만 포함한다', () => {
  const input = {
    conceptDataSource: dataSource,
    paperPages: [paper('paper-a', { title: 'Approved' }), paper('paper-c', { title: 'Candidate', status: '후보' })],
    conceptPages: [
      concept('concept-a', { title: 'Approved concept', domains: ['AI 딥러닝'], summary: '승인', papers: ['paper-a'] }),
      concept('concept-c', { title: 'Candidate concept', domains: ['AI 딥러닝'], summary: '후보', papers: ['paper-c'], status: '후보' })
    ],
    relationPages: [edge('edge-c', { source: 'concept-a', target: 'concept-c', papers: ['paper-c'], status: '후보' })]
  };
  const publicSnapshot = mapNotionRoadmap(input);
  const adminSnapshot = mapNotionRoadmap({ ...input, includeCandidates: true });

  assert.deepEqual(publicSnapshot.nodes.map((node) => node.id), ['concept-a']);
  assert.equal(publicSnapshot.edges.length, 0);
  assert.equal(adminSnapshot.nodes.length, 2);
  assert.equal(adminSnapshot.edges.length, 1);
  assert.equal(adminSnapshot.nodes.find((node) => node.id === 'concept-c').status, '후보');
});

test('표준명이나 별칭이 같으면 SAME 후보로 정확히 찾는다', () => {
  const result = findConceptMatches({
    title: 'VLP',
    summary: '이미지와 언어를 함께 사전학습한다.',
    concepts: [{
      id: 'vlp',
      url: 'https://www.notion.so/vlp',
      title: 'Vision-Language Pretraining',
      aliases: ['VLP', '시각-언어 사전학습'],
      domainNames: ['AI 딥러닝'],
      summary: '이미지와 언어를 함께 사전학습하는 방법.',
      status: '승인'
    }]
  });
  assert.equal(result.exact?.id, 'vlp');
  assert.equal(result.reviewRequired, false);
  assert.equal(result.matches[0].matchType, 'exact_name_or_alias');
});

test('관련 있지만 별도인 Transformer와 Vision Transformer를 자동 중복 처리하지 않는다', () => {
  const result = findConceptMatches({
    title: 'Vision Transformer',
    summary: '이미지 패치를 처리하는 비전 모델',
    concepts: [{
      id: 'transformer',
      title: 'Transformer',
      aliases: ['트랜스포머'],
      domainNames: ['AI 딥러닝'],
      summary: '토큰 관계를 Attention으로 학습하는 구조',
      status: '승인'
    }]
  });
  assert.equal(result.exact, null);
  assert.equal(result.reviewRequired, false);
});

test('철자 변형은 자동 생성하지 않고 검토 대상으로 올린다', () => {
  const result = findConceptMatches({
    title: 'Transformers',
    concepts: [{ id: 'transformer', title: 'Transformer', aliases: [], domainNames: ['AI 딥러닝'], summary: '', status: '승인' }]
  });
  assert.equal(result.exact, null);
  assert.equal(result.reviewRequired, true);
});

test('개념명과 DOI를 비교 가능한 값으로 정규화한다', () => {
  assert.equal(normalizeConceptTerm('Actor–Critic'), 'actor critic');
  assert.equal(normalizeConceptTerm('  시각-언어   사전학습 '), '시각 언어 사전학습');
  assert.equal(normalizeDoi('https://doi.org/10.1000/ABC'), '10.1000/abc');
});

test('동시 개념 생성 요청은 직렬화하고 두 번째 요청을 중복으로 차단한다', async () => {
  const originalFetch = globalThis.fetch;
  const createdPages = [];
  let createCount = 0;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === '/v1/data_sources/concepts/query') {
      return Response.json({ results: createdPages, has_more: false, next_cursor: null });
    }
    if (path === '/v1/data_sources/concepts') {
      return Response.json({ properties: { 분야: { type: 'multi_select', multi_select: { options: [{ id: 'deep', name: 'AI 딥러닝', color: 'blue' }] } } } });
    }
    if (path === '/v1/pages' && options.method === 'POST') {
      createCount += 1;
      const body = JSON.parse(options.body);
      const page = {
        id: '99999999-9999-4999-8999-999999999999',
        url: 'https://www.notion.so/99999999999949998999999999999999',
        properties: body.properties
      };
      createdPages.push(page);
      return Response.json(page);
    }
    return new Response('not found', { status: 404 });
  };

  try {
    const request = {
      token: 'test-token',
      conceptsDataSourceId: 'concepts',
      title: 'Graph Neural Network',
      domains: ['AI 딥러닝'],
      summary: '그래프 구조를 따라 정보를 전달하는 신경망.'
    };
    const results = await Promise.allSettled([createNotionConcept(request), createNotionConcept(request)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'CONCEPT_DUPLICATE');
    assert.equal(createCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
