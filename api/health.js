export default function handler(request, response) {
  const notionConfigured = Boolean(
    process.env.NOTION_TOKEN &&
    process.env.NOTION_PAPERS_DATA_SOURCE_ID &&
    process.env.NOTION_CONCEPTS_DATA_SOURCE_ID &&
    process.env.NOTION_RELATIONS_DATA_SOURCE_ID
  );
  response.status(200).json({
    ok: true,
    notionConfigured,
    threeDatabaseMode: notionConfigured,
    writeConfigured: Boolean(process.env.ROADMAP_WRITE_KEY)
  });
}
