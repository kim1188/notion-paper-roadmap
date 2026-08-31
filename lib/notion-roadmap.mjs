const NOTION_VERSION = '2026-03-11';

const NOTION_COLORS = {
  default: '#766f63', gray: '#766f63', brown: '#86684b', orange: '#b96d32',
  yellow: '#a77c24', green: '#64724c', blue: '#315d80', purple: '#6f5b8f',
  pink: '#9b597a', red: '#8d4554'
};

const RELATION_TYPES = {
  선수: 'prerequisite', 확장: 'extends', 응용: 'applies_to',
  '가능하게 함': 'enables', 대조: 'contrasts_with'
};

const RELATION_NAMES = Object.fromEntries(Object.entries(RELATION_TYPES).map(([name, value]) => [value, name]));
const VISIBLE_APPROVED = new Set(['승인']);
const VISIBLE_WITH_CANDIDATES = new Set(['승인', '후보']);
const REVIEW_MATCH_THRESHOLD = 0.8;
const IMPORT_SCHEMA = {
  papers: {
    '외부 키': { rich_text: {} },
    '서지정보 상태': { select: { options: [{ name: '부분 확인', color: 'yellow' }, { name: '식별자 확인', color: 'blue' }, { name: '검토 완료', color: 'green' }] } },
    '가져오기 배치 ID': { rich_text: {} },
    '가져오기 버전': { rich_text: {} },
    '페이지 템플릿 버전': { rich_text: {} }
  },
  concepts: {
    '로드맵 ID': { rich_text: {} },
    '로드맵 단계': { select: { options: [{ name: '핵심', color: 'blue' }, { name: '심화', color: 'purple' }, { name: '프런티어', color: 'red' }] } },
    '가져오기 배치 ID': { rich_text: {} },
    '가져오기 버전': { rich_text: {} },
    '페이지 템플릿 버전': { rich_text: {} }
  },
  relations: {
    '로드맵 관계 ID': { rich_text: {} },
    '근거 유형': { select: { options: [{ name: '논문', color: 'blue' }, { name: '강의·로드맵', color: 'purple' }, { name: '로드맵 편집 판단', color: 'yellow' }] } },
    '근거 URL': { url: {} },
    '근거 검토 상태': { select: { options: [{ name: '미검토', color: 'yellow' }, { name: '확정', color: 'green' }, { name: '보류', color: 'red' }] } },
    '가져오기 배치 ID': { rich_text: {} },
    '가져오기 버전': { rich_text: {} }
  }
};
let conceptCreationQueue = Promise.resolve();

async function withConceptCreationQueue(task) {
  const previous = conceptCreationQueue;
  let release;
  conceptCreationQueue = new Promise((resolve) => { release = resolve; });
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
  }
}

function textValue(property) {
  if (!property) return '';
  const values = property.title || property.rich_text || [];
  return values.map((item) => item.plain_text || item.text?.content || '').join('').trim();
}

function selectValue(property) {
  return String(property?.select?.name || property?.status?.name || '').trim();
}

function multiSelectValues(property) {
  return (property?.multi_select || []).map((item) => String(item?.name || '').trim()).filter(Boolean);
}

function relationIds(property) {
  return (property?.relation || []).map((item) => item.id).filter(Boolean);
}

function urlValue(property) {
  return String(property?.url || '').trim();
}

function numberValue(property) {
  const value = property?.number;
  return Number.isFinite(value) ? value : null;
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function safeJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function richText(content) {
  return content ? [{ type: 'text', text: { content: String(content) } }] : [];
}

function linkedText(content, url = '') {
  const safeUrl = /^https:\/\//i.test(String(url || '')) ? String(url) : '';
  return content ? [{ type: 'text', text: { content: String(content), ...(safeUrl ? { link: { url: safeUrl } } : {}) } }] : [];
}

function block(type, content) {
  return { object: 'block', type, [type]: { rich_text: richText(content) } };
}

function linkedListItem(content, url = '') {
  return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: linkedText(content, url) } };
}

function relationValue(ids = []) {
  return [...new Set(ids.filter(Boolean))].map((id) => ({ id }));
}

function errorWith(code, message, detail = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, detail);
  return error;
}

export function normalizeConceptTerm(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[–—−]/g, '-')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizeDoi(value) {
  return String(value || '')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/, '')
    .trim();
}

function ngrams(value, size = 3) {
  const normalized = normalizeConceptTerm(value).replace(/\s+/g, '');
  if (!normalized) return new Set();
  if (normalized.length <= size) return new Set([normalized]);
  const result = new Set();
  for (let index = 0; index <= normalized.length - size; index += 1) result.add(normalized.slice(index, index + size));
  return result;
}

function diceSimilarity(left, right) {
  const a = ngrams(left);
  const b = ngrams(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const gram of a) if (b.has(gram)) overlap += 1;
  return (2 * overlap) / (a.size + b.size);
}

function tokenSimilarity(left, right) {
  const a = new Set(normalizeConceptTerm(left).split(' ').filter((item) => item.length > 1));
  const b = new Set(normalizeConceptTerm(right).split(' ').filter((item) => item.length > 1));
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / new Set([...a, ...b]).size;
}

