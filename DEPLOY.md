# Deploying billsdepthchart.com

Three steps. **You** do the account/payment clicks (I can't sign in or pay as you);
everything in the code is already prepared. ~15 minutes total.

---

## 1. Buy the domain (~$10–15/yr)

`billsdepthchart.com` was **available** when last checked. Register it at any registrar —
[Cloudflare Registrar](https://dash.cloudflare.com) (at-cost, free WHOIS privacy) or
[Porkbun](https://porkbun.com) / [Namecheap](https://www.namecheap.com) are all fine.

- **Note:** ICANN caps registration at **10 years** — you can't buy 20 at once. Register for up to
  10 years and turn on **auto-renew** so it never lapses.
- Turn on **WHOIS privacy** (free at the registrars above).

---

## 2. Put the code on GitHub, then deploy on Render (free)

From the project folder:

```bash
cd "/Users/cjehle/Desktop/AI Trainings and Projects/Monthly Budget Insights/nfl-depth-chart"
git add -A
git commit -m "Launch-ready: optimizations, hardening, a11y, tests"
```

Create an **empty** repo at https://github.com/new named `nfl-depth-chart` (no README/.gitignore),
then run the two lines GitHub shows you — they look like:

```bash
git remote add origin https://github.com/<you>/nfl-depth-chart.git
git push -u origin main
```

Then on [Render](https://render.com): **New → Web Service → connect the repo**. Render reads
`render.yaml` automatically (Node, free plan, the update-schedule env vars, and the `/healthz`
health check). Click **Create Web Service**. In ~1 minute you'll get a URL like
`https://nfl-depth-chart-xxxx.onrender.com`.

---

## 3. Point the domain at Render

In the Render dashboard: **your service → Settings → Custom Domains → Add Custom Domain**. Add both:

- `billsdepthchart.com`
- `www.billsdepthchart.com`

Render will show you the exact DNS records to create (typically):

| Type  | Name  | Value                              |
|-------|-------|------------------------------------|
| ALIAS/ANAME or A | `@` (root)   | *(the target Render shows)*  |
| CNAME | `www` | `nfl-depth-chart-xxxx.onrender.com` |

Add those in your **registrar's DNS** settings. (On Cloudflare, set the records to **DNS only /
grey cloud** first so Render can issue its certificate.) Render auto-provisions HTTPS within a few
minutes; then both `billsdepthchart.com` and `www.` load the app over `https://`.

---

## Good to know
- **Free tier sleeps** after ~15 min idle → first visit after a lull takes ~30s to wake (and
  refreshes data), then it's fast. A free uptime pinger (e.g. UptimeRobot) hitting `/healthz` every
  ~10 min keeps it awake.
- **Update cadence** travels with the deploy: depth chart + injuries **daily**, Madden ratings
  **monthly**. Change anytime via the `DEPTH_TTL_HOURS` / `MADDEN_TTL_DAYS` env vars in Render.
- **Health check:** `GET /healthz` returns status + counters (no upstream calls).
- I'm happy to open each of these screens in the in-app browser and walk you through them field by
  field — I just can't type your password or card.
