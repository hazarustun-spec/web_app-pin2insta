# pin2insta — Design Spec

**Date:** 2026-08-08
**Status:** Approved

## Purpose

A private web tool for scheduling Instagram posts. The user drops images onto a
white page, writes a caption for each one, and the tool publishes three posts per
day at fixed times. The goal is a consistent posting rhythm for a growth-oriented
account, fed by irregular bulk uploads.

## Constraints

- Publishing requires an Instagram Business or Creator account linked to a
  Facebook Page, a Meta app, and a long-lived access token. The account does not
  exist yet, so the tool must run end-to-end without one.
- The Instagram Graph API fetches images from public URLs. Images must be hosted.
- Instagram accepts aspect ratios between 4:5 and 1.91:1 and rejects anything else.
- Content publishing is capped at 100 posts per 24 hours. Three per day is safe.
- No AI. Captions are written by hand.

## Architecture

Next.js 16 (App Router, TypeScript) deployed to Vercel. Images live in Vercel
Blob as public objects. The queue, settings, and publish history live in Postgres
provisioned through the Vercel Marketplace. A GitHub Actions cron hits a
protected endpoint every 15 minutes; Vercel Cron is not used because the Hobby
plan only triggers once per day.

### Modules

| Module | Responsibility |
|---|---|
| `lib/queue` | Queue ordering, slot assignment, due-slot calculation |
| `lib/instagram` | Graph API adapter — feed, carousel, story, insights |
| `lib/images` | Hashing, 4:5 crop, Blob upload and deletion |
| `lib/pinterest` | Resolve a pin URL to an image |
| `lib/auth` | Password session |
| `app/api/cron/publish` | Scheduler entry point |
| `app/api/cron/insights` | Metric refresh |

Each module is independently testable. The Instagram adapter is the only place
that talks to Meta, and it has a dry-run implementation selected by the absence
of a token.

## Screens

### `/` — Queue

A single page. A dropzone sits at the top; below it, a grid of cards in publish
order. The header shows posts-per-day and queue depth ("3/gün · 12 gün").

Each card shows the cropped image, an editable caption, the computed publish slot
("Bugün 14:00"), and its type (feed, carousel, story). Cards are reordered by
dragging. Checkboxes enable a selection bar with "Carousel yap", "Story yap", and
"Sil".

The dropzone accepts local files and a pasted Pinterest URL.

### `/published` — History

One row per published post: thumbnail, timestamp, the caption exactly as sent,
a permalink to Instagram, and metrics (likes, comments, reach, saves). Metrics
come from Graph API Insights, which is free and requires no third-party service.

Once at least 15 posts have data, the page shows a slot comparison: average
engagement per time slot, with a suggestion to move an underperforming slot.
Before that threshold it shows progress ("veri toplanıyor · 7/15").

### `/settings`

Three slot times, timezone (default `Europe/Istanbul`), the fixed hashtag set,
and the admin password.

## Visual design

White background, thin grey rules, black type. Images carry the page; the chrome
recedes. No color except for error states.

### Caption save animation

Triggered by `⌘↵` or blur, only when the caption actually changed:

1. Textarea border moves from grey to black over 120ms.
2. A hairline sweeps left to right beneath the text over 220ms, ease-out.
3. A checkmark appears at the card's lower right — opacity 0→1, scale 0.85→1,
   translateY 2px→0, over 180ms.
4. The checkmark holds for 900ms, then fades over 200ms.
5. The border returns to grey over 400ms.

The checkmark is absolutely positioned so nothing reflows. The animation is
optimistic: it plays before the request resolves. On failure the checkmark is
replaced by a thin red underline and the message "kaydedilemedi, tekrar dene".
`⌘↵` advances focus to the next caption-less card while the previous card's
animation continues, so a run of thirty cards leaves a trail of quiet
checkmarks. Under `prefers-reduced-motion: reduce`, only the checkmark fade
plays. Implemented in plain CSS keyframes; no animation library.

## Data flow

### Ingest

A dropped file is hashed with SHA-256. If the hash already exists in the
database, the file is rejected with "zaten var" — duplicate content harms a
growth account. Otherwise sharp crops it to 4:5 from the center, uploads it to
Blob, and inserts a queue row with status `pending` and an empty caption.

A pasted Pinterest URL is fetched server-side and its `og:image` extracted, then
follows the same path. If Pinterest blocks the request, the UI tells the user to
download the image and drop it instead.

### Publish

Every 15 minutes GitHub Actions calls `/api/cron/publish` with `CRON_SECRET`.
The handler computes which slots are due today in the configured timezone, and
for each due slot checks whether a post already exists for that `(date,
slot_index)` pair — a unique constraint makes the operation idempotent, so
overlapping cron runs cannot double-post.

For a due, unfilled slot the handler takes the first `pending` item in queue
order. If its caption is empty the slot is skipped, the item is flagged, and a
banner appears on the queue page. A post is never published without a caption;
hashtag-only posts hurt a growth account.

Publishing by type:

- **feed** — `POST /media` then `POST /media_publish`
- **carousel** — one child container per image with `is_carousel_item=true`, then
  a `CAROUSEL` container listing the children, then publish
- **story** — `POST /media` with `media_type=STORIES`, then publish

The fixed hashtag set is appended to the caption at publish time.

On success the row moves to `posted` with its permalink and timestamp. The
full-size Blob object is deleted and replaced by a 320px thumbnail, so the
history page does not depend on Instagram's CDN URLs, which expire. The SHA-256
hash is retained so duplicate detection keeps working against published images.

### Metrics

`/api/cron/insights` runs every six hours and refreshes metrics for the thirty
most recent published posts.

## Error handling

A Graph API failure increments `attempts` and leaves the item `pending`; the next
tick retries. After three attempts the item becomes `failed` with the API error
message shown on its card. A missed slot does not roll into the next one —
catching up would post twice in an hour and read as spam.

Queue depth below three days raises a banner on the queue page. Notifications are
in-UI only; no email service.

## Instagram-free operation

When `IG_ACCESS_TOKEN` is unset the adapter runs in dry-run: it validates the
payload, logs what would be sent, marks the item `posted` with a placeholder
permalink, and returns synthetic metrics. The entire flow — upload, caption,
scheduling, history — is exercisable before the account exists. Connecting the
real account is an environment change, not a code change.

## Testing

Vitest covers slot-due calculation across timezone and DST boundaries, queue
ordering and reordering, publish idempotency under concurrent cron runs, the
empty-caption skip, duplicate rejection by hash, crop geometry, and the dry-run
adapter's payload shapes.

## Environment

`IG_USER_ID`, `IG_ACCESS_TOKEN`, `CRON_SECRET`, `BLOB_READ_WRITE_TOKEN`,
`ADMIN_PASSWORD`, `DATABASE_URL`.

## Known risks

**Pinterest ingest.** Republishing someone else's pin invites a copyright
complaint and, repeated, account termination. The user accepted this. The tool
only resolves `og:image` and does not bypass access controls.

**Center crop** removes content at the edges. The card shows the crop result so
it can be caught before publishing.

**Unattended captions.** Nothing reviews a caption between writing and
publishing. The card displays it until the slot fires.

## Out of scope

Reels and video. Multiple accounts. Scheduling beyond three fixed daily slots.
Automatic hashtag research. Email notifications.
