import { login, refreshToken } from "./igLogin";

const proxy = process.env.API_PROXY;
const INITIAL_GRAPHQL_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_GRAPHQL_COOLDOWN_MS = 6 * 60 * 60 * 1000;
let graphqlCooldownUntil = 0;
let nextGraphqlCooldownMs = INITIAL_GRAPHQL_COOLDOWN_MS;

function applyGraphqlCooldown(response: Response) {
  const retryAfter = response.headers.get("retry-after");
  let cooldownMs = 0;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      cooldownMs = seconds * 1000;
    } else {
      const retryAt = Date.parse(retryAfter);
      if (Number.isFinite(retryAt)) cooldownMs = Math.max(0, retryAt - Date.now());
    }
  }
  if (!cooldownMs) cooldownMs = nextGraphqlCooldownMs;
  graphqlCooldownUntil = Date.now() + cooldownMs;
  nextGraphqlCooldownMs = Math.min(
    nextGraphqlCooldownMs * 2,
    MAX_GRAPHQL_COOLDOWN_MS
  );
  return cooldownMs;
}

/* Ordered list of a post's own media (carousel items, single video or single image) */
function extractMedia(post: any): MediaItem[] {
  if (post.carousel_media && post.carousel_media.length > 0) {
    return post.carousel_media.map((item: any) =>
      item.video_versions && item.video_versions.length > 0
        ? { url: item.video_versions[0].url, kind: "video" }
        : { url: item.image_versions2.candidates[0].url, kind: "image" }
    );
  }
  if (post.video_versions && post.video_versions.length > 0) {
    return [{ url: post.video_versions[0].url, kind: "video" }];
  }
  const linkedReelUrl = post.text_post_app_info?.link_preview_attachment?.url;
  const linkedReelId =
    typeof linkedReelUrl == "string"
      ? linkedReelUrl.match(/instagram\.com\/reels?\/([^/?#]+)/i)?.[1]
      : undefined;
  if (linkedReelId) {
    return [
      {
        url: `https://ig.210403.xyz/videos/${linkedReelId}/1`,
        kind: "video",
      },
    ];
  }
  if (post.image_versions2?.candidates?.length > 0) {
    return [{ url: post.image_versions2.candidates[0].url, kind: "image" }];
  }
  return [];
}

function hasPost(json: any): boolean {
  return json?.data?.data?.edges?.length > 0;
}

async function findPost({
  post,
  userAgent,
}: {
  post: string;
  userAgent: string;
}) {
  // Credit to threads-api for this snippet
  let threadID = post;
  threadID = threadID.split("?")[0];
  threadID = threadID.replace(/\s/g, "");
  threadID = threadID.replace(/\//g, "");
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let postID = 0n;
  for (const letter of threadID) {
    postID = postID * 64n + BigInt(alphabet.indexOf(letter));
  }

  let details = {
    variables: `{"check_for_unavailable_replies":true,"first":10,"postID":"${postID.toString()}","__relay_internal__pv__BarcelonaIsLoggedInrelayprovider":true,"__relay_internal__pv__BarcelonaIsThreadContextHeaderEnabledrelayprovider":false,"__relay_internal__pv__BarcelonaIsThreadContextHeaderFollowButtonEnabledrelayprovider":false,"__relay_internal__pv__BarcelonaUseCometVideoPlaybackEnginerelayprovider":false,"__relay_internal__pv__BarcelonaOptionalCookiesEnabledrelayprovider":false,"__relay_internal__pv__BarcelonaIsViewCountEnabledrelayprovider":false,"__relay_internal__pv__BarcelonaShouldShowFediverseM075Featuresrelayprovider":false}`,
    doc_id: "7448594591874178",
    lsd: "hgmSkqDnLNFckqa7t1vJdn",
  };
  let formBody: string[] = [];
  for (let property in details) {
    let encodedKey = encodeURIComponent(property);
    // @ts-ignore
    let encodedValue = encodeURIComponent(details[property]);
    formBody.push(encodedKey + "=" + encodedValue);
  }

  let finalFormBody = formBody.join("&");
  if (Date.now() < graphqlCooldownUntil) {
    console.log(
      `[POST FETCH] post=${post} graphql_cooldown_ms=${graphqlCooldownUntil - Date.now()}`
    );
    return false;
  }
  let fetchThreadsAPI = await fetch(`https://www.threads.com/api/graphql`, {
    method: "POST",
    headers: {
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": " same-origin",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
      "X-Fb-Lsd": "hgmSkqDnLNFckqa7t1vJdn",
      "X-Ig-App-Id": "238260118697367",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: finalFormBody,
    proxy,
  });
  let fetchThreadsAPIJson: any = await fetchThreadsAPI.json();
  if (fetchThreadsAPI.status == 429) {
    const cooldownMs = applyGraphqlCooldown(fetchThreadsAPI);
    console.log(
      `[POST FETCH] post=${post} status=429 graphql_cooldown_ms=${cooldownMs}`
    );
    return false;
  }
  if (hasPost(fetchThreadsAPIJson)) {
    graphqlCooldownUntil = 0;
    nextGraphqlCooldownMs = INITIAL_GRAPHQL_COOLDOWN_MS;
  }

  // Login-gated posts come back as an empty edges list, throttled requests as a null body
  if (
    (fetchThreadsAPIJson?.errors && fetchThreadsAPIJson.errors.length > 0) ||
    !hasPost(fetchThreadsAPIJson)
  ) {
    if (
      !fetchThreadsAPIJson?.errors?.length ||
      fetchThreadsAPIJson.errors[0].summary == "Not Logged In" ||
      fetchThreadsAPIJson.errors[0].summary == "Not Found" ||
      (fetchThreadsAPIJson.errors[0].message &&
        fetchThreadsAPIJson.errors[0].message.includes("limit exceeded"))
    ) {
      let fetchWithAuth: any;
      let generalFetchAuthErr = false;
      try {
        const loginDisabled = process.env.THREADS_LOGIN_DISABLED == "true";
        const newToken = loginDisabled ? false : await login();
        if (newToken == false) {
          if (fetchThreadsAPI.status == 429) {
            console.log(
              `[POST FETCH] post=${post} auth=${loginDisabled ? "disabled" : "unavailable"} status=429 retry=skipped`
            );
          } else {
            // Public post lookups can fail transiently; retry once without auth.
            fetchThreadsAPI = await fetch(`https://www.threads.com/api/graphql`, {
              method: "POST",
              headers: {
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Site": " same-origin",
                "User-Agent":
                  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
                "X-Fb-Lsd": "hgmSkqDnLNFckqa7t1vJdn",
                "X-Ig-App-Id": "238260118697367",
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: finalFormBody,
              proxy,
            });
            fetchThreadsAPIJson = await fetchThreadsAPI.json();
            if (fetchThreadsAPI.status == 429) {
              const cooldownMs = applyGraphqlCooldown(fetchThreadsAPI);
              console.log(
                `[POST FETCH] post=${post} retry_status=429 graphql_cooldown_ms=${cooldownMs}`
              );
              return false;
            }
            if (!hasPost(fetchThreadsAPIJson)) {
              console.log(
                `[POST FETCH] post=${post} auth=${loginDisabled ? "disabled" : "unavailable"} retry_status=${fetchThreadsAPI.status} edges=${fetchThreadsAPIJson?.data?.data?.edges?.length ?? 0}`
              );
            }
          }
        } else {
          fetchWithAuth = await fetch(`https://www.threads.com/api/graphql`, {
            method: "POST",
            headers: {
              "Sec-Fetch-Mode": "cors",
              "Sec-Fetch-Site": " same-origin",
              "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
              "X-Fb-Lsd": "hgmSkqDnLNFckqa7t1vJdn",
              "X-Ig-App-Id": "238260118697367",
              "Content-Type": "application/x-www-form-urlencoded",
              Authorization: newToken.token ? newToken.token : "",
            },
            body: finalFormBody,
            // No proxy: the account should keep the server's IP it logged in from
          });
          fetchThreadsAPIJson = await fetchWithAuth.json();
          if (fetchWithAuth.status == 429) {
            const cooldownMs = applyGraphqlCooldown(fetchWithAuth);
            console.log(
              `[POST FETCH] post=${post} auth_status=429 graphql_cooldown_ms=${cooldownMs}`
            );
            return false;
          }
        }
      } catch (e) {
        generalFetchAuthErr = true;
      }

      if (
        (fetchThreadsAPIJson?.errors && fetchThreadsAPIJson.errors.length > 0) ||
        generalFetchAuthErr
      ) {
        if (
          fetchThreadsAPIJson?.errors?.[0]?.summary == "Not Logged In" ||
          fetchThreadsAPIJson?.errors?.[0]?.api_error_code == 368 || // you're temporarily blocked error code
          fetchThreadsAPIJson?.errors?.[0]?.message?.includes("limit exceeded") ||
          generalFetchAuthErr
        ) {
          console.log(
            `Error using token. Requesting new token... ${new Date().toLocaleString()} ${post}`
          );
          const tokenRefresh = await refreshToken();
          if (tokenRefresh == false) return false;

          // The previous request was made with the token that just failed.
          // Refreshing the token alone cannot recover this lookup; retry it once.
          const retryResponse = await fetch(
            `https://www.threads.com/api/graphql`,
            {
              method: "POST",
              headers: {
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Site": " same-origin",
                "User-Agent":
                  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
                "X-Fb-Lsd": "hgmSkqDnLNFckqa7t1vJdn",
                "X-Ig-App-Id": "238260118697367",
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization: tokenRefresh.token || "",
              },
              body: finalFormBody,
            }
          );
          fetchThreadsAPIJson = await retryResponse.json();
          if (retryResponse.status == 429) {
            const cooldownMs = applyGraphqlCooldown(retryResponse);
            console.log(
              `[POST FETCH] post=${post} retry_status=429 graphql_cooldown_ms=${cooldownMs}`
            );
            return false;
          }
          if (!hasPost(fetchThreadsAPIJson)) {
            const summaries = (fetchThreadsAPIJson?.errors ?? [])
              .map((error: any) => error?.summary || error?.message)
              .filter(Boolean)
              .join("; ");
            console.log(
              `[POST FETCH] post=${post} retry_status=${retryResponse.status} errors=${summaries || "none"} edges=${fetchThreadsAPIJson?.data?.data?.edges?.length ?? 0}`
            );
          }
        }
      }
    } else {
      const summaries = (fetchThreadsAPIJson?.errors ?? [])
        .map((error: any) => error?.summary || error?.message)
        .filter(Boolean)
        .join("; ");
      console.log(
        `[POST FETCH] post=${post} status=${fetchThreadsAPI.status} errors=${summaries || "none"} edges=${fetchThreadsAPIJson?.data?.data?.edges?.length ?? 0}`
      );
      return false;
    }
  }
  if (!hasPost(fetchThreadsAPIJson)) {
    const summaries = (fetchThreadsAPIJson?.errors ?? [])
      .map((error: any) => error?.summary || error?.message)
      .filter(Boolean)
      .join("; ");
    console.log(
      `[POST FETCH] post=${post} status=${fetchThreadsAPI.status} errors=${summaries || "none"} edges=${fetchThreadsAPIJson?.data?.data?.edges?.length ?? 0}`
    );
    return false;
  }

  /* Handle Post Finding */
  let thread_items = fetchThreadsAPIJson.data.data.edges[0].node.thread_items;
  let index = 0;
  let postObj = thread_items.filter((item: any) => {
    index++;
    if (item.post.code == post) return item;
  })[0];
  const postIndex = thread_items.findIndex(
    (item: any) => item.post.code == post
  );
  const parentPost =
    postIndex > 0 && thread_items[postIndex - 1].post.user != null
      ? thread_items[postIndex - 1].post
      : null;

  /* Handle Captions */
  let caption;
  // The parent's user is null when the replied-to post is unavailable
  if (index > 1 && thread_items[index - 2].post.user != null) {
    caption =
      `⤴️ Replying to @${thread_items[index - 2].post.user.username}` +
      `\n\n` +
      (postObj.post.caption != null ? postObj.post.caption.text : "");
  } else {
    caption = postObj.post.caption != null ? postObj.post.caption.text : "";
  }
  let description = caption;

  /* Handle Polls */
  let poll = postObj.post.caption_add_on?.poll;
  if (poll && poll.tallies && poll.tallies.length > 0) {
    let totalVotes = poll.tallies.reduce(
      (sum: number, tally: any) => sum + tally.count,
      0
    );
    let pollText =
      `📊 ${totalVotes.toLocaleString()} vote${totalVotes == 1 ? "" : "s"}` +
      (poll.finished ? " · Final results" : "") +
      "\n" +
      poll.tallies
        .map((tally: any) => {
          let percent = totalVotes > 0 ? Math.round((tally.count / totalVotes) * 100) : 0;
          return `${tally.text}: ${percent}% (${tally.count.toLocaleString()})`;
        })
        .join("\n");
    description = description ? `${description}\n\n${pollText}` : pollText;
  }

  /* Setup oEmbed */
  let oembedStat = `❤️ ${postObj.post.like_count.toLocaleString()} like${
    postObj.post.like_count > 1 || postObj.post.like_count == 0 ? "s" : ""
  } | 💬 ${
    postObj.post.text_post_app_info.direct_reply_count
      ? postObj.post.text_post_app_info.direct_reply_count.toLocaleString()
      : "0 replies"
  }`;

  /* Handle Images */
  let images;
  let vidData: VideoProps[] = [];
  let imgType = "";
  const linkedReelUrl =
    postObj.post.text_post_app_info.link_preview_attachment?.url;
  const linkedReelId =
    typeof linkedReelUrl == "string"
      ? linkedReelUrl.match(/instagram\.com\/reels?\/([^/?#]+)/i)?.[1]
      : undefined;
  const linkedReelVideoUrl = linkedReelId
    ? `https://ig.210403.xyz/videos/${linkedReelId}/1`
    : undefined;
  let hasReel = Boolean(linkedReelVideoUrl);
  if (postObj.post.carousel_media && postObj.post.carousel_media.length > 0) {
    images = postObj.post.carousel_media
      .map((item: any) => {
        if (item.video_versions !== null && item.video_versions.length > 0) {
          vidData.push({ url: item.video_versions[0].url, type: "instagram", width: item.video_versions[0].width ?? undefined, height: item.video_versions[0].height ?? undefined });
          return null;
        }
        return {
          url: item.image_versions2.candidates[0].url,
        };
      })
      .filter((item) => item !== null);
    imgType = "carousel";
  } else if (
    postObj.post.text_post_app_info.link_preview_attachment &&
    postObj.post.text_post_app_info.link_preview_attachment.image_url
  ) {
    if (linkedReelVideoUrl) {
      images = [
        {
          url: postObj.post.text_post_app_info.link_preview_attachment.image_url,
        },
      ];
      imgType = "carousel";
    } else {
      images = [
        {
          url: postObj.post.text_post_app_info.link_preview_attachment
            .image_url,
        },
      ];
      imgType = "carousel";
    }
  } else {
    if (postObj.post.image_versions2.candidates.length > 0) {
      images = [
        {
          url: postObj.post.image_versions2.candidates[0].url,
        },
      ];
      imgType = "carousel";
    } else {
      images = [
        {
          url: postObj.post.user.profile_pic_url,
        },
      ];
      imgType = "single";
    }
  }
  if (hasReel && linkedReelVideoUrl) {
    vidData.push({
      url: linkedReelVideoUrl,
      type: "ddinstagram",
    });
  }

  /* Handle Videos */
  let video: VideoProps[] = [];
  if (postObj.post.video_versions || vidData.length >= 1) {
    if (vidData.length > 0) {
      video = vidData.map((item: any) => {
        return {
          url: item.url,
          type: item.type,
          width: item.width,
          height: item.height,
        };
      });
    } else {
      if (postObj.post.video_versions.length > 0) {
        video = [
          {
            url: postObj.post.video_versions[0].url,
            type: "instagram",
            width: postObj.post.video_versions[0].width ?? undefined,
            height: postObj.post.video_versions[0].height ?? undefined,
          },
        ];
      }
    }
  }

  /* Handle Quote Repost Posts */
  let quotedPost: QuotedPostProps = {
    username: "",
    caption: "",
    quoted: false,
  };
  // quoted_post.user (and caption) are null when the quoted post is unavailable
  const rawQuoted = postObj.post.text_post_app_info.share_info.quoted_post;
  if (rawQuoted != null && rawQuoted.user == null) {
    quotedPost = { username: "", caption: "", quoted: false, unavailable: true };
  } else if (rawQuoted != null) {
    quotedPost = {
      username: rawQuoted.user.username,
      caption: rawQuoted.caption?.text ?? "",
      quoted: true,
      verified: rawQuoted.user.is_verified ?? false,
      avatar: rawQuoted.user.profile_pic_url,
      code: rawQuoted.code,
      likeCount: rawQuoted.like_count ?? 0,
      replyCount: rawQuoted.text_post_app_info?.direct_reply_count ?? 0,
      takenAt: rawQuoted.taken_at,
      media: extractMedia(rawQuoted),
    };

    description =
      description +
      `\n\n↪ Quoting @${quotedPost.username}\n` +
      quotedPost.caption;
  }

  let returnJson = {
    description,
    title: `@${postObj.post.user.username} on Threads`,
    images,
    post,
    username: postObj.post.user.username,
    imageType: imgType,
    video,
    oembedStat,
    quotedPost,
    userAgent,
    // Components V2 embed data
    caption: postObj.post.caption != null ? postObj.post.caption.text : "",
    avatar: postObj.post.user.profile_pic_url,
    verified: postObj.post.user.is_verified ?? false,
    media: extractMedia(postObj.post),
    likeCount: postObj.post.like_count ?? 0,
    replyCount: postObj.post.text_post_app_info.direct_reply_count ?? 0,
    takenAt: postObj.post.taken_at,
    edited: postObj.post.caption_is_edited ?? false,
    paidPartnership: postObj.post.is_paid_partnership ?? false,
    replyTo: parentPost
      ? {
          username: parentPost.user.username,
          verified: parentPost.user.is_verified ?? false,
          code: parentPost.code,
          caption: parentPost.caption != null ? parentPost.caption.text : "",
        }
      : undefined,
    poll:
      poll && poll.tallies && poll.tallies.length > 0
        ? {
            options: poll.tallies.map((tally: any) => ({
              text: tally.text,
              count: tally.count,
            })),
            finished: poll.finished ?? false,
            expiresAt: poll.expires_at ?? undefined,
          }
        : undefined,
  };

  return returnJson;
}

export default findPost;
