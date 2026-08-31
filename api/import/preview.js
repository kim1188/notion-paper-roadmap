import crypto from 'node:crypto';
import { createImportApproval, importPreviewDigest, loadExpertImportManifest, selectExpertImport } from '../../lib/expert-import.mjs';
import { inspectNotionImportSchema, listNotionImportCatalog, planNotionImport } from '../../lib/notion-roadmap.mjs';

function configuration() {
  return {
    token: process.env.NOTION_TOKEN,
    papersDataSourceId: process.env.NOTION_PAPERS_DATA_SOURCE_ID,
    conceptsDataSourceId: process.env.NOTION_CONCEPTS_DATA_SOURCE_ID,
    relationsDataSourceId: process.env.NOTION_RELATIONS_DATA_SOURCE_ID,
    writeKey: process.env.ROADMAP_WRITE_KEY
  };
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
    const manifest = loadExpertImportManifest();
    const selection = selectExpertImport(manifest, request.body || {});
    const [catalog, schemaGaps] = await Promise.all([
      listNotionImportCatalog(config),
      inspectNotionImportSchema(config)
    ]);
    const preview = planNotionImport({ catalog, selection, schemaGaps });
    const previewDigest = importPreviewDigest({ manifest, selection, preview });
    const batchId = `expert-roadmap-${manifest.asOf}-${crypto.randomUUID().slice(0, 8)}`;
    const approvalToken = createImportApproval({ secret: config.writeKey, batchId, selection, previewDigest });
    response.setHeader('Cache-Control', 'private, no-store');
    return response.status(200).json({
      batchId,
      manifest: { version: manifest.version, asOf: manifest.asOf, templateVersion: manifest.templateVersion },
      scope: selection.scope,
      previewDigest,
      approvalToken,
      preview
    });
  } catch (error) {
    console.error('Notion expert import preview failed', { code: error.code, status: error.status, message: error.message });
    return response.status(error.status || 502).json({ error: error.code || 'IMPORT_PREVIEW_FAILED' });
  }
}
