import type { Pack } from "./index.ts";
import { score } from "./generic.ts";

/**
 * Social posts. The big feeds are denied by default, so this pack mostly meets standalone post
 * pages, fediverse instances and hosts the user re-enabled; its signals are the platforms' own
 * URL shapes and the appeals that close a post.
 */
export const social: Pack = {
  id: "social",
  stateHint: "social media post or thread",
  keepHints: {
    true: "Concrete announcements, dates, places, offers, links and numbers count.",
    false: "Storytelling, inspiration, humility and calls to like, repost or agree do not.",
  },
  match: (meta) =>
    score(meta, {
      jsonLd: ["socialmediaposting", "discussionforumposting"],
      paths: ["status", "statuses", "posts", "pulse"],
      hosts: ["linkedin.com", "twitter.com", "x.com", "facebook.com", "threads.net", "bsky.app", "mastodon.social", "mastodon.online"],
      cues: ["repost if", "link in the first comment", "link in bio", "agree?", "humbled", "follow me", "condividi se"],
    }),
};
