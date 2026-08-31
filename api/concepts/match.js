import { matchNotionConcepts } from '../../lib/notion-roadmap.mjs';

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  }
  const token = process.env.NOTION_TOKEN;
  const conceptsDataSourceId = process.env.NOTION_CONCEPTS_DATA_SOURCE_ID;
  const writeKey = process.env.ROADMAP_WRITE_KEY;
  if (!token || !conceptsDataSourceId || !writeKey) return response.status(503).json({ error: 'MATCH_NOT_CONFIGURED' });
  if (request.headers['x-roadmap-write-key'] !== writeKey) return response.status(401).json({ error: 'INVALID_WRITE_KEY' });

  const title = String(request.query?.title || '').trim();
  const aliases = String(request.query?.aliases || '').split(',').map((value) => value.trim()).filter(Boolean);
  const summary = String(request.query?.summary || '').trim();
  if (!title || title.length > 120 || summary.length > 1000) return response.status(400).json({ error: 'INVALID_MATCH_QUERY' });
  try {
    return response.status(200).json(await matchNotionConcepts({ token, conceptsDataSourceId, title, aliases, summary, limit: 5 }));
  } catch (error) {
    console.error('Notion concept match failed', { status: error.status, message: error.message });
    return response.status(502).json({ error: 'NOTION_CONCEPT_MATCH_FAILED' });
  }
}
