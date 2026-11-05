/* Real URLs behind the component embed's short /m/<post>/<slot> media links.

   Discord re-requests these links whenever its own media cache lets go, often days later and
   for every slot of a post at once, so:
   - a post is looked up again only shortly before its signed CDN URLs (oe=) expire;
   - concurrent requests for one post share a single lookup;
   - when a lookup fails (rate limited, cooldown), the last known URLs are served, which
     usually stay valid for days, and that post is not looked up again for a while;
   - entries are kept in ./generated so a redeploy does not drop them. */
import fs from "node:fs";
import findPost from "./fetch/findPost";
import { mediaSlots } from "./renderComponentEmbed";

type Urls = Record<string, string>;
type Entry = { urls: Urls; at: number; expires: number; failedAt?: number };

const DEFAULT_TTL = 6 * 60 * 60 * 1000; // URLs without an oe= expiry
const REFRESH_BEFORE = 30 * 60 * 1000; // look up again this long before oe= expires
const RETRY_AFTER_FAILURE = 10 * 60 * 1000;
const KEEP_EXPIRED = 24 * 60 * 60 * 1000; // stale URLs are still worth a try for a day
const MAX_POSTS = 1000;
const SAVE_DELAY = 10 * 1000;

const proxies = process.env.PROXIES?.split(",") || [];
const generatedDir = __dirname + "/../../generated";
const storePath = generatedDir + "/media.json";
const store = new Map<string, Entry>();
const pending = new Map<string, Promise<Urls | undefined>>();

/** Earliest oe= (hex Unix seconds) among the URLs, as a timestamp in ms. */
function expiryOf(urls: Urls, at: number) {
  let earliest = Infinity;
  for (const url of Object.values(urls)) {
    let decoded = url;
    try {
      decoded = decodeURIComponent(url);
    } catch {}
    const oe = decoded.match(/[?&]oe=([0-9a-f]+)/i)?.[1];
    if (oe) earliest = Math.min(earliest, parseInt(oe, 16) * 1000);
  }
  return Number.isFinite(earliest) ? earliest : at + DEFAULT_TTL;
}

function load() {
  try {
    if (!fs.existsSync(storePath)) return;
    const entries: [string, Entry][] = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    const now = Date.now();
    for (const [post, entry] of entries)
      if (entry?.urls && now < entry.expires + KEEP_EXPIRED) store.set(post, entry);
    console.log(`[MEDIA] loaded=${store.size}`);
  } catch (e: any) {
    console.error(`[MEDIA] load failed`, e?.message ?? e);
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSave() {
  saveTimer ??= setTimeout(() => {
    saveTimer = undefined;
    try {
      fs.mkdirSync(generatedDir, { recursive: true });
      const tmp = storePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify([...store]));
      fs.renameSync(tmp, storePath);
    } catch (e: any) {
      console.error(`[MEDIA] save failed`, e?.message ?? e);
    }
  }, SAVE_DELAY);
}

function remember(post: string, urls: Urls) {
  const at = Date.now();
  store.delete(post);
  store.set(post, { urls, at, expires: expiryOf(urls, at) });
  while (store.size > MAX_POSTS) store.delete(store.keys().next().value!);
  scheduleSave();
  return urls;
}

async function lookUp(post: string) {
  const data = await findPost({ post, userAgent: "" }).catch((e: any) => {
    console.error(`[MEDIA] lookup failed post=${post}`, e?.message ?? e);
    return undefined;
  });
  if (data) {
    const proxy = proxies[Math.floor(Math.random() * proxies.length)];
    return remember(post, mediaSlots(data, proxy));
  }
  const hit = store.get(post);
  if (!hit) return undefined;
  hit.failedAt = Date.now();
  console.log(`[MEDIA] post=${post} lookup failed, serving stale urls`);
  return hit.urls;
}

/** Media slot URLs of a post, from the cache or by fetching the post again. */
export async function postMedia(post: string, content?: ContentProps) {
  if (content) {
    const proxy = proxies[Math.floor(Math.random() * proxies.length)];
    return remember(post, mediaSlots(content, proxy));
  }
  const hit = store.get(post);
  const now = Date.now();
  if (hit) {
    const fresh = now < hit.expires - REFRESH_BEFORE;
    const backingOff = hit.failedAt && now - hit.failedAt < RETRY_AFTER_FAILURE;
    if (fresh || backingOff) return hit.urls;
  }
  let lookup = pending.get(post);
  if (!lookup) {
    lookup = lookUp(post).finally(() => pending.delete(post));
    pending.set(post, lookup);
  }
  return lookup;
}

load();
