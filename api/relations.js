import { addNotionRelation } from '../lib/notion-roadmap.mjs';

const VALID_TYPES = new Set(['prerequisite', 'extends', 'enables', 'applies_to', 'contrasts_with']);
const PAGE_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  }
  const token = process.env.NOTION_TOKEN;
  const relationsDataSourceId = process.env.NOTION_RELATIONS_DATA_SOURCE_ID;
  const writeKey = process.env.ROADMAP_WRITE_KEY;
  if (!token || !relationsDataSourceId || !writeKey) return response.status(503).json({ error: 'WRITE_NOT_CONFIGURED' });
  if (request.headers['x-roadmap-write-key'] !== writeKey) return response.status(401).json({ error: 'INVALID_WRITE_KEY' });

  const sourceConceptId = String(request.body?.sourceConceptId || '').trim();
  const targetConceptId = String(request.body?.targetConceptId || '').trim();
  const type = String(request.body?.type || '').trim();
  const evidencePaperIds = Array.isArray(request.body?.evidencePaperIds) ? request.body.evidencePaperIds.map(String).filter((id) => PAGE_ID.test(id)) : [];
  const summary = String(request.body?.summary || '').trim();
  if (!PAGE_ID.test(sourceConceptId) || !PAGE_ID.test(targetConceptId) || sourceConceptId === targetConceptId || !VALID_TYPES.has(type) || !evidencePaperIds.length || summary.length > 1000) {
    return response.status(400).json({ error: 'INVALID_RELATION' });
  }

  try {
    return response.status(200).json({
      relation: await addNotionRelation({ token, relationsDataSourceId, sourceConceptId, targetConceptId, type, evidencePaperIds, summary })
    });
  } catch (error) {
    console.error('Notion relation update failed', { status: error.status, message: error.message });
    return response.status(502).json({ error: 'NOTION_RELATION_UPDATE_FAILED' });
  }
}
