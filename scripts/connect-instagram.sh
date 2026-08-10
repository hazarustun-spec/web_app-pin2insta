#!/usr/bin/env bash
#
# Connects the Instagram account: exchanges a short-lived token for a long-lived
# one, finds the Instagram Business Account id behind your Facebook Page, writes
# both into Vercel production, and redeploys.
#
#   ./scripts/connect-instagram.sh <APP_SECRET> <SHORT_LIVED_TOKEN>
#
# Neither secret is printed. The only things echoed are the Page name, the
# Instagram user id (not a secret) and the token's expiry date.
#
# Read before running: the moment this finishes, the dry-run gate opens. If the
# queue holds a captioned item, the next due slot posts it to Instagram for
# real, and that cannot be undone.

set -euo pipefail

APP_ID=1681032883005069
GRAPH=https://graph.facebook.com/v25.0

APP_SECRET=${1:-}
SHORT_TOKEN=${2:-}

if [[ -z "$APP_SECRET" || -z "$SHORT_TOKEN" ]]; then
  echo "usage: $0 <APP_SECRET> <SHORT_LIVED_TOKEN>" >&2
  exit 1
fi

# Reads one field out of a JSON body without printing the rest of it — a Graph
# response carries the token, so it must never reach the terminal wholesale.
field() { node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    let j; try { j = JSON.parse(s) } catch { console.error("not JSON:", s.slice(0,200)); process.exit(1) }
    if (j.error) { console.error("Graph error:", j.error.message ?? JSON.stringify(j.error)); process.exit(1) }
    const path = process.argv[1].split(".");
    let v = j; for (const k of path) v = v?.[k];
    if (v === undefined || v === null) { console.error("missing field:", process.argv[1]); process.exit(1) }
    process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v));
  })' "$1"; }

echo "1/5  exchanging the short-lived token…"
LONG_JSON=$(curl -sS -G "$GRAPH/oauth/access_token" \
  --data-urlencode "grant_type=fb_exchange_token" \
  --data-urlencode "client_id=$APP_ID" \
  --data-urlencode "client_secret=$APP_SECRET" \
  --data-urlencode "fb_exchange_token=$SHORT_TOKEN")
LONG_TOKEN=$(printf '%s' "$LONG_JSON" | field access_token)
EXPIRES=$(printf '%s' "$LONG_JSON" | field expires_in 2>/dev/null || echo "")
if [[ -n "$EXPIRES" ]]; then
  echo "     ok — expires in $(( EXPIRES / 86400 )) days"
else
  echo "     ok"
fi

echo "2/5  finding your Facebook Page…"
PAGES=$(curl -sS -G "$GRAPH/me/accounts" --data-urlencode "access_token=$LONG_TOKEN")
PAGE_COUNT=$(printf '%s' "$PAGES" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(String((j.data??[]).length))})')
if [[ "$PAGE_COUNT" == "0" ]]; then
  echo "     no Pages. The Instagram account must be linked to a Facebook Page," >&2
  echo "     and the token needs the pages_show_list permission." >&2
  exit 1
fi
printf '%s' "$PAGES" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  for (const p of JSON.parse(s).data ?? []) console.log("     -", p.name, "("+p.id+")")})'
PAGE_ID=$(printf '%s' "$PAGES" | field data.0.id)

echo "3/5  finding the Instagram account behind it…"
IG_JSON=$(curl -sS -G "$GRAPH/$PAGE_ID" \
  --data-urlencode "fields=instagram_business_account{id,username}" \
  --data-urlencode "access_token=$LONG_TOKEN")
if ! printf '%s' "$IG_JSON" | grep -q instagram_business_account; then
  echo "     that Page has no Instagram Business Account attached." >&2
  echo "     Check: the Instagram account is Business or Creator, and linked to this Page." >&2
  exit 1
fi
IG_USER_ID=$(printf '%s' "$IG_JSON" | field instagram_business_account.id)
IG_USERNAME=$(printf '%s' "$IG_JSON" | field instagram_business_account.username 2>/dev/null || echo "?")
echo "     @$IG_USERNAME  id=$IG_USER_ID"

echo "4/5  writing both into Vercel production…"
vercel env rm IG_USER_ID production --yes >/dev/null 2>&1 || true
vercel env rm IG_ACCESS_TOKEN production --yes >/dev/null 2>&1 || true
vercel env add IG_USER_ID production --value "$IG_USER_ID" --yes >/dev/null
vercel env add IG_ACCESS_TOKEN production --value "$LONG_TOKEN" --yes >/dev/null
echo "     done"

echo "5/5  redeploying (env changes do not reach a live deployment on their own)…"
vercel deploy --prod >/dev/null 2>&1
echo "     done"

cat <<EOF

Connected. @$IG_USERNAME

Verify — dryRun should now be false and "disabled" should be gone:

  curl -X POST "https://pin2insta.vercel.app/api/cron/publish" \\
    -H "authorization: Bearer \$CRON_SECRET"

The token lasts about 60 days. Nothing renews it. When it lapses, publishing
fails and the item is retired after three attempts; the queue page shows it.
Re-run this script with a fresh short-lived token to replace it.
EOF
