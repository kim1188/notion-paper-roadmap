import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const htmlPath = new URL('../expert-paper-roadmap.html', import.meta.url);
const catalogPath = new URL('../expert-paper-links-2026-09-01.json', import.meta.url);
const html = fs.readFileSync(htmlPath, 'utf8');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

function embeddedRoadmap() {
  const marker = 'const EXPERT_ROADMAP_DATA = ';
  const start = html.indexOf(marker) + marker.length;
  const end = html.indexOf('\n      const seedState', start);
  assert.ok(start >= marker.length && end > start, '전문가 로드맵 데이터가 HTML에 포함되어야 한다');
  return JSON.parse(html.slice(start, end).trim().replace(/;$/, ''));
}

test('전문가 정적 웹은 원본과 독립된 읽기 전용 데이터셋을 사용한다', () => {
  assert.match(html, /const STATIC_MODE = true/);
  assert.match(html, /const ROADMAP_API_URL = ''/);
  assert.match(html, /notion-paper-roadmap-expert-static-v1/);
  assert.match(html, /\.static-mode #addNodeBtn/);
  assert.match(html, /\.static-mode #addEdgeBtn/);
  assert.match(html, /const MIN_ZOOM = \.08/);
  assert.match(html, /const MAX_ZOOM = 2/);
  assert.match(html, /Math\.max\(MIN_ZOOM/);
  assert.match(html, /id="importBtn"/);
  assert.match(html, /\/api\/import\/preview/);
  assert.match(html, /\/api\/import\/apply/);
  assert.match(html, /후보 데이터 생성 승인/);
});

test('103개 노드와 112개 방향성 관계가 모두 유효하다', () => {
  const roadmap = embeddedRoadmap();
  assert.equal(roadmap.nodes.length, 103);
  assert.equal(roadmap.edges.length, 112);
  assert.equal(roadmap.domains.length, 14);

  const ids = new Set(roadmap.nodes.map((node) => node.id));
  assert.equal(ids.size, roadmap.nodes.length);
  roadmap.edges.forEach((edge) => {
    assert.ok(ids.has(edge.source), `존재하지 않는 출발 노드: ${edge.source}`);
    assert.ok(ids.has(edge.target), `존재하지 않는 도착 노드: ${edge.target}`);
    assert.notEqual(edge.source, edge.target);
  });
});

test('모든 노드에 설명·단계·원문 링크가 있다', () => {
  const roadmap = embeddedRoadmap();
  const papers = roadmap.nodes.flatMap((node) => {
    assert.ok(node.summary.length > 20, `${node.id} 설명이 너무 짧다`);
    assert.ok(['핵심', '심화', '프런티어'].includes(node.tier), `${node.id} 단계가 잘못되었다`);
    assert.ok(node.papers.length > 0, `${node.id}에 논문이 없다`);
    return node.papers;
  });

  assert.equal(new Set(papers.map((paper) => paper.title)).size, 210);
  papers.forEach((paper) => assert.match(paper.sourceUrl, /^https:\/\//, `${paper.title} 원문 URL`));
  assert.match(html, />원문<\/a>/);
  assert.match(html, /노션 페이지 바로가기/);
});

test('별도 링크 카탈로그와 HTML의 논문 URL이 일치한다', () => {
  const roadmap = embeddedRoadmap();
  const embedded = new Map(roadmap.nodes.flatMap((node) => node.papers).map((paper) => [paper.title, paper.sourceUrl]));
  assert.equal(catalog.count, 210);
  assert.equal(catalog.papers.length, 210);
  catalog.papers.forEach((paper) => assert.equal(embedded.get(paper.title), paper.url, paper.title));
});
