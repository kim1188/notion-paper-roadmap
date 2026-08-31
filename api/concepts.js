import { createNotionConcept } from '../lib/notion-roadmap.mjs';

const PAGE_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  }
  const token = process.env.NOTION_TOKEN;
  const conceptsDataSourceId = process.env.NOTION_CONCEPTS_DATA_SOURCE_ID;
  const writeKey = process.env.ROADMAP_WRITE_KEY;
  if (!token || !conceptsDataSourceId || !writeKey) return response.status(503).json({ error: 'WRITE_NOT_CONFIGURED' });
  if (request.headers['x-roadmap-write-key'] !== writeKey) return response.status(401).json({ error: 'INVALID_WRITE_KEY' });

  const concept = {
    title: String(request.body?.title || '').trim(),
    aliases: Array.isArray(request.body?.aliases) ? request.body.aliases.map((value) => String(value).trim()).filter(Boolean).slice(0, 20) : [],
    domains: Array.isArray(request.body?.domains) ? request.body.domains.map((value) => String(value).trim()).filter(Boolean).slice(0, 10) : [],
    summary: String(request.body?.summary || '').trim(),
    paperIds: Array.isArray(request.body?.paperIds) ? request.body.paperIds.map(String).filter((id) => PAGE_ID.test(id)).slice(0, 50) : []
  };
  if (!concept.title || concept.title.length > 120 || !concept.domains.length || !concept.summary || concept.summary.length > 1000) {
    return response.status(400).json({ error: 'INVALID_CONCEPT' });
  }

  try {
    return response.status(201).json({ concept: await createNotionConcept({ token, conceptsDataSourceId, ...concept }) });
  } catch (error) {
    if (error.code === 'CONCEPT_DUPLICATE' || error.code === 'CONCEPT_REVIEW_REQUIRED') {
      return response.status(409).json({ error: error.code, duplicate: error.duplicate || null, matches: error.matches || [] });
    }
    console.error('Notion concept creation failed', { status: error.status, message: error.message });
    return response.status(502).json({ error: 'NOTION_CONCEPT_CREATE_FAILED' });
  }
}
