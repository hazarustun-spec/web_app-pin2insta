# pin2insta

Drop images onto a white page, write a caption under each, and the tool posts
three a day to Instagram at fixed times.

Built for a growth account fed by irregular bulk uploads: you add pictures
whenever you think of them, and the schedule spends them evenly.

## Screens

| | |
|---|---|
| `/` | The queue. Drop images, write captions, drag to reorder, group into carousels, mark as stories. |
| `/published` | What went out, when, with which caption — plus likes, comments, reach and saves, and a suggestion about which posting time to change. |
| `/settings` | The three posting times, the timezone, and the fixed hashtag block. |

Everything is behind one password.

## Running it locally

```bash
vercel env pull .env.local   # pulls DATABASE_URL, BLOB_READ_WRITE_TOKEN, and the rest
npm install
npm run dev
```

```bash
npm test              # 728 tests
npx tsc --noEmit
npm run build
```

Without `IG_ACCESS_TOKEN` and `IG_USER_ID` the tool runs in **dry run**: it
validates exactly what it would send, marks items posted with a placeholder
permalink, and returns synthetic metrics. The whole flow — upload, caption,
schedule, history — works before the Instagram account exists. Connecting the
real account is an environment change, not a code change.

## Deploying

### 1. Environment variables

`DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` come from the Neon and Blob
integrations and are already set. Add the three secrets:

```bash
openssl rand -hex 16 | vercel env add ADMIN_PASSWORD production
openssl rand -hex 32 | vercel env add SESSION_SECRET production
openssl rand -hex 32 | vercel env add CRON_SECRET production
vercel deploy --prod
```

Three things that will otherwise cost you an afternoon:

- **`ADMIN_PASSWORD` must be random.** There is no rate limit on the login
  endpoint. A guessable password is the whole security model gone.
- **`SESSION_SECRET` must be set.** Without it the app answers 503 rather than
  authenticating, on purpose — a missing key must never mean "let everyone in".
  Changing either value signs every existing session out.
- **`CRON_SECRET` must be printable ASCII with no leading or trailing space.**
  HTTP strips edge whitespace from header values, so a secret with one could
  never be matched by any client and the scheduler would 401 forever. The route
  answers 503 and logs rather than letting that happen silently.

### 2. The scheduler

Vercel's Hobby plan fires a cron once a day, which cannot serve three slots, so
the schedule lives in GitHub Actions (`.github/workflows/cron.yml`).

**This repo has no git remote yet.** Push it to GitHub, then add two repository
secrets under Settings → Secrets and variables → Actions:

- `APP_URL` — the production URL, no trailing slash
- `CRON_SECRET` — the same value you set in Vercel

Note that GitHub disables scheduled workflows in a repository with no activity
for 60 days. If posting stops for no apparent reason, check the Actions tab
first.

### 3. Check it

```bash
curl -X POST "$APP_URL/api/cron/publish" -H "authorization: Bearer $CRON_SECRET"
```

Expect JSON with `"dryRun": true` and one entry per due slot. A wrong secret is
`401`; an unset one is `503`. The endpoint is POST-only — a GET is a 405.

## Connecting the Instagram account

The Graph API will not publish to a personal account. In order:

1. Convert the Instagram account to **Business** or **Creator**.
2. Link it to a **Facebook Page**.
3. Create a Meta app and add the **Instagram Graph API** product.
4. Grant `instagram_basic`, `instagram_content_publish`, and
   `pages_read_engagement`.
5. Generate a **long-lived access token**.
6. Set `IG_USER_ID` and `IG_ACCESS_TOKEN` in Vercel and redeploy.

**The token expires after 60 days.** Nothing in the app renews it. When it
lapses, publishing fails and the affected item is retried three times before
being marked failed — the queue page shows it.

## How it behaves

Worth knowing before it surprises you.

**An uncaptioned post stops the queue.** The scheduler takes the item at the
head and never skips past it, because queue order is your stated intent. So one
blank caption at position 1 leaves every slot empty until you write it. The
queue page says so, loudly. Stories are exempt — they publish without a caption.

**A missed slot is not made up.** Posting twice in an hour to catch up reads as
spam, so a skipped slot is simply lost.

**Duplicates are refused.** Every image is hashed after cropping, so the same
picture cannot be queued twice, whether dropped again or pasted from a link.
The hash survives publication, so it cannot be reposted months later either.

**Images are centre-cropped to 4:5** — Instagram's tallest accepted ratio. The
card shows the result, so you can catch a bad crop before it goes out.

**Changing the posting times is safe.** A slot is identified by its time, not
its position in the list, and a day never gets more posts than its schedule
allows by that hour. Adding an earlier time cannot cause a second post.

**Pinterest paste rarely works.** Pinterest serves no Open Graph tags to a
server-side request — verified, and not something the app can fix without
circumventing their bot protection, which it will not do. You will usually get
"görseli indirip sürükle". Download the image and drop it; that always works.

**Stories carry no engagement numbers.** Instagram publishes no likes, comments
or saves for them, so they are shown as unmeasured and left out of the posting-
time comparison rather than being averaged in as zeros.

**The slot suggestion is advice, not a finding.** It waits for 15 posts overall
and 5 in each slot it compares, and only speaks when one slot trails the best by
30% or more. That is still a small sample.

## Architecture

Next.js 16 App Router on Vercel. Postgres via Neon for the queue, settings and
history; Vercel Blob for the images, public because the Graph API fetches them
by URL and cannot authenticate.

```
src/lib/queue      queue order, slot arithmetic, ingest, the publisher
src/lib/images     hashing, 4:5 crop, thumbnails, Blob
src/lib/instagram  the Graph adapter and its dry-run twin
src/lib/insights   metrics and the slot comparison
src/lib/pinterest  pin URL → image
app/api/cron       the two scheduler endpoints
```

Uploads go **straight from the browser to Blob storage** and only the resulting
URLs are posted to the server. Vercel caps a function request body at 4.5MB —
about one photo — so routing a bulk drop through the server could never work.

Publishing is idempotent under overlapping cron runs: a unique index on
`(posted_date, slot_index)` and a claim that checks the rows it actually
updated. Once `media_publish` returns, the post exists and nothing in the code
will roll it back — a failure after that point is recorded, never retried.
