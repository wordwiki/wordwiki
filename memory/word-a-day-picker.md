---
name: word-a-day-picker
description: "wordADayPicker report — category tree of unposted PUBLIC words for the twitter/bluesky word-a-day poster; built 2026-07-03, awaiting dz review on twitter-report branch"
metadata: 
  node_type: memory
  type: project
  originSessionId: 79a19dac-20df-4670-9659-1faf4a308444
---

A language-team member posts a word-a-day (twitter + bluesky, ~20 years,
~3.8k posted) and stamps the `twitter-post` attribute (a date; ANY non-empty
value = posted, any subentry marks the whole word — same semantics as the
old Entries-by-Twitter-Post-Status report). Choosing the next word was the
pain; dz's proposal: the category tree with unposted words inline.

`wordwiki.wordADayPicker()` (wordwiki.ts, next to entriesByTwitterPostStatus;
Home Reports + navbar Reports + cross-link from the twitter report): jump
index of all themes/categories with unposted counts, then per-category word
lists (headword : glosses linking to the entry). Runs off the in-memory
publishedEntries + memoized entriesByCategory (dz's instinct: the JSON model,
not the db). ~3.2k distinct unposted public words, ~7.9k inline links (words
avg 2.4 categories — appearing under EACH is deliberate), 0.08s warm.

Decisions taken with dz away (defaults he can override): pool =
publishedEntries (public formula — a posted word should be finished+visible;
~3.2k vs ~5.1k for all entries); alphabetical within category; Uncategorized
bucket renders only when non-empty (correct that it's empty today: all 56
category-less entries are non-Completed). Not built: audio-marker chip,
random-suggestion button. Tests: word-a-day_test.ts (seeded fixture:
posted/non-public excluded, uncategorized bucket, untabled category group).

Related: [[wordwiki-categorization]], [[publication-approval-model]].