function paperRecord(page) {
  const properties = page?.properties || {};
  return {
    id: String(page?.id || ''),
    url: String(page?.url || ''),
    editedAt: String(page?.last_edited_time || ''),
    title: textValue(properties['논문명']),
    doi: textValue(properties.DOI),
    externalKey: textValue(properties['외부 키']),
    originalUrl: urlValue(properties['원문 URL']),
    lilyUrl: urlValue(properties['LilyAI 링크']),
    authors: textValue(properties['저자']),
    year: numberValue(properties['연도']),
    summary: textValue(properties['요약']),
    metadataStatus: selectValue(properties['서지정보 상태']),
    importBatchId: textValue(properties['가져오기 배치 ID']),
    importVersion: textValue(properties['가져오기 버전']),
    templateVersion: textValue(properties['페이지 템플릿 버전']),
    status: selectValue(properties['검증 상태']),
    conceptIds: relationIds(properties['핵심 개념']),
    candidateConceptIds: relationIds(properties['개념 후보']),
    matchStatus: selectValue(properties['개념 매칭 상태'])
  };
}

function conceptRecord(page) {
  const properties = page?.properties || {};
  return {
    id: String(page?.id || ''),
    url: String(page?.url || ''),
    editedAt: String(page?.last_edited_time || ''),
    title: textValue(properties['개념명']),
    roadmapId: textValue(properties['로드맵 ID']),
    tier: selectValue(properties['로드맵 단계']),
    searchKey: textValue(properties['검색 키']),
    aliases: multiSelectValues(properties['별칭']),
    domainNames: multiSelectValues(properties['분야']),
    summary: textValue(properties['설명']),
    paperIds: relationIds(properties['연결 논문']),
    status: selectValue(properties['검증 상태']),
    importBatchId: textValue(properties['가져오기 배치 ID']),
    importVersion: textValue(properties['가져오기 버전']),
    templateVersion: textValue(properties['페이지 템플릿 버전']),
    duplicateStatus: selectValue(properties['중복 검사 상태']),
    positions: safeJson(textValue(properties['그래프 위치']), {})
  };
}

function relationRecord(page) {
  const properties = page?.properties || {};
  return {
    id: String(page?.id || ''),
    url: String(page?.url || ''),
    title: textValue(properties['관계명']),
    roadmapRelationId: textValue(properties['로드맵 관계 ID']),
    sourceIds: relationIds(properties['출발 개념']),
    targetIds: relationIds(properties['도착 개념']),
    typeName: selectValue(properties['관계 유형']),
    evidencePaperIds: relationIds(properties['근거 논문']),
    summary: textValue(properties['관계 설명']),
    evidenceType: selectValue(properties['근거 유형']),
    evidenceUrl: urlValue(properties['근거 URL']),
    evidenceStatus: selectValue(properties['근거 검토 상태']),
    importBatchId: textValue(properties['가져오기 배치 ID']),
    importVersion: textValue(properties['가져오기 버전']),
    status: selectValue(properties['검증 상태']),
    portalPositions: safeJson(textValue(properties['포털 위치']), {})
  };
}

function domainIdFor(name, optionMap = new Map()) {
  const optionId = String(optionMap.get(name)?.id || '').replace(/[^a-zA-Z0-9_-]+/g, '-');
  return optionId ? `field-${optionId}` : `field-${stableHash(name)}`;
}

export function findConceptMatches({ concepts = [], title, aliases = [], summary = '', limit = 5 }) {
  const queryTerms = [title, ...aliases].map(normalizeConceptTerm).filter(Boolean);
  const querySet = new Set(queryTerms);
  const matches = concepts
    .map((raw) => {
      const concept = raw?.properties ? conceptRecord(raw) : raw;
      const existingTerms = [concept.title, ...(concept.aliases || [])].map(normalizeConceptTerm).filter(Boolean);
      const exactTerm = existingTerms.find((term) => querySet.has(term));
      let nameScore = exactTerm ? 1 : 0;
      if (!exactTerm) {
        for (const queryTerm of queryTerms) {
          for (const existingTerm of existingTerms) nameScore = Math.max(nameScore, diceSimilarity(queryTerm, existingTerm));
        }
      }
      const descriptionScore = tokenSimilarity(summary, concept.summary || '');
      const score = exactTerm ? 1 : Math.min(0.99, nameScore * 0.86 + descriptionScore * 0.14);
      return {
        id: concept.id,
        url: concept.url,
        title: concept.title,
        aliases: concept.aliases || [],
        domains: concept.domainNames || concept.domains || [],
        summary: concept.summary || '',
        status: concept.status || '',
        exact: Boolean(exactTerm),
        matchType: exactTerm ? 'exact_name_or_alias' : nameScore >= REVIEW_MATCH_THRESHOLD ? 'similar_name' : descriptionScore >= 0.6 ? 'similar_definition' : 'weak',
        score: Number(score.toFixed(3))
      };
    })
    .filter((match) => match.title && match.status !== '거절')
    .sort((left, right) => Number(right.exact) - Number(left.exact) || right.score - left.score || left.title.localeCompare(right.title, 'ko'))
    .slice(0, Math.max(1, Math.min(Number(limit) || 5, 10)));

  return {
    query: { title: String(title || '').trim(), aliases, summary: String(summary || '').trim() },
    exact: matches.find((match) => match.exact) || null,
    reviewRequired: !matches.some((match) => match.exact) && Boolean(matches[0] && matches[0].score >= REVIEW_MATCH_THRESHOLD),
    matches
  };
}

