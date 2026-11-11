import escape from "escape-html";

// Card for links whose post Threads confirms is gone. Crawlers (Discord etc.)
// show the card so the preview does not look like a broken embed; browsers
// follow the meta refresh to Threads like on a normal post page.
// The description must start with "Post not found" so rinai-link-bot's embed
// monitor classifies it as a content problem, not a fixer failure.
export default function renderNotFound(originalUrl: string) {
  const url = escape(originalUrl);
  return `<!DOCTYPE html>
<html>
  <head>
    <meta content="text/html; charset=UTF-8" http-equiv="Content-Type" />
    <link rel="canonical" href="${url}" />
    <meta property="og:site_name" content="FixThreads" />
    <meta property="og:title" content="Threads" />
    <meta property="og:description" content="Post not found · 貼文已刪除、設為私人，或連結已失效" />
    <meta property="og:url" content="${url}" />
    <meta name="theme-color" content="#808080" />
    <meta http-equiv="refresh" content="0;url=${url}" />
  </head>
</html>
`;
}
