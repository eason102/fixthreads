import express from "express";
import findPost from "../utils/fetch/findPost";
import resolveShare from "../utils/fetch/resolveShare";
import renderSeo from "../utils/renderSeo";
import renderNotFound from "../utils/renderNotFound";
const router = express.Router();

function threadsPostUrl(username: string | undefined, post: string) {
  if (username)
    return `https://www.threads.com/@${username.replace(/^@+/, "")}/post/${post}`;
  return `https://www.threads.com/t/${post}`;
}

router.get("/t/:post", async (req, res, _next) => {
  const { post } = req.params;
  try {
    const data = await findPost({
      post,
      userAgent: req.headers["user-agent"] || "",
    });
    if (!data || !data.title) {
      console.log(`[NOT FOUND] post=${post}`);
      return res.redirect(threadsPostUrl(undefined, post));
    }
    return res.send(renderSeo({ type: "post", content: data }, `https://${req.get("host")}`));
  } catch (e: any) {
    console.error(`[ERROR] post=${post}`, e?.message ?? e);
    return res.redirect(threadsPostUrl(undefined, post));
  }
});

router.get("/share/:share", async (req, res, _next) => {
  // Links pasted inside Markdown can arrive with trailing ")_" etc.
  const share = req.params.share.match(/^[A-Za-z0-9_-]+/)?.[0];
  if (!share) return res.redirect("https://www.threads.com/");
  const shareUrl = `https://www.threads.com/share/${share}/`;
  try {
    const resolved = await resolveShare(share);
    if (resolved && "notFound" in resolved) {
      console.log(`[NOT FOUND] share=${share} deleted_or_private`);
      return res.send(renderNotFound(shareUrl));
    }
    if (!resolved) {
      console.log(`[NOT FOUND] share=${share}`);
      return res.redirect(shareUrl);
    }
    const data = await findPost({
      post: resolved.post,
      userAgent: req.headers["user-agent"] || "",
    });
    if (!data || !data.title) {
      console.log(`[NOT FOUND] share=${share} post=${resolved.post}`);
      return res.redirect(threadsPostUrl(resolved.username, resolved.post));
    }
    return res.send(renderSeo({ type: "post", content: data }, `https://${req.get("host")}`));
  } catch (e: any) {
    console.error(`[ERROR] share=${share}`, e?.message ?? e);
    return res.redirect(shareUrl);
  }
});

// Threads may append a title slug after the post code: /@user/post/CODE/some-title
router.get("/:username/post/:post{/*slug}", async (req, res, _next) => {
  const { username, post } = req.params;
  try {
    const data = await findPost({
      post,
      userAgent: req.headers["user-agent"] || "",
    });
    if (!data || !data.title) {
      console.log(`[NOT FOUND] username=${username} post=${post}`);
      return res.redirect(threadsPostUrl(username, post));
    }
    return res.send(renderSeo({ type: "post", content: data }, `https://${req.get("host")}`));
  } catch (e: any) {
    console.error(`[ERROR] username=${username} post=${post}`, e?.message ?? e);
    return res.redirect(threadsPostUrl(username, post));
  }
});

export default router;
