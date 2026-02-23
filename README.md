# TeleFileBot

> A personal file storage bot for Telegram, powered by Cloudflare Workers + D1. Zero cost. Zero servers. Unlimited uptime.
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## Features

- **Instant Backup** — Send any file to your bot and it's saved automatically
- **Fuzzy Search** — Find files by partial name matching
- **Tags** — Organize files with custom tags
- **Pagination** — Browse large collections with inline keyboard navigation
- **Rename** — Rename files without re-uploading
- **Stats** — View storage statistics at a glance
- **Private** — Admin-only access, files stored in a private channel
- **Free** — Runs entirely on Cloudflare's free tier
- **Fast** — Edge-deployed, responds in milliseconds globally

### Supported File Types

| Type           | Extensions                                     |
| -------------- | ---------------------------------------------- |
| Documents      | PDF, DOCX, ZIP, and any file type              |
| Photos         | JPG, PNG, WebP (auto-saved at highest quality) |
| Videos         | MP4, MKV, etc.                                 |
| Audio          | MP3, FLAC, OGG, etc.                           |
| Voice Messages | OGG (Telegram voice)                           |
| Video Notes    | MP4 (Telegram circles)                         |
| Stickers       | WebP (static stickers)                         |
| Animations     | GIF / MP4                                      |

---

## Architecture

```
You --> Telegram Bot --> Cloudflare Worker --> D1 (metadata)
               |
               +---> Private Channel (file storage)
```

Files are stored natively on Telegram's servers via a private channel. The D1 database only stores metadata (file names, tags, IDs). This means:

- **No storage limits** beyond Telegram's 2GB per-file cap
- **No egress costs** — files are served directly by Telegram
- **Durable** — as long as the channel exists, files persist

---

## Quick Start

### One-Click Setup

```bash
git clone https://github.com/yourname/telefilebot-cloudflare.git
cd telefilebot-cloudflare
chmod +x setup.sh
./setup.sh
```

The setup script will walk you through everything interactively.

### Manual Setup

<details>
<summary>Click to expand manual instructions</summary>

#### Prerequisites

- [Node.js](https://nodejs.org) >= 18
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm install -g wrangler`)
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

#### Step 1: Clone & Install

```bash
git clone https://github.com/yourname/telefilebot-cloudflare.git
cd telefilebot-cloudflare
npm install
```

#### Step 2: Create D1 Database

```bash
wrangler d1 create telefilebot-cloudflare-db
```

Copy the `database_id` from the output and paste it into `wrangler.jsonc`.

#### Step 3: Apply Schema

```bash
wrangler d1 execute telefilebot-cloudflare-db --file=schema.sql --remote
```

#### Step 4: Configure Secrets

```bash
wrangler secret put BOT_TOKEN      # From @BotFather
wrangler secret put BOT_SECRET     # Any random string (for webhook URL security)
wrangler secret put CHANNEL_ID     # Your private channel ID (e.g. -100xxxxxxxxxx)
wrangler secret put ADMIN_ID       # Your Telegram user ID
```

> **How to get your Channel ID:** Add [@RawDataBot](https://t.me/RawDataBot) to your channel, it will post a message containing the channel ID. Remove it after.
>
> **How to get your User ID:** Message [@userinfobot](https://t.me/userinfobot) on Telegram.

#### Step 5: Deploy

```bash
wrangler deploy
```

#### Step 6: Register Webhook

Open this URL in your browser:

```
https://your-worker.workers.dev/registerWebhook
```

</details>

---

## Commands

| Command                     | Description                       |
| --------------------------- | --------------------------------- |
| `/start`                    | Welcome message                   |
| `/help`                     | Show all commands                 |
| `/list`                     | List all files (paginated)        |
| `/list tag`                 | Filter files by tag               |
| `/get filename`             | Retrieve a file (fuzzy match)     |
| `/delete filename`          | Delete a file (with confirmation) |
| `/tag filename tag1 tag2`   | Add tags to a file                |
| `/rename old_name new_name` | Rename a file                     |
| `/stats`                    | Show storage statistics           |

**Uploading:** Just send any file, photo, video, or audio message — it's saved automatically.

---

## Configuration

### Environment Variables (Secrets)

| Variable     | Description                                      |
| ------------ | ------------------------------------------------ |
| `BOT_TOKEN`  | Telegram bot token from @BotFather               |
| `BOT_SECRET` | Random string to secure the webhook URL          |
| `CHANNEL_ID` | Telegram channel ID for file storage             |
| `ADMIN_ID`   | Your Telegram user ID (only you can use the bot) |

### Customization

Edit `src/index.js` constants at the top of the file:

```js
const PAGE_SIZE = 10; // Files per page in /list
const MAX_FUZZY_RESULTS = 10; // Max results for fuzzy search
const MAX_FILENAME_LEN = 200; // Max characters in file names
```

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
