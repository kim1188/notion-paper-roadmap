import crypto from 'node:crypto';
import fs from 'node:fs';

const manifestPath = new URL('../expert-paper-import-manifest-2026-09-01.json', import.meta.url);
const TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function loadExpertImportManifest() {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

export function selectExpertImport(manifest, rawScope = {}) {
  const scope = String(rawScope.scope || 'all');
  const requestedIds = new Set(Array.isArray(rawScope.nodeIds) ? rawScope.nodeIds.map(String) : []);
  const domainId = String(rawScope.domainId || '');
  const domain = manifest.domains.find((item) => item.id === domainId);
  const selectedConcepts = manifest.concepts.filter((concept) => {
    if (scope === 'nodes') return requestedIds.has(concept.roadmapId);
    if (scope === 'domain') return Boolean(domain && concept.domains.includes(domain.name));
    return scope === 'all';
  });
  if (!selectedConcepts.length) throw Object.assign(new Error('가져올 개념이 없습니다.'), { code: 'EMPTY_IMPORT_SELECTION', status: 400 });
  const conceptIds = new Set(selectedConcepts.map((concept) => concept.roadmapId));
  const paperKeys = new Set(selectedConcepts.flatMap((concept) => concept.paperKeys));
  const selectedPapers = manifest.papers.filter((paper) => paperKeys.has(paper.externalKey));
  const selectedRelations = manifest.relations.filter((relation) => conceptIds.has(relation.sourceRoadmapId) && conceptIds.has(relation.targetRoadmapId));
  const normalizedScope = scope === 'nodes'
    ? { scope, nodeIds: [...conceptIds].sort() }
    : scope === 'domain'
      ? { scope, domainId }
      : { scope: 'all' };
  return { scope: normalizedScope, papers: selectedPapers, concepts: selectedConcepts, relations: selectedRelations };
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function signature(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createImportApproval({ secret, batchId, selection, previewDigest, now = Date.now() }) {
  const payload = base64url(JSON.stringify({ batchId, scope: selection.scope, previewDigest, issuedAt: now }));
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyImportApproval({ secret, token, now = Date.now() }) {
  const [payload, provided] = String(token || '').split('.');
  if (!payload || !provided) throw Object.assign(new Error('승인 정보가 없습니다.'), { code: 'INVALID_IMPORT_APPROVAL', status: 401 });
  const expected = signature(payload, secret);
  const valid = provided.length === expected.length && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!valid) throw Object.assign(new Error('승인 정보가 올바르지 않습니다.'), { code: 'INVALID_IMPORT_APPROVAL', status: 401 });
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!decoded.issuedAt || now - decoded.issuedAt > TOKEN_MAX_AGE_MS || decoded.issuedAt - now > 60_000) {
    throw Object.assign(new Error('미리보기 승인이 만료되었습니다.'), { code: 'IMPORT_APPROVAL_EXPIRED', status: 401 });
  }
  return decoded;
}

export function importPreviewDigest({ manifest, selection, preview }) {
  const compact = {
    manifestVersion: manifest.version,
    asOf: manifest.asOf,
    scope: selection.scope,
    counts: preview.counts,
    holds: preview.concepts.filter((item) => item.action === 'hold').map((item) => item.roadmapId).sort()
  };
  return crypto.createHash('sha256').update(JSON.stringify(compact)).digest('hex').slice(0, 24);
}

export function nextImportCursor({ phase = 'papers', cursor = 0, selection, processed }) {
  const phases = ['papers', 'concepts', 'relations', 'finalize'];
  const lengths = {
    papers: selection.papers.length,
    concepts: selection.concepts.length,
    relations: selection.relations.length,
    finalize: selection.papers.length
  };
  let nextPhase = phase;
  let nextCursor = Number(cursor) + Number(processed);
  while (nextCursor >= lengths[nextPhase]) {
    const index = phases.indexOf(nextPhase);
    if (index === phases.length - 1) return { done: true, phase: 'done', cursor: lengths.finalize };
    nextPhase = phases[index + 1];
    nextCursor = 0;
    if (lengths[nextPhase] > 0) break;
  }
  return { done: false, phase: nextPhase, cursor: nextCursor };
}
