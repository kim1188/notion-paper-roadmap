import { addNotionDomain } from '../lib/notion-roadmap.mjs';

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  }

  const token = process.env.NOTION_TOKEN;
  const conceptsDataSourceId = process.env.NOTION_CONCEPTS_DATA_SOURCE_ID;
  const writeKey = process.env.ROADMAP_WRITE_KEY;
  if (!token || !conceptsDataSourceId || !writeKey) {
    return response.status(503).json({ error: 'WRITE_NOT_CONFIGURED' });
  }
  if (request.headers['x-roadmap-write-key'] !== writeKey) {
    return response.status(401).json({ error: 'INVALID_WRITE_KEY' });
  }

  const name = String(request.body?.name || '').trim();
  const color = String(request.body?.color || 'purple').trim();
  if (!name || name.length > 40 || name.includes(',')) {
    return response.status(400).json({ error: 'INVALID_DOMAIN_NAME' });
  }

  try {
    const domain = await addNotionDomain({ token, conceptsDataSourceId, name, color });
    return response.status(200).json({ domain });
  } catch (error) {
    console.error('Notion domain update failed', { status: error.status, message: error.message });
    return response.status(502).json({ error: 'NOTION_DOMAIN_UPDATE_FAILED' });
  }
}
