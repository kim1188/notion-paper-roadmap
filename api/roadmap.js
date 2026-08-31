import { loadNotionRoadmap } from '../lib/notion-roadmap.mjs';

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  }

  const token = process.env.NOTION_TOKEN;
  const papersDataSourceId = process.env.NOTION_PAPERS_DATA_SOURCE_ID;
  const conceptsDataSourceId = process.env.NOTION_CONCEPTS_DATA_SOURCE_ID;
  const relationsDataSourceId = process.env.NOTION_RELATIONS_DATA_SOURCE_ID;
  const writeKey = process.env.ROADMAP_WRITE_KEY;
  const includeCandidates = String(request.query?.includeCandidates || '') === '1';
  if (!token || !papersDataSourceId || !conceptsDataSourceId || !relationsDataSourceId) {
    return response.status(503).json({
      error: 'NOTION_NOT_CONFIGURED',
      message: 'Notion 3개 DB 환경 변수를 서버에 설정해주세요.'
    });
  }
  if (includeCandidates && (!writeKey || request.headers['x-roadmap-write-key'] !== writeKey)) {
    return response.status(401).json({ error: 'CANDIDATE_ACCESS_DENIED' });
  }

  try {
    const snapshot = await loadNotionRoadmap({
      token,
      papersDataSourceId,
      conceptsDataSourceId,
      relationsDataSourceId,
      databaseUrl: process.env.NOTION_DATABASE_URL || '',
      includeCandidates
    });
    response.setHeader('Cache-Control', includeCandidates ? 'private, no-store' : 'public, s-maxage=30, stale-while-revalidate=300');
    return response.status(200).json(snapshot);
  } catch (error) {
    console.error('Notion roadmap sync failed', { status: error.status, message: error.message });
    return response.status(502).json({ error: 'NOTION_SYNC_FAILED', message: 'Notion DB를 불러오지 못했습니다.' });
  }
}