export function mapNotionRoadmap({ paperPages = [], conceptPages = [], relationPages = [], conceptDataSource, databaseUrl = '', includeCandidates = false }) {
  const visibleStatuses = includeCandidates ? VISIBLE_WITH_CANDIDATES : VISIBLE_APPROVED;
  const papers = paperPages.map(paperRecord).filter((paper) => paper.title && visibleStatuses.has(paper.status));
  const concepts = conceptPages.map(conceptRecord).filter((concept) => concept.title && concept.domainNames.length && visibleStatuses.has(concept.status));
  const relations = relationPages.map(relationRecord).filter((relation) => visibleStatuses.has(relation.status));
  const paperById = new Map(papers.map((paper) => [paper.id, paper]));
  const conceptById = new Map(concepts.map((concept) => [concept.id, concept]));

  const options = conceptDataSource?.properties?.['분야']?.multi_select?.options || [];
  const optionMap = new Map(options.map((option) => [option.name, option]));
  const domainNames = [...new Set([...options.map((option) => option.name), ...concepts.flatMap((concept) => concept.domainNames)])];
  const domains = [
    { id: 'all', name: '전체', color: '#2f3934' },
    ...domainNames.map((name) => ({
      id: domainIdFor(name, optionMap),
      name,
      color: NOTION_COLORS[optionMap.get(name)?.color] || NOTION_COLORS.default
    }))
  ];
  const domainIdByName = new Map(domains.map((domain) => [domain.name, domain.id]));

  const nodes = concepts.map((concept) => {
    const conceptPapers = concept.paperIds.map((id) => paperById.get(id)).filter(Boolean);
    const nodeDomains = concept.domainNames.map((name) => domainIdByName.get(name)).filter(Boolean);
    return {
      id: concept.id,
      title: concept.title,
      domain: nodeDomains[0],
      domains: nodeDomains,
      summary: concept.summary,
      status: concept.status,
      notionUrl: concept.url,
      papers: conceptPapers.map((paper) => ({ title: paper.title, notionPageId: paper.id, notionUrl: paper.url })),
      positions: concept.positions
    };
  });

  const edges = [];
  for (const relation of relations) {
    const source = relation.sourceIds[0];
    const target = relation.targetIds[0];
    if (!source || !target || source === target || !conceptById.has(source) || !conceptById.has(target)) continue;
    const evidence = relation.evidencePaperIds.map((id) => paperById.get(id)).filter(Boolean);
    edges.push({
      id: relation.id,
      source,
      target,
      type: RELATION_TYPES[relation.typeName] || 'extends',
      paper: evidence[0]?.title || relation.title || '연결 논문',
      papers: evidence.map((paper) => ({ title: paper.title, notionPageId: paper.id, notionUrl: paper.url })),
      summary: relation.summary,
      status: relation.status,
      notionUrl: relation.url,
      portalPositions: relation.portalPositions
    });
  }

  return {
    version: 2,
    updatedAt: new Date().toISOString(),
    includeCandidates,
    databaseUrl,
    domains,
    nodes,
    edges
  };
}

