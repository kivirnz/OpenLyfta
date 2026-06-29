<div align="center">

<img src="assets/img/stickfigure.png" width="120" height="120" alt="OpenLyfta">

**OpenLyfta**

Self-hosted mirror, share-card generator, shareable workout pages & Telegram auto-poster for the [Lyfta](https://lyfta.app) workout tracker.

</div>

---

## Features

- **Mirror your Lyfta data locally** — syncs all workout history, exercises, and sets into a local SQLite database
- **Share-card generation** — composites body-map muscle overlays (primary in red, secondary in lighter red), workout stats (weight lifted, duration, total sets), and the OpenLyfta logo onto your workout pictures using `sharp`. Gender-aware: male/female body maps with automatic fallback
- **Exercise collage cards** — for workouts without a picture, automatically generates a 3×3 grid of exercise images with set counts and names, with multi-page support for 9+ exercises
- **Shareable workout pages** — generates unauthenticated `/share/:id` links anyone can open, showing your share card, workout stats, exercises with type badges (Weight × Reps, 2 Dumbbells, Bodyweight Assisted, etc.), decoded personal records (Est. 1RM, Max Weight, Max Set Volume, Max Reps), and set-by-set details
- **Telegram auto-posting** — automatically sends share cards to your Telegram chat when new workouts sync, with configurable caption templates supporting HTML formatting (`<b>`, `<i>`, `<u>`, `<s>`) and template tokens
- **Rate-limit aware bulk send** — bulk import sends all workouts to Telegram chronologically (oldest first) with 1.5s delay between each and automatic 429 retry handling
- **Weight unit toggle** — switch between kg and lbs everywhere (share cards, dashboard, Telegram captions)
- **Web dashboard** — browse workouts, view exercise/set details with record badges and exercise type badges, regenerate cards, send to Telegram, view logs, configure settings
- **CloudFront exercise catalog** — auto-discovers and caches Lyfta's exercise catalog for muscle-ID mapping
- **User profile** — fetches your Lyfta profile (gender, weight, name) via `viewProfileGraph` API
- **Unicode & emoji decoding** — handles `\uXXXX` escape sequences from Lyfta's API including emoji surrogate pairs (e.g. 🍤)
- **Built-in log viewer** — timestamped application logs viewable in the web UI settings

## Quick Start

### Docker Compose / Portainer (recommended)

1. Create the config directory and Caddyfile on your server:

```bash
mkdir -p /opt/docker/openlyfta/data
```

2. Create `/opt/docker/openlyfta/Caddyfile`:

```
:80 {
    reverse_proxy localhost:3000
}
```

3. Deploy the stack using Portainer or `docker compose`:

```yaml
services:
  openlyfta:
    image: wolfgirl/openlyfta:latest
    container_name: openlyfta
    restart: unless-stopped
    pull_policy: always
    ports:
      - "80:80"
    volumes:
      - /opt/docker/openlyfta/data:/data
      - /opt/docker/openlyfta/Caddyfile:/etc/caddy/Caddyfile:ro
```

4. Open `http://<server-ip>` in your browser. On first visit, set your admin password.

5. Go to **Settings**, enter your Lyfta email and password, then click **Sync now**.

### Docker Run

```bash
mkdir -p /opt/docker/openlyfta/data
docker run -d \
  --name openlyfta \
  -p 80:80 \
  -v /opt/docker/openlyfta/data:/data \
  -v /opt/docker/openlyfta/Caddyfile:/etc/caddy/Caddyfile:ro \
  --restart unless-stopped \
  wolfgirl/openlyfta:latest
```

### Local Development

```bash
npm install
npm start
```

Server runs on `http://localhost:3000`.

## Configuration

All settings can be configured via the web UI under **Settings**, or via environment variables:

| Setting | Env Variable | Description | Default |
|---------|-------------|-------------|---------|
| Lyfta email | `LYFTA_EMAIL` | Your Lyfta account email | — |
| Lyfta password | `LYFTA_PASSWORD` | Your Lyfta account password | — |
| Lyfta device ID | `LYFTA_DEVICE_ID` | Device ID string | `OpenLyfta, Server, 14` |
| Admin password | `OPENLYFTA_ADMIN_PASSWORD` | Password for web UI login | Set on first login |
| Weight unit | — | `kg` or `lbs` (toggle in Settings) | `kg` |
| Public URL | — | Base URL for shareable links (e.g. `https://gym.example.com`) | — |
| Sync schedule | — | Cron expression for auto-sync | `*/10 * * * *` |
| Telegram bot token | — | From [@BotFather](https://t.me/BotFather) | — |
| Telegram chat ID | — | Target chat/channel ID | — |
| Telegram auto-send | — | Send new workouts automatically | Off |

### Telegram Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and get the bot token
2. Get your chat ID (send a message to the bot, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates`)
3. Enter both in the web UI under **Settings → Telegram**

### Caption Template Tokens

Use these tokens in your Telegram caption template. HTML formatting is supported (`<b>`, `<i>`, `<u>`, `<s>`):

| Token | Description |
|-------|-------------|
| `<date>` | Workout date |
| `<title>` | Workout title (decoded) |
| `<workoutname>` | Same as `<title>` |
| `<duration>` | Workout duration |
| `<volume>` | Total volume (raw number) |
| `<volumeformatted>` | Total volume formatted (e.g. `5,150kg`) |
| `<totalsets>` | Total number of sets |
| `<exercises>` | Number of exercises |
| `<workoutnumber>` | Workout number |
| `<calories>` | Calories burned |
| `<bodyweight>` | Body weight |
| `<sharelink>` | Shareable workout page URL (requires Public URL setting) |

## Share Card Design

### Picture workouts
- Original workout photo as background
- Body-map muscle overlay at bottom-left (front + back views, 23.4% of image height)
  - Primary muscles highlighted in red (`#EB445A`)
  - Secondary/synergist muscles in lighter red (`#C87887`)
- Stats stacked vertically above body model (Weight Lifted, Duration, Total Sets) — centered, bold white
- OpenLyfta logo between the two body figures at the bottom

### No-picture workouts
- Auto-generated 3×3 exercise image collage (cover fit, no gray bars)
- `N × ExerciseName` labels under each image (truncated with ellipsis if too long)
- Right-aligned stats overlay at bottom-right corner
- OpenLyfta logo at bottom-left
- Multi-page support for 9+ exercises

## Shareable Workout Pages

Each workout has a public page at `/share/<id>` that shows:
- Share card image
- Workout title, date, user name
- Stats bar (Weight Lifted, Duration, Total Sets, Exercises)
- Exercise list with:
  - Colored type badges (Weight × Reps, 2 Dumbbells, Bodyweight Assisted, Distance · Duration, etc.)
  - Clean weight formatting (`30kg` not `30.000kg`)
  - Set numbers (`#1`, `#2`, etc.)
  - Decoded personal records (`🏆 Est. 1RM: 84`, `🏆 Max Weight: 60`)
  - Exercise notes with emoji support

## Dashboard Features

- Workout grid with card thumbnails, volume chips, and Telegram sent badges
- **View** dialog with full exercise/set breakdown, type badges, record badges, shareable link button
- **Regenerate all cards** — rebuild every share card with current settings
- **Send all to Telegram** — bulk upload oldest-first with rate limiting
- **Reset sent badges** — clear all Telegram sent flags
- **Settings** dialog with Lyfta credentials, Telegram config, caption template editor, weight unit toggle, public URL, cron schedule, and log viewer
- First-run onboarding prompt for history sync

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│   Caddy     │───▶│  Express (Node)  │───▶│   SQLite     │
│  (port 80)  │     │  supervisord     │     │  (better-    │
│  reverse    │     │  ┌─────────────┐ │     │   sqlite3)   │
│  proxy      │     │  │ Sync engine │ │     └──────────────┘
└─────────────┘     │  │ (Lyfta API) │ │
                    │  └─────────────┘ │     ┌──────────────┐
                    │  ┌─────────────┐ │───▶│  Telegram    │
                    │  │ Card gen    │ │     │  Bot API     │
                    │  │ (sharp)     │ │     └──────────────┘
                    │  └─────────────┘ │
                    │  ┌─────────────┐ │     ┌──────────────┐
                    │  │ Share pages │ │───▶│  Public web  │
                    │  │ (/share/:id)│ │     │  (no auth)   │
                    │  └─────────────┘ │     └──────────────┘
                    └──────────────────┘
```

- **Caddy** — reverse proxy, handles HTTP on port 80
- **Express** — web UI + REST API + public share pages
- **Sync engine** — mirrors Lyfta API data, discovers CloudFront exercise catalog
- **Card generator** — composites body-map overlays + stats onto workout pictures, or generates exercise collages
- **Share pages** — server-rendered unauthenticated HTML pages for public workout sharing
- **Telegram bot** — sends share cards with configurable HTML captions, rate-limit aware

## Project Structure

```
app/
├── src/
│   ├── index.js              # Entrypoint: Express server, routes, cron, auto-sync
│   ├── store.js              # SQLite schema + CRUD (workouts, exercises, profiles, logs)
│   ├── auth/session.js       # Session-based cookie auth
│   ├── lyfta/
│   │   ├── client.js         # Lyfta API client (login, feeds, exercises, profile, catalog)
│   │   └── sync.js           # Sync orchestrator (feed walk, backfill, catalog, profile)
│   ├── image/
│   │   ├── card.js           # Share-card + collage generator (sharp composite + SVG)
│   │   └── muscles.js        # Auto-generated muscle→drawable mapping (from APK)
│   ├── telegram/bot.js       # Telegram sendPhoto multipart sender + caption templates
│   ├── share/page.js         # Server-rendered public share page HTML generator
│   ├── lib/
│   │   ├── pipeline.js       # Orchestrates: sync → card gen → Telegram send
│   │   └── logger.js         # Logger wrapper (console + SQLite logs table)
│   └── routes/api.js         # REST API routes
├── public/
│   ├── index.html            # Dashboard GUI
│   ├── stickfigure.png       # OpenLyfta icon
│   ├── transparent.png       # OpenLyfta logo (transparent background)
│   └── favicon-32.png        # Favicon
├── assets/
│   ├── img/                  # Logo PNGs
│   ├── font/                 # Google Sans TTF for card text rendering
│   └── bodymaps/             # Male + female muscle overlay webps (from Lyfta APK)
├── Dockerfile                # Single-image build (Node + Caddy + supervisord)
├── docker-compose.yml        # Docker Compose / Portainer deployment
├── Caddyfile                 # Caddy reverse proxy config (HTTP port 80)
├── supervisord.conf          # Process manager config (Caddy + Node)
└── .gitignore
```

## License

This project is for personal use. Lyfta is a trademark of its respective owners. Neither the developer Riley Kivimäki nor OpenLyfta is affiliated with nor endorsed by Lyfta.
