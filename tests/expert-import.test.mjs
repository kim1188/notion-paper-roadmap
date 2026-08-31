import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createImportApproval,
  loadExpertImportManifest,
  nextImportCursor,
  selectExpertImport,
  verifyImportApproval
} from '../lib/expert-import.mjs';
import { planNotionImport } from '../lib/notion-roadmap.mjs';

const manifest = loadExpertImportManifest();

test('전문가 로드맵을 3-DB 가져오기 명세로 변환한다', () => {
  assert.equal(manifest.concepts.length, 103);
  assert.equal(manifest.relations.length, 112);
  assert.equal(manifest.papers.length, 209);
  assert.equal(new Set(manifest.papers.map((paper) => paper.externalKey)).size, manifest.papers.length);
  assert.ok(manifest.papers.every((paper) => paper.originalUrl.startsWith('https://')));
  assert.ok(manifest.concepts.every((concept) => concept.paperKeys.length && concept.summary.length > 20));
  assert.ok(manifest.relations.every((relation) => relation.evidenceType === '로드맵 편집 판단' && relation.evidenceStatus === '미검토'));
});

test('선택 노드와 분야 단위로 논문·개념·내부 관계만 추린다', () => {
  const one = selectExpertImport(manifest, { scope: 'nodes', nodeIds: ['rl-ppo'] });
  assert.equal(one.concepts.length, 1);
  assert.equal(one.concepts[0].roadmapId, 'rl-ppo');
  assert.ok(one.papers.length > 0);
  assert.equal(one.relations.length, 0);

  const domain = selectExpertImport(manifest, { scope: 'domain', domainId: 'medical' });
  assert.ok(domain.concepts.length > 1);
  assert.ok(domain.concepts.every((concept) => concept.domains.includes('의료 AI')));
  assert.ok(domain.relations.every((relation) => domain.concepts.some((concept) => concept.roadmapId === relation.sourceRoadmapId)));
});

test('미리보기 승인은 범위와 배치에 묶이고 위조·만료를 차단한다', () => {
  const selection = selectExpertImport(manifest, { scope: 'nodes', nodeIds: ['rl-ppo'] });
  const token = createImportApproval({ secret: 'test-secret', batchId: 'batch-1', selection, previewDigest: 'digest', now: 1000 });
  assert.deepEqual(verifyImportApproval({ secret: 'test-secret', token, now: 2000 }).scope, { scope: 'nodes', nodeIds: ['rl-ppo'] });
  assert.throws(() => verifyImportApproval({ secret: 'wrong-secret', token, now: 2000 }), /올바르지/);
  assert.throws(() => verifyImportApproval({ secret: 'test-secret', token, now: 1000 + 24 * 60 * 60 * 1000 + 1 }), /만료/);
});

test('기존 페이지 재사용·유사 개념 보류·신규 후보 생성을 미리 계산한다', () => {
  const selection = {
    papers: [{ externalKey: 'arxiv:1', title: 'Existing Paper', doi: '' }, { externalKey: 'arxiv:2', title: 'New Paper', doi: '' }],
    concepts: [
      { roadmapId: 'same', title: 'Transformer', aliases: [], domains: ['딥러닝'], summary: 'Attention 기반 구조', paperKeys: [] },
      { roadmapId: 'hold', title: 'Transformers', aliases: [], domains: ['딥러닝'], summary: 'Attention 기반 구조', paperKeys: [] },
      { roadmapId: 'new', title: 'Entirely New Concept', aliases: [], domains: ['딥러닝'], summary: '새로운 설명', paperKeys: [] }
    ],
    relations: []
  };
  const catalog = {
    papers: [{ id: 'paper-1', externalKey: 'arxiv:1', title: 'Existing Paper', doi: '', url: 'https://www.notion.so/paper' }],
    concepts: [{ id: 'concept-1', roadmapId: '', title: 'Transformer', aliases: [], domainNames: ['딥러닝'], summary: 'Attention 기반 구조', status: '승인', url: 'https://www.notion.so/concept' }],
    relations: []
  };
  const preview = planNotionImport({ catalog, selection });
  assert.deepEqual(preview.papers.map((item) => item.action), ['reuse', 'create']);
  assert.equal(preview.concepts.find((item) => item.roadmapId === 'same').action, 'reuse');
  assert.equal(preview.concepts.find((item) => item.roadmapId === 'hold').action, 'hold');
  assert.equal(preview.concepts.find((item) => item.roadmapId === 'new').action, 'create');
});

test('단계별 배치는 빈 관계 단계와 마지막 finalize를 건너뛰며 재개된다', () => {
  const selection = { papers: [{}, {}], concepts: [{}], relations: [] };
  assert.deepEqual(nextImportCursor({ phase: 'papers', cursor: 0, selection, processed: 2 }), { done: false, phase: 'concepts', cursor: 0 });
  assert.deepEqual(nextImportCursor({ phase: 'concepts', cursor: 0, selection, processed: 1 }), { done: false, phase: 'finalize', cursor: 0 });
  assert.deepEqual(nextImportCursor({ phase: 'finalize', cursor: 0, selection, processed: 2 }), { done: true, phase: 'done', cursor: 2 });
});
