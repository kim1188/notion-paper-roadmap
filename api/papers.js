import { createNotionPaper, listNotionPapers } from '../lib/notion-roadmap.mjs';

export default async function handler(request, response) {
  if (!['GET', 'POST'].includes(request.method)) {
    response.setHeader('Allow', 'GET, POST');
    return response.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  }
  const token = process.env.NOTION_TOKEN;
  const papersDataSourceId = process.env.NOTION_PAPERS_DATA_SOURCE_ID;
  const writeKey = process.env.ROADMAP_WRITE_KEY;
  if (!token || !papersDataSourceId || !writeKey) return response.status(503).json({ error: 'WRITE_NOT_CONFIGURED' });
  if (request.headers['x-roadmap-write-key'] !== writeKey) return response.status(401).json({ error: 'INVALID_WRITE_KEY' });
  if (request.method === 'GET') {
    try {
      return response.status(200).json({ papers: await listNotionPapers({ token, papersDataSourceId }) });
    } catch (error) {
      console.error('Notion paper list failed', { status: error.status, message: error.message });
      return response.status(502).json({ error: 'NOTION_PAPER_LIST_FAILED' });
    }
  }

  const paper = {
    title: String(request.body?.title || '').trim(),
    doi: String(request.body?.doi || '').trim(),
    originalUrl: String(request.body?.originalUrl || '').trim(),
    lilyUrl: String(request.body?.lilyUrl || '').trim(),
    authors: String(request.body?.authors || '').trim(),
    year: Number(request.body?.year || 0) || undefined,
    summary: String(request.body?.summary || '').trim()
  };
  if (!paper.title || paper.title.length > 200 || paper.summary.length > 1000) {
    return response.status(400).json({ error: 'INVALID_PAPER' });
  }

  try {
    return response.status(201).json({ page: await createNotionPaper({ token, papersDataSourceId, ...paper }) });
  } catch (error) {
    if (error.code === 'PAPER_DUPLICATE') return response.status(409).json({ error: error.code, duplicate: error.duplicate });
    console.error('Notion paper creation failed', { status: error.status, message: error.message });
    return response.status(502).json({ error: 'NOTION_PAPER_CREATE_FAILED' });
  }
}
