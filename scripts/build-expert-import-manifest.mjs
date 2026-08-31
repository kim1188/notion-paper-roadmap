import fs from 'node:fs';

const htmlPath = new URL('../expert-paper-roadmap.html', import.meta.url);
const outputPath = new URL('../expert-paper-import-manifest-2026-09-01.json', import.meta.url);
const html = fs.readFileSync(htmlPath, 'utf8');
const marker = 'const EXPERT_ROADMAP_DATA = ';
const start = html.indexOf(marker) + marker.length;
const end = html.indexOf('\n      const seedState', start);

if (start < marker.length || end <= start) throw new Error('전문가 로드맵 데이터를 찾지 못했습니다.');

const roadmap = JSON.parse(html.slice(start, end).trim().replace(/;$/, ''));
const domainNameById = new Map(roadmap.domains.map((domain) => [domain.id, domain.name]));

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[–—−]/g, '-')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function arxivId(url) {
  const match = String(url || '').match(/arxiv\.org\/(?:abs|pdf)\/([^?#/]+)(?:\.pdf)?/i);
  return match?.[1] || '';
}

function doi(url) {
  const match = String(url || '').match(/(?:doi\.org\/|^doi:)(10\.\d{4,9}\/[^?#\s]+)/i);
  return match?.[1]?.toLocaleLowerCase('en-US') || '';
}

function externalKey(paper) {
  const foundDoi = doi(paper.sourceUrl);
  if (foundDoi) return `doi:${foundDoi}`;
  const foundArxiv = arxivId(paper.sourceUrl);
  if (foundArxiv) return `arxiv:${foundArxiv.toLocaleLowerCase('en-US')}`;
  return `title:${normalizeTitle(paper.title)}`;
}

const conceptOrder = new Map(roadmap.nodes.map((node, index) => [node.id, index + 1]));
const paperConcepts = new Map();
for (const node of roadmap.nodes) {
  for (const paper of node.papers || []) {
    const key = externalKey(paper);
    if (!paperConcepts.has(key)) paperConcepts.set(key, new Set());
    paperConcepts.get(key).add(node.id);
  }
}

const paperByKey = new Map();
for (const node of roadmap.nodes) {
  for (const paper of node.papers || []) {
    const key = externalKey(paper);
    if (paperByKey.has(key)) continue;
    const conceptIds = [...(paperConcepts.get(key) || [])];
    const foundDoi = doi(paper.sourceUrl);
    const foundArxiv = arxivId(paper.sourceUrl);
    paperByKey.set(key, {
      externalKey: key,
      title: paper.title,
      originalUrl: paper.sourceUrl,
      source: paper.source || '',
      doi: foundDoi,
      arxivId: foundArxiv,
      authors: '',
      year: null,
      abstract: '',
      metadataStatus: foundDoi || foundArxiv ? '식별자 확인' : '부분 확인',
      readingOrder: Math.min(...conceptIds.map((id) => conceptOrder.get(id) || 9999)),
      roadmapConceptIds: conceptIds
    });
  }
}

const concepts = roadmap.nodes.map((node) => ({
  roadmapId: node.id,
  title: node.title,
  aliases: [],
  domains: (node.domains || [node.domain]).map((id) => domainNameById.get(id) || id).filter((name) => name && name !== '전체'),
  tier: node.tier || '핵심',
  summary: node.summary,
  paperKeys: (node.papers || []).map(externalKey)
}));

const relations = roadmap.edges.map((edge) => ({
  roadmapRelationId: edge.id,
  sourceRoadmapId: edge.source,
  targetRoadmapId: edge.target,
  type: edge.type,
  summary: edge.summary || '',
  evidenceType: '로드맵 편집 판단',
  evidenceStatus: '미검토',
  evidenceUrl: '',
  suggestedEvidencePaperKeys: (edge.papers || []).map(externalKey)
}));

const manifest = {
  version: 1,
  sourceVersion: roadmap.version,
  asOf: '2026-09-01',
  templateVersion: 'paper-atlas-import-v1',
  policy: {
    defaultValidationStatus: '후보',
    conceptMatchValues: ['SAME', 'RELATED_DISTINCT', 'UNSURE'],
    relationEvidencePolicy: '로드맵의 학습 순서는 논문 근거로 가장하지 않고 미검토 편집 판단으로 등록한다.'
  },
  domains: roadmap.domains.filter((domain) => domain.id !== 'all'),
  papers: [...paperByKey.values()].sort((left, right) => left.readingOrder - right.readingOrder || left.title.localeCompare(right.title, 'en')),
  concepts,
  relations
};

fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`작성 완료: ${manifest.papers.length}개 논문, ${manifest.concepts.length}개 개념, ${manifest.relations.length}개 관계`);
