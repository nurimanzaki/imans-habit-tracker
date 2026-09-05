# Habit Tracker

A calm, personal daily habit and routine tracker. Mobile-first, installable
as a PWA, backed by a real Supabase (Postgres) database, deployable free on
GitHub Pages.

## How your data is stored

- **Database:** Supabase (hosted Postgres). Every table has Row Level
  Security enabled, so a signed-in user can only ever read or write their
  own rows — see `supabase/migrations/0001_init.sql`.
- **Sign-in:** email magic link (no password to manage, no Google Cloud
  setup required). Click the link that's emailed to you and you're in.
- **Sync:** your data follows you across any device you sign into.
- **Backup:** Settings → Export JSON/CSV gives you a portable copy any time.

## 1. Create your Supabase project

1. Go to [supabase.com](https://supabase.com) → New project (free tier is
   plenty for personal use).
2. Once it's ready, open **SQL Editor** → New query, paste the contents of
   `supabase/migrations/0001_init.sql`, and run it. This creates the two
   tables (`user_settings`, `daily_records`) with RLS policies already in
   place.
3. Open **Authentication → Sign In / Providers** and confirm **Email** is
   enabled (it is by default). No extra configuration needed for magic
   links.
4. Open **Authentication → URL Configuration** and set:
   - **Site URL**: your future GitHub Pages URL, e.g.
     `https://<your-username>.github.io/<your-repo>/`
   - **Redirect URLs**: add the same URL
   (You can update these later once you know your exact Pages URL — see
   step 4 below. Until then `http://localhost:5173` works for local dev.)
5. Open **Project Settings → API** and copy:
   - **Project URL**
   - **anon public** key (never copy the `service_role` key into this app)

## 2. Run it locally

```bash
cp .env.example .env
# paste your Project URL and anon key into .env
npm install
npm run dev
```

Sign in with your email, check your inbox, click the link, confirm the app
loads and saves correctly.

## 3. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

## 4. Add your Supabase keys as GitHub secrets

The build needs your Supabase URL/key at build time, but they should never
be committed to the repo. In your GitHub repo:

**Settings → Secrets and variables → Actions → New repository secret**,
add both:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

(The anon key is safe to expose in a built frontend bundle — it's designed
for that — but keeping it as a secret rather than committed in plaintext is
still good hygiene.)

## 5. Turn on GitHub Pages

1. Repo → **Settings → Pages** → set **Source** to **GitHub Actions**.
2. Push to `main` (or re-run the workflow from the **Actions** tab) — it
   builds and deploys automatically.
3. Once green, your app is live at:
   `https://<your-username>.github.io/<your-repo>/`
4. Go back to Supabase → **Authentication → URL Configuration** and make
   sure that exact URL is set as both the **Site URL** and in
   **Redirect URLs** — otherwise the magic-link email will send you
   somewhere wrong.

## 6. Install it on your phone

Open the live URL on your phone, then:

- **iOS Safari:** Share → "Add to Home Screen"
- **Android Chrome:** menu (⋮) → "Add to Home screen" / "Install app"

## Updating later

Any push to `main` rebuilds and redeploys automatically.

## Project structure

```
src/
  App.jsx              – Daily, Dashboard, Settings screens + scoring logic
  lib/supabaseClient.js – Supabase client setup
  lib/db.js             – all database reads/writes, isolated from the UI
  main.jsx, index.css
supabase/migrations/0001_init.sql – schema + Row Level Security policies
.github/workflows/deploy.yml       – build + deploy pipeline
```

## Notes

- Icons in `public/` are simple placeholders — swap in your own 192×192 and
  512×512 PNGs whenever you like.
- Wanting Google sign-in instead of email links later is a small change:
  enable the Google provider in Supabase Auth and swap
  `signInWithOtp` for `signInWithOAuth({ provider: "google" })` in
  `SignInScreen`.