async function notionRequest(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) {
    const detail = await response.text();
    const error = new Error(`Notion API ${response.status}: ${detail.slice(0, 500)}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function queryAll({ token, dataSourceId }) {
  const pages = [];
  let cursor;
  do {
    const query = await notionRequest(`/data_sources/${dataSourceId}/query`, {
      token,
      method: 'POST',
      body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }
    });
    pages.push(...(query.results || []));
    cursor = query.has_more ? query.next_cursor : null;
  } while (cursor);
  return pages;
}

async function ensureOptions({ token, dataSourceId, propertyName, names, color = 'gray' }) {
  const requested = [...new Set((names || []).map((name) => String(name || '').trim()).filter(Boolean))];
  if (!requested.length) return;
  const dataSource = await notionRequest(`/data_sources/${dataSourceId}`, { token });
  const property = dataSource?.properties?.[propertyName];
  const type = property?.type;
  if (type !== 'multi_select' && type !== 'select') throw errorWith('INVALID_OPTION_PROPERTY', `${propertyName} 속성은 Select 또는 Multi-select여야 합니다.`);
  const existing = property[type]?.options || [];
  const existingNames = new Set(existing.map((option) => option.name.toLocaleLowerCase()));
  const additions = requested.filter((name) => !existingNames.has(name.toLocaleLowerCase()));
  if (!additions.length) return;
  const allowedColor = Object.hasOwn(NOTION_COLORS, color) ? color : 'gray';
  await notionRequest(`/data_sources/${dataSourceId}`, {
    token,
    method: 'PATCH',
    body: {
      properties: {
        [propertyName]: {
          [type]: {
            options: [...existing.map((option) => ({ id: option.id })), ...additions.map((name) => ({ name, color: allowedColor }))]
          }
        }
      }
    }
  });
}

function missingSchemaProperties(dataSource, expected) {
  const current = dataSource?.properties || {};
  return Object.keys(expected).filter((name) => !current[name]);
}

async function ensureSchemaProperties({ token, dataSourceId, expected }) {
  const dataSource = await notionRequest(`/data_sources/${dataSourceId}`, { token });
  const missing = missingSchemaProperties(dataSource, expected);
  if (!missing.length) return [];
  await notionRequest(`/data_sources/${dataSourceId}`, {
    token,
    method: 'PATCH',
    body: { properties: Object.fromEntries(missing.map((name) => [name, expected[name]])) }
  });
  return missing;
}

function paperImportChildren(paper) {
  const concepts = Array.isArray(paper.roadmapConceptTitles) ? paper.roadmapConceptTitles : [];
  const children = [
    {
      object: 'block',
      type: 'callout',
      callout: {
        icon: { type: 'emoji', emoji: '📄' },
        rich_text: richText(`전문가 로드맵에서 후보로 가져온 논문입니다. 서지정보 상태: ${paper.metadataStatus || '부분 확인'}`)
      }
    },
    block('heading_2', '원문과 정리'),
    linkedListItem('원문 바로가기', paper.originalUrl),
    block('heading_2', '로드맵 포함 이유'),
    block('paragraph', concepts.length ? `${concepts.join(', ')} 개념의 대표 읽기 자료로 연결됩니다.` : '연결 개념은 가져오기 완료 후 Relation에서 확인합니다.'),
    block('heading_2', '읽기 기록'),
    block('paragraph', '핵심 기여, 중요한 수식·그림, 한계와 토론 질문을 이 아래에 기록하세요.')
  ];
  return children;
}

function conceptImportChildren(concept, papers = []) {
  return [
    {
      object: 'block',
      type: 'callout',
      callout: {
        icon: { type: 'emoji', emoji: '🧭' },
        rich_text: richText(`${concept.tier || '핵심'} 단계 · ${concept.domains.join(' · ')} · 검증 전 후보 개념`)
      }
    },
    block('heading_2', '개념 설명'),
    block('paragraph', concept.summary),
    block('heading_2', '대표 논문'),
    ...papers.map((paper) => linkedListItem(paper.title, paper.url || paper.originalUrl)),
    block('heading_2', '선수·후속 개념'),
    block('paragraph', '개념 관계 DB에서 방향성과 근거 검토 상태를 확인하세요.'),
    block('heading_2', '팀 학습 메모'),
    block('paragraph', '이 개념을 설명할 수 있는지, 어떤 논문과 연결되는지, 남은 질문이 무엇인지 기록하세요.')
  ];
}

export async function inspectNotionImportSchema({ token, papersDataSourceId, conceptsDataSourceId, relationsDataSourceId }) {
  const [papers, concepts, relations] = await Promise.all([
    notionRequest(`/data_sources/${papersDataSourceId}`, { token }),
    notionRequest(`/data_sources/${conceptsDataSourceId}`, { token }),
    notionRequest(`/data_sources/${relationsDataSourceId}`, { token })
  ]);
  return {
    papers: missingSchemaProperties(papers, IMPORT_SCHEMA.papers),
    concepts: missingSchemaProperties(concepts, IMPORT_SCHEMA.concepts),
    relations: missingSchemaProperties(relations, IMPORT_SCHEMA.relations)
  };
}

export async function ensureNotionImportSchema({ token, papersDataSourceId, conceptsDataSourceId, relationsDataSourceId }) {
  const [papers, concepts, relations] = await Promise.all([
    ensureSchemaProperties({ token, dataSourceId: papersDataSourceId, expected: IMPORT_SCHEMA.papers }),
    ensureSchemaProperties({ token, dataSourceId: conceptsDataSourceId, expected: IMPORT_SCHEMA.concepts }),
    ensureSchemaProperties({ token, dataSourceId: relationsDataSourceId, expected: IMPORT_SCHEMA.relations })
  ]);
  await Promise.all([
    ensureOptions({ token, dataSourceId: papersDataSourceId, propertyName: '생성 경로', names: ['Notion Agent'], color: 'blue' }),
    ensureOptions({ token, dataSourceId: conceptsDataSourceId, propertyName: '생성 경로', names: ['Notion Agent'], color: 'blue' }),
    ensureOptions({ token, dataSourceId: relationsDataSourceId, propertyName: '생성 경로', names: ['Notion Agent'], color: 'blue' })
  ]);
  return { papers, concepts, relations };
}

export async function listNotionImportCatalog({ token, papersDataSourceId, conceptsDataSourceId, relationsDataSourceId }) {
  const [paperPages, conceptPages, relationPages] = await Promise.all([
    queryAll({ token, dataSourceId: papersDataSourceId }),
    queryAll({ token, dataSourceId: conceptsDataSourceId }),
    queryAll({ token, dataSourceId: relationsDataSourceId })
  ]);
  return {
    papers: paperPages.map(paperRecord),
    concepts: conceptPages.map(conceptRecord),
    relations: relationPages.map(relationRecord)
  };
}

function findImportedPaper(records, paper) {
  const normalizedDoi = normalizeDoi(paper.doi);
  const normalizedTitle = normalizeConceptTerm(paper.title);
  return records.find((record) =>
    (paper.externalKey && record.externalKey === paper.externalKey) ||
    (normalizedDoi && normalizeDoi(record.doi) === normalizedDoi) ||
    normalizeConceptTerm(record.title) === normalizedTitle
  );
}

function findImportedConcept(records, concept) {
  return records.find((record) => record.roadmapId && record.roadmapId === concept.roadmapId) || null;
}

export function planNotionImport({ catalog, selection, schemaGaps = { papers: [], concepts: [], relations: [] } }) {
  const papers = selection.papers.map((paper) => {
    const existing = findImportedPaper(catalog.papers, paper);
    return { externalKey: paper.externalKey, title: paper.title, action: existing ? 'reuse' : 'create', existing: existing ? { id: existing.id, title: existing.title, url: existing.url } : null };
  });
  const conceptResolution = new Map();
  const concepts = selection.concepts.map((concept) => {
    const imported = findImportedConcept(catalog.concepts, concept);
    if (imported) {
      conceptResolution.set(concept.roadmapId, { action: 'reuse', id: imported.id });
      return { roadmapId: concept.roadmapId, title: concept.title, action: 'reuse', match: { id: imported.id, title: imported.title, url: imported.url, matchType: 'roadmap_id', score: 1 } };
    }
    const match = findConceptMatches({ concepts: catalog.concepts, title: concept.title, aliases: concept.aliases, summary: concept.summary, limit: 5 });
    if (match.exact) {
      conceptResolution.set(concept.roadmapId, { action: 'reuse', id: match.exact.id });
      return { roadmapId: concept.roadmapId, title: concept.title, action: 'reuse', match: match.exact, matches: match.matches };
    }
    if (match.reviewRequired) {
      conceptResolution.set(concept.roadmapId, { action: 'hold' });
      return { roadmapId: concept.roadmapId, title: concept.title, action: 'hold', match: match.matches[0] || null, matches: match.matches };
    }
    conceptResolution.set(concept.roadmapId, { action: 'create' });
    return { roadmapId: concept.roadmapId, title: concept.title, action: 'create', match: match.matches[0] || null, matches: match.matches };
  });
  const relations = selection.relations.map((relation) => {
    const source = conceptResolution.get(relation.sourceRoadmapId);
    const target = conceptResolution.get(relation.targetRoadmapId);
    if (source?.action === 'hold' || target?.action === 'hold') return { roadmapRelationId: relation.roadmapRelationId, action: 'hold', reason: 'CONCEPT_REVIEW_REQUIRED' };
    const existing = catalog.relations.find((record) =>
      record.roadmapRelationId === relation.roadmapRelationId ||
      (source?.id && target?.id && record.sourceIds[0] === source.id && record.targetIds[0] === target.id && record.typeName === (RELATION_NAMES[relation.type] || '확장'))
    );
    return { roadmapRelationId: relation.roadmapRelationId, action: existing ? 'reuse' : 'create', existing: existing ? { id: existing.id, url: existing.url } : null };
  });
  const actions = [...papers, ...concepts, ...relations];
  return {
    schemaGaps,
    papers,
    concepts,
    relations,
    counts: {
      papers: papers.length,
      concepts: concepts.length,
      relations: relations.length,
      create: actions.filter((item) => item.action === 'create').length,
      reuse: actions.filter((item) => item.action === 'reuse').length,
      hold: actions.filter((item) => item.action === 'hold').length
    }
  };
}

export async function loadNotionRoadmap({ token, papersDataSourceId, conceptsDataSourceId, relationsDataSourceId, databaseUrl = '', includeCandidates = false }) {
  const [paperPages, conceptPages, relationPages, conceptDataSource] = await Promise.all([
    queryAll({ token, dataSourceId: papersDataSourceId }),
    queryAll({ token, dataSourceId: conceptsDataSourceId }),
    queryAll({ token, dataSourceId: relationsDataSourceId }),
    notionRequest(`/data_sources/${conceptsDataSourceId}`, { token })
  ]);
  return mapNotionRoadmap({ paperPages, conceptPages, relationPages, conceptDataSource, databaseUrl, includeCandidates });
}

export async function listNotionPapers({ token, papersDataSourceId, includeCandidates = true }) {
  const visibleStatuses = includeCandidates ? VISIBLE_WITH_CANDIDATES : VISIBLE_APPROVED;
  const papers = (await queryAll({ token, dataSourceId: papersDataSourceId }))
    .map(paperRecord)
    .filter((paper) => paper.title && visibleStatuses.has(paper.status))
    .sort((left, right) => left.title.localeCompare(right.title, 'ko'));
  return papers.map((paper) => ({ id: paper.id, title: paper.title, status: paper.status, notionUrl: paper.url }));
}

export async function matchNotionConcepts({ token, conceptsDataSourceId, title, aliases = [], summary = '', limit = 5 }) {
  const concepts = (await queryAll({ token, dataSourceId: conceptsDataSourceId })).map(conceptRecord);
  return findConceptMatches({ concepts, title, aliases, summary, limit });
}

export async function addNotionDomain({ token, conceptsDataSourceId, name, color = 'purple' }) {
  await ensureOptions({ token, dataSourceId: conceptsDataSourceId, propertyName: '분야', names: [name], color });
  const dataSource = await notionRequest(`/data_sources/${conceptsDataSourceId}`, { token });
  const option = (dataSource?.properties?.['분야']?.multi_select?.options || []).find((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  return { id: domainIdFor(option?.name || name, new Map([[option?.name || name, option || {}]])), name: option?.name || name, color: NOTION_COLORS[option?.color] || NOTION_COLORS.default };
}

export async function createNotionPaper({ token, papersDataSourceId, title, doi = '', originalUrl = '', lilyUrl = '', authors = '', year, summary = '' }) {
  const existing = (await queryAll({ token, dataSourceId: papersDataSourceId })).map(paperRecord);
  const normalizedDoi = normalizeDoi(doi);
  const normalizedTitle = normalizeConceptTerm(title);
  const duplicate = existing.find((paper) => (normalizedDoi && normalizeDoi(paper.doi) === normalizedDoi) || normalizeConceptTerm(paper.title) === normalizedTitle);
  if (duplicate) throw errorWith('PAPER_DUPLICATE', '이미 등록된 논문입니다.', { status: 409, duplicate });

  const page = await notionRequest('/pages', {
    token,
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: papersDataSourceId },
      properties: {
        논문명: { type: 'title', title: richText(title) },
        DOI: { type: 'rich_text', rich_text: richText(doi) },
        '원문 URL': { type: 'url', url: originalUrl || null },
        'LilyAI 링크': { type: 'url', url: lilyUrl || null },
        저자: { type: 'rich_text', rich_text: richText(authors) },
        연도: { type: 'number', number: Number.isFinite(Number(year)) ? Number(year) : null },
        요약: { type: 'rich_text', rich_text: richText(summary) },
        '개념 매칭 상태': { type: 'select', select: { name: '개념 없음' } },
        '읽기 상태': { type: 'select', select: { name: '읽기 전' } },
        '검증 상태': { type: 'select', select: { name: '후보' } },
        '생성 경로': { type: 'select', select: { name: '수동' } }
      }
    }
  });
  return { id: page.id, url: page.url, status: '후보' };
}

export async function createNotionConcept({ token, conceptsDataSourceId, title, aliases = [], domains = [], summary, paperIds = [] }) {
  return withConceptCreationQueue(async () => {
    const assertCreatable = async () => {
      const match = await matchNotionConcepts({ token, conceptsDataSourceId, title, aliases, summary, limit: 5 });
      if (match.exact) throw errorWith('CONCEPT_DUPLICATE', '동일한 개념이 이미 존재합니다.', { status: 409, duplicate: match.exact, matches: match.matches });
      if (match.reviewRequired) throw errorWith('CONCEPT_REVIEW_REQUIRED', '유사한 기존 개념이 있어 사람의 확인이 필요합니다.', { status: 409, matches: match.matches });
      return match;
    };

    await assertCreatable();
    await ensureOptions({ token, dataSourceId: conceptsDataSourceId, propertyName: '별칭', names: aliases, color: 'gray' });
    await ensureOptions({ token, dataSourceId: conceptsDataSourceId, propertyName: '분야', names: domains, color: 'purple' });
    const match = await assertCreatable();
    const searchKey = [title, ...aliases].map(normalizeConceptTerm).filter(Boolean).join(' | ');
    const page = await notionRequest('/pages', {
      token,
      method: 'POST',
      body: {
        parent: { type: 'data_source_id', data_source_id: conceptsDataSourceId },
        properties: {
          개념명: { type: 'title', title: richText(title) },
          '검색 키': { type: 'rich_text', rich_text: richText(searchKey) },
          별칭: { type: 'multi_select', multi_select: aliases.map((name) => ({ name })) },
          분야: { type: 'multi_select', multi_select: domains.map((name) => ({ name })) },
          설명: { type: 'rich_text', rich_text: richText(summary) },
          '연결 논문': { type: 'relation', relation: relationValue(paperIds) },
          '중복 검사 상태': { type: 'select', select: { name: '일치 없음' } },
          '검증 상태': { type: 'select', select: { name: '후보' } },
          신뢰도: { type: 'select', select: { name: '중간' } },
          '생성 경로': { type: 'select', select: { name: '수동' } },
          '재검토 필요': { type: 'checkbox', checkbox: true }
        }
      }
    });
    return { id: page.id, url: page.url, status: '후보', matches: match.matches };
  });
}

export async function addNotionRelation({ token, relationsDataSourceId, sourceConceptId, targetConceptId, type, evidencePaperIds = [], summary = '' }) {
  const typeName = RELATION_NAMES[type] || '확장';
  const relations = (await queryAll({ token, dataSourceId: relationsDataSourceId })).map(relationRecord);
  const existing = relations.find((relation) => relation.sourceIds[0] === sourceConceptId && relation.targetIds[0] === targetConceptId && relation.typeName === typeName && relation.status !== '거절');
  if (existing) {
    const evidence = [...new Set([...existing.evidencePaperIds, ...evidencePaperIds])];
    await notionRequest(`/pages/${existing.id}`, {
      token,
      method: 'PATCH',
      body: { properties: { '근거 논문': { type: 'relation', relation: relationValue(evidence) } } }
    });
    return { id: existing.id, url: existing.url, reused: true, status: existing.status };
  }
  const [sourcePage, targetPage] = await Promise.all([
    notionRequest(`/pages/${sourceConceptId}`, { token }),
    notionRequest(`/pages/${targetConceptId}`, { token })
  ]);
  const sourceTitle = conceptRecord(sourcePage).title || sourceConceptId;
  const targetTitle = conceptRecord(targetPage).title || targetConceptId;
  const page = await notionRequest('/pages', {
    token,
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: relationsDataSourceId },
      properties: {
        관계명: { type: 'title', title: richText(`${sourceTitle} → ${targetTitle} · ${typeName}`) },
        '출발 개념': { type: 'relation', relation: relationValue([sourceConceptId]) },
        '도착 개념': { type: 'relation', relation: relationValue([targetConceptId]) },
        '관계 유형': { type: 'select', select: { name: typeName } },
        '근거 논문': { type: 'relation', relation: relationValue(evidencePaperIds) },
        '관계 설명': { type: 'rich_text', rich_text: richText(summary) },
        '검증 상태': { type: 'select', select: { name: '후보' } },
        신뢰도: { type: 'select', select: { name: '중간' } },
        '생성 경로': { type: 'select', select: { name: '수동' } }
      }
    }
  });
  return { id: page.id, url: page.url, reused: false, status: '후보' };
}

export async function updateNotionLayout({ token, kind, pageId, layout }) {
  const propertyName = kind === 'concept' ? '그래프 위치' : kind === 'relation' ? '포털 위치' : '';
  if (!propertyName) throw errorWith('INVALID_LAYOUT_KIND', '레이아웃 종류가 올바르지 않습니다.', { status: 400 });
  const serialized = JSON.stringify(layout || {});
  if (serialized.length > 1800) throw errorWith('LAYOUT_TOO_LARGE', '레이아웃 데이터가 너무 큽니다.', { status: 400 });
  await notionRequest(`/pages/${pageId}`, {
    token,
    method: 'PATCH',
    body: { properties: { [propertyName]: { type: 'rich_text', rich_text: richText(serialized) } } }
  });
  return { kind, pageId, layout };
}

export async function upsertNotionPaperFromImport({ token, papersDataSourceId, paper, batchId, importVersion, templateVersion, roadmapConceptTitles = [] }) {
  const records = (await queryAll({ token, dataSourceId: papersDataSourceId })).map(paperRecord);
  const existing = findImportedPaper(records, paper);
  if (existing) {
    const properties = {
      '가져오기 배치 ID': { type: 'rich_text', rich_text: richText(batchId) },
      '가져오기 버전': { type: 'rich_text', rich_text: richText(importVersion) },
      '페이지 템플릿 버전': { type: 'rich_text', rich_text: richText(existing.templateVersion || templateVersion) }
    };
    if (!existing.externalKey) properties['외부 키'] = { type: 'rich_text', rich_text: richText(paper.externalKey) };
    if (!existing.doi && paper.doi) properties.DOI = { type: 'rich_text', rich_text: richText(paper.doi) };
    if (!existing.originalUrl && paper.originalUrl) properties['원문 URL'] = { type: 'url', url: paper.originalUrl };
    if (!existing.authors && paper.authors) properties['저자'] = { type: 'rich_text', rich_text: richText(paper.authors) };
    if (!existing.year && paper.year) properties['연도'] = { type: 'number', number: Number(paper.year) };
    if (!existing.metadataStatus) properties['서지정보 상태'] = { type: 'select', select: { name: paper.metadataStatus || '부분 확인' } };
    await notionRequest(`/pages/${existing.id}`, { token, method: 'PATCH', body: { properties } });
    return { id: existing.id, url: existing.url, title: existing.title, externalKey: paper.externalKey, reused: true, status: existing.status };
  }
  const page = await notionRequest('/pages', {
    token,
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: papersDataSourceId },
      properties: {
        논문명: { type: 'title', title: richText(paper.title) },
        DOI: { type: 'rich_text', rich_text: richText(paper.doi) },
        '원문 URL': { type: 'url', url: paper.originalUrl || null },
        'LilyAI 링크': { type: 'url', url: null },
        저자: { type: 'rich_text', rich_text: richText(paper.authors) },
        연도: { type: 'number', number: Number.isFinite(Number(paper.year)) ? Number(paper.year) : null },
        요약: { type: 'rich_text', rich_text: richText(paper.abstract) },
        '개념 매칭 상태': { type: 'select', select: { name: '개념 없음' } },
        '읽기 순서': { type: 'number', number: Number.isFinite(Number(paper.readingOrder)) ? Number(paper.readingOrder) : null },
        '읽기 상태': { type: 'select', select: { name: '읽기 전' } },
        '검증 상태': { type: 'select', select: { name: '후보' } },
        '생성 경로': { type: 'select', select: { name: 'Notion Agent' } },
        '외부 키': { type: 'rich_text', rich_text: richText(paper.externalKey) },
        '서지정보 상태': { type: 'select', select: { name: paper.metadataStatus || '부분 확인' } },
        '가져오기 배치 ID': { type: 'rich_text', rich_text: richText(batchId) },
        '가져오기 버전': { type: 'rich_text', rich_text: richText(importVersion) },
        '페이지 템플릿 버전': { type: 'rich_text', rich_text: richText(templateVersion) }
      },
      children: paperImportChildren({ ...paper, roadmapConceptTitles })
    }
  });
  return { id: page.id, url: page.url, title: paper.title, externalKey: paper.externalKey, reused: false, status: '후보' };
}

export async function upsertNotionConceptFromImport({ token, conceptsDataSourceId, concept, paperRecords = [], batchId, importVersion, templateVersion }) {
  return withConceptCreationQueue(async () => {
    const records = (await queryAll({ token, dataSourceId: conceptsDataSourceId })).map(conceptRecord);
    const imported = findImportedConcept(records, concept);
    const match = imported
      ? { exact: imported, reviewRequired: false, matches: [{ ...imported, exact: true, matchType: 'roadmap_id', score: 1 }] }
      : findConceptMatches({ concepts: records, title: concept.title, aliases: concept.aliases, summary: concept.summary, limit: 5 });
    if (!match.exact && match.reviewRequired) return { roadmapId: concept.roadmapId, title: concept.title, held: true, reason: 'CONCEPT_REVIEW_REQUIRED', matches: match.matches };
    await ensureOptions({ token, dataSourceId: conceptsDataSourceId, propertyName: '별칭', names: concept.aliases, color: 'gray' });
    await ensureOptions({ token, dataSourceId: conceptsDataSourceId, propertyName: '분야', names: concept.domains, color: 'purple' });
    const paperIds = paperRecords.map((paper) => paper.id).filter(Boolean);
    const existing = match.exact;
    if (existing) {
      const domains = [...new Set([...(existing.domainNames || []), ...concept.domains])];
      const aliases = [...new Set([...(existing.aliases || []), ...concept.aliases])];
      const linkedPapers = [...new Set([...(existing.paperIds || []), ...paperIds])];
      const properties = {
        별칭: { type: 'multi_select', multi_select: aliases.map((name) => ({ name })) },
        분야: { type: 'multi_select', multi_select: domains.map((name) => ({ name })) },
        '연결 논문': { type: 'relation', relation: relationValue(linkedPapers) },
        '가져오기 배치 ID': { type: 'rich_text', rich_text: richText(batchId) },
        '가져오기 버전': { type: 'rich_text', rich_text: richText(importVersion) },
        '페이지 템플릿 버전': { type: 'rich_text', rich_text: richText(existing.templateVersion || templateVersion) }
      };
      if (!existing.roadmapId) properties['로드맵 ID'] = { type: 'rich_text', rich_text: richText(concept.roadmapId) };
      if (!existing.tier) properties['로드맵 단계'] = { type: 'select', select: { name: concept.tier || '핵심' } };
      if (!existing.summary) properties.설명 = { type: 'rich_text', rich_text: richText(concept.summary) };
      await notionRequest(`/pages/${existing.id}`, { token, method: 'PATCH', body: { properties } });
      return { id: existing.id, url: existing.url, title: existing.title, roadmapId: concept.roadmapId, reused: true, status: existing.status, matches: match.matches };
    }
    const searchKey = [concept.title, ...concept.aliases].map(normalizeConceptTerm).filter(Boolean).join(' | ');
    const page = await notionRequest('/pages', {
      token,
      method: 'POST',
      body: {
        parent: { type: 'data_source_id', data_source_id: conceptsDataSourceId },
        properties: {
          개념명: { type: 'title', title: richText(concept.title) },
          '검색 키': { type: 'rich_text', rich_text: richText(searchKey) },
          별칭: { type: 'multi_select', multi_select: concept.aliases.map((name) => ({ name })) },
          분야: { type: 'multi_select', multi_select: concept.domains.map((name) => ({ name })) },
          설명: { type: 'rich_text', rich_text: richText(concept.summary) },
          '연결 논문': { type: 'relation', relation: relationValue(paperIds) },
          '중복 검사 상태': { type: 'select', select: { name: '일치 없음' } },
          '검증 상태': { type: 'select', select: { name: '후보' } },
          신뢰도: { type: 'select', select: { name: '중간' } },
          '생성 경로': { type: 'select', select: { name: 'Notion Agent' } },
          '재검토 필요': { type: 'checkbox', checkbox: true },
          '로드맵 ID': { type: 'rich_text', rich_text: richText(concept.roadmapId) },
          '로드맵 단계': { type: 'select', select: { name: concept.tier || '핵심' } },
          '가져오기 배치 ID': { type: 'rich_text', rich_text: richText(batchId) },
          '가져오기 버전': { type: 'rich_text', rich_text: richText(importVersion) },
          '페이지 템플릿 버전': { type: 'rich_text', rich_text: richText(templateVersion) }
        },
        children: conceptImportChildren(concept, paperRecords)
      }
    });
    return { id: page.id, url: page.url, title: concept.title, roadmapId: concept.roadmapId, reused: false, status: '후보', matches: match.matches };
  });
}

export async function upsertNotionRelationFromImport({ token, relationsDataSourceId, relation, sourceConcept, targetConcept, batchId, importVersion }) {
  const typeName = RELATION_NAMES[relation.type] || '확장';
  const records = (await queryAll({ token, dataSourceId: relationsDataSourceId })).map(relationRecord);
  const existing = records.find((record) =>
    record.roadmapRelationId === relation.roadmapRelationId ||
    (record.sourceIds[0] === sourceConcept.id && record.targetIds[0] === targetConcept.id && record.typeName === typeName && record.status !== '거절')
  );
  if (existing) {
    const properties = {
      '가져오기 배치 ID': { type: 'rich_text', rich_text: richText(batchId) },
      '가져오기 버전': { type: 'rich_text', rich_text: richText(importVersion) }
    };
    if (!existing.roadmapRelationId) properties['로드맵 관계 ID'] = { type: 'rich_text', rich_text: richText(relation.roadmapRelationId) };
    if (!existing.evidenceType) properties['근거 유형'] = { type: 'select', select: { name: relation.evidenceType } };
    if (!existing.evidenceStatus) properties['근거 검토 상태'] = { type: 'select', select: { name: relation.evidenceStatus } };
    if (!existing.evidenceUrl && relation.evidenceUrl) properties['근거 URL'] = { type: 'url', url: relation.evidenceUrl };
    await notionRequest(`/pages/${existing.id}`, { token, method: 'PATCH', body: { properties } });
    return { id: existing.id, url: existing.url, roadmapRelationId: relation.roadmapRelationId, reused: true, status: existing.status };
  }
  const page = await notionRequest('/pages', {
    token,
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: relationsDataSourceId },
      properties: {
        관계명: { type: 'title', title: richText(`${sourceConcept.title} → ${targetConcept.title} · ${typeName}`) },
        '출발 개념': { type: 'relation', relation: relationValue([sourceConcept.id]) },
        '도착 개념': { type: 'relation', relation: relationValue([targetConcept.id]) },
        '관계 유형': { type: 'select', select: { name: typeName } },
        '근거 논문': { type: 'relation', relation: [] },
        '관계 설명': { type: 'rich_text', rich_text: richText(relation.summary) },
        '검증 상태': { type: 'select', select: { name: '후보' } },
        신뢰도: { type: 'select', select: { name: '중간' } },
        '생성 경로': { type: 'select', select: { name: 'Notion Agent' } },
        '로드맵 관계 ID': { type: 'rich_text', rich_text: richText(relation.roadmapRelationId) },
        '근거 유형': { type: 'select', select: { name: relation.evidenceType } },
        '근거 URL': { type: 'url', url: relation.evidenceUrl || null },
        '근거 검토 상태': { type: 'select', select: { name: relation.evidenceStatus } },
        '가져오기 배치 ID': { type: 'rich_text', rich_text: richText(batchId) },
        '가져오기 버전': { type: 'rich_text', rich_text: richText(importVersion) }
      }
    }
  });
  return { id: page.id, url: page.url, roadmapRelationId: relation.roadmapRelationId, reused: false, status: '후보' };
}

export async function finalizeNotionPaperImport({ token, papersDataSourceId, paper }) {
  const records = (await queryAll({ token, dataSourceId: papersDataSourceId })).map(paperRecord);
  const existing = findImportedPaper(records, paper);
  if (!existing) return { externalKey: paper.externalKey, held: true, reason: 'PAPER_NOT_FOUND' };
  const matchStatus = existing.conceptIds.length ? '완료' : '검토 필요';
  await notionRequest(`/pages/${existing.id}`, {
    token,
    method: 'PATCH',
    body: { properties: { '개념 매칭 상태': { type: 'select', select: { name: matchStatus } } } }
  });
  return { id: existing.id, url: existing.url, externalKey: paper.externalKey, reused: true, matchStatus };
}
