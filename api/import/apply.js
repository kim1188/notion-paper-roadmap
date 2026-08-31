import { loadExpertImportManifest, nextImportCursor, selectExpertImport, verifyImportApproval } from '../../lib/expert-import.mjs';
import {
  ensureNotionImportSchema,
  finalizeNotionPaperImport,
  listNotionImportCatalog,
  upsertNotionConceptFromImport,
  upsertNotionPaperFromImport,
  upsertNotionRelationFromImport
} from '../../lib/notion-roadmap.mjs';

const PHASES = new Set(['papers', 'concepts', 'relations', 'finalize']);
const BATCH_SIZE = 6;

function configuration() {
  return {
    token: process.env.NOTION_TOKEN,
    papersDataSourceId: process.env.NOTION_PAPERS_DATA_SOURCE_ID,
    conceptsDataSourceId: process.env.NOTION_CONCEPTS_DATA_SOURCE_ID,
    relationsDataSourceId: process.env.NOTION_RELATIONS_DATA_SOURCE_ID,
    writeKey: process.env.ROADMAP_WRITE_KEY
  };
}

function conceptByRoadmapId(catalog, selection, roadmapId) {
  const concept = selection.concepts.find((item) => item.roadmapId === roadmapId);
  if (!concept) return null;
  return catalog.concepts.find((record) => record.roadmapId === roadmapId)
    || catalog.concepts.find((record) => record.title && record.title.localeCompare(concept.title, 'ko', { sensitivity: 'base' }) === 0)
    || null;
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  }
  const config = configuration();
  if (!config.token || !config.papersDataSourceId || !config.conceptsDataSourceId || !config.relationsDataSourceId || !config.writeKey) {
    return response.status(503).json({ error: 'IMPORT_NOT_CONFIGURED' });
  }
  if (request.headers['x-roadmap-write-key'] !== config.writeKey) return response.status(401).json({ error: 'INVALID_WRITE_KEY' });

  try {
    const approval = verifyImportApproval({ secret: config.writeKey, token: request.body?.approvalToken });
    if (String(request.body?.batchId || '') !== approval.batchId) return response.status(400).json({ error: 'IMPORT_BATCH_MISMATCH' });
    const phase = String(request.body?.phase || 'papers');
    const cursor = Math.max(0, Number.parseInt(request.body?.cursor, 10) || 0);
    if (!PHASES.has(phase)) return response.status(400).json({ error: 'INVALID_IMPORT_PHASE' });
    const manifest = loadExpertImportManifest();
    const selection = selectExpertImport(manifest, approval.scope);
    if (phase === 'papers' && cursor === 0) await ensureNotionImportSchema(config);
    const phaseItems = phase === 'finalize' ? selection.papers : selection[phase];
    const items = phaseItems.slice(cursor, cursor + BATCH_SIZE);
    const results = [];
    const links = { papers: {}, concepts: {} };

    if (phase === 'papers') {
      const conceptTitleById = new Map(selection.concepts.map((concept) => [concept.roadmapId, concept.title]));
      for (const paper of items) {
        const result = await upsertNotionPaperFromImport({
          ...config,
          paper,
          batchId: approval.batchId,
          importVersion: manifest.asOf,
          templateVersion: manifest.templateVersion,
          roadmapConceptTitles: paper.roadmapConceptIds.map((id) => conceptTitleById.get(id)).filter(Boolean)
        });
        results.push({ phase, key: paper.externalKey, ...result });
        links.papers[paper.externalKey] = { id: result.id, url: result.url };
      }
    } else if (phase === 'concepts') {
      const catalog = await listNotionImportCatalog(config);
      const paperByKey = new Map(selection.papers.map((paper) => [paper.externalKey, paper]));
      for (const concept of items) {
        const paperRecords = concept.paperKeys.map((key) => {
          const source = paperByKey.get(key);
          return source ? catalog.papers.find((record) => record.externalKey === key || record.title.localeCompare(source.title, 'en', { sensitivity: 'base' }) === 0) : null;
        }).filter(Boolean);
        const result = await upsertNotionConceptFromImport({
          ...config,
          concept,
          paperRecords,
          batchId: approval.batchId,
          importVersion: manifest.asOf,
          templateVersion: manifest.templateVersion
        });
        results.push({ phase, key: concept.roadmapId, ...result });
        if (result.id) links.concepts[concept.roadmapId] = { id: result.id, url: result.url };
      }
    } else if (phase === 'relations') {
      const catalog = await listNotionImportCatalog(config);
      for (const relation of items) {
        const sourceConcept = conceptByRoadmapId(catalog, selection, relation.sourceRoadmapId);
        const targetConcept = conceptByRoadmapId(catalog, selection, relation.targetRoadmapId);
        if (!sourceConcept || !targetConcept) {
          results.push({ phase, key: relation.roadmapRelationId, held: true, reason: 'CONCEPT_REVIEW_REQUIRED' });
          continue;
        }
        const result = await upsertNotionRelationFromImport({
          ...config,
          relation,
          sourceConcept,
          targetConcept,
          batchId: approval.batchId,
          importVersion: manifest.asOf
        });
        results.push({ phase, key: relation.roadmapRelationId, ...result });
      }
    } else {
      for (const paper of items) {
        const result = await finalizeNotionPaperImport({ ...config, paper });
        results.push({ phase, key: paper.externalKey, ...result });
        if (result.id) links.papers[paper.externalKey] = { id: result.id, url: result.url };
      }
    }

    const next = nextImportCursor({ phase, cursor, selection, processed: items.length });
    response.setHeader('Cache-Control', 'private, no-store');
    return response.status(200).json({ batchId: approval.batchId, phase, cursor, processed: items.length, results, links, next });
  } catch (error) {
    console.error('Notion expert import apply failed', { code: error.code, status: error.status, message: error.message });
    return response.status(error.status || 502).json({ error: error.code || 'IMPORT_APPLY_FAILED' });
  }
}
