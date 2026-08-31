import { updateNotionLayout } from '../lib/notion-roadmap.mjs';

const PAGE_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export default async function handler(request, response) {
  if (request.method !== 'PATCH') {
    response.setHeader('Allow', 'PATCH');
    return response.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  }
  const token = process.env.NOTION_TOKEN;
  const writeKey = process.env.ROADMAP_WRITE_KEY;
  if (!token || !writeKey) return response.status(503).json({ error: 'WRITE_NOT_CONFIGURED' });
  if (request.headers['x-roadmap-write-key'] !== writeKey) return response.status(401).json({ error: 'INVALID_WRITE_KEY' });

  const kind = String(request.body?.kind || '').trim();
  const pageId = String(request.body?.pageId || '').trim();
  const layout = request.body?.layout;
  if (!['concept', 'relation'].includes(kind) || !PAGE_ID.test(pageId) || !layout || typeof layout !== 'object' || Array.isArray(layout)) {
    return response.status(400).json({ error: 'INVALID_LAYOUT' });
  }
  try {
    return response.status(200).json({ layout: await updateNotionLayout({ token, kind, pageId, layout }) });
  } catch (error) {
    const status = error.status && error.status < 500 ? error.status : 502;
    return response.status(status).json({ error: error.code || 'NOTION_LAYOUT_UPDATE_FAILED' });
  }
}
