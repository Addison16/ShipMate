/**
 * Private-use characters around matched words in conversation search snippets. They never occur
 * in real text, so the web app can highlight matches without rendering any HTML from the server.
 */
export const SEARCH_MARK = { start: "\uE000", end: "\uE001" } as const;
