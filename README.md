# The Bench by Pointed Discovery

Public demo site for two tools:

- **Pre-Suit Advisor**: values any civil claim. It researches comparable verdicts (CourtListener) and news (Parallel Search), then returns the odds at each stage, a damages range, all-in exposure, nuclear verdict risk and a settlement range.
- **The Bench**: consent-based AI arbitration. Two people on different devices open, consent to, file, and get a ruling on a dispute. Card charges are simulated.

No sign-in is needed. Visitors are identified by a random id stored in their browser.

## Deploy on Vercel (about 10 minutes)

1. Push this folder to a GitHub repository.
2. In Vercel, choose **Add New → Project**, import the repository, and deploy with the default settings. There is no build step.
3. In the project, open **Storage → Create Database → Upstash for Redis** (free tier is fine) and connect it to the project. This fills in `KV_REST_API_URL` and `KV_REST_API_TOKEN` and switches on two-person disputes.
4. In **Settings → Environment Variables**, add:
   - `ANTHROPIC_API_KEY` (required)
   - `PARALLEL_API_KEY` (for news results)
   - `COURTLISTENER_TOKEN` (recommended; free from your CourtListener profile)
5. Redeploy so the variables take effect.

Optional limits (defaults shown): `DAILY_AI_CAP=400` AI calls per day across the whole site, `AI_PER_HOUR=40` and `RESEARCH_PER_HOUR=12` per visitor IP. `ANTHROPIC_MODEL` defaults to `claude-sonnet-5-5`.

## How it is built

- `public/`: the single-page app (plain HTML, CSS and JavaScript), demo cases and logos.
- `api/ai.js`: valuation, judge questions, rulings and demo answers. The server builds every prompt, so the site can't be used as an open AI proxy.
- `api/research.js`: lets Claude run CourtListener and Parallel searches on the server and keeps only links that came back from those searches.
- `api/disputes.js`: shared storage for The Bench (Upstash Redis). Disputes expire after 30 days. Status changes are computed on the server.
- `api/health.js`: tells the page which features are switched on.

Without Redis, The Bench still works, but each dispute stays in one browser tab.

## Known limits of the demo

- Anyone with a dispute's invite code can read it; there are no accounts.
- Payments are simulated. Production would use Stripe saved cards and Stripe Connect.
- Trellis is not included; it needs a separate Trellis API agreement.
