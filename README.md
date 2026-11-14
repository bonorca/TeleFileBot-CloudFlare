# TeleFileBot

> A personal file storage bot for Telegram, powered by Cloudflare Workers + D1. Zero cost. Zero servers. Unlimited uptime.
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## Features

- **Instant Backup** — Send any file to your bot and it's saved automatically
- **Auto-Naming** — Files with meaningless names (`photo_123.jpg`, `IMG_4521.HEIC`, `Screenshot_…`) are renamed after their content, e.g. `鲜果超市购物小票_2026-11-14.jpg`
- **Auto-Classification** — Every upload is sorted into a fixed category by Workers AI (reads the file name, your caption, and the image)
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
               |                 |
               |                 +---> Workers AI (classification)
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

> **Upgrading an existing install?** Your database predates the `category` column. Run this once instead of Step 3:
>
> ```bash
> npm run db:migrate
> ```

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

Notation: `<arg>` required · `[arg]` optional · `...` repeatable

**BROWSE**

| Synopsis                 | Description                                                        |
| ------------------------ | ------------------------------------------------------------------ |
| `/list [<category>]`     | List categories, or the files in `<category>`. A tag also works.   |
| `/all`                   | List all files, newest first.                                      |
| `/get <name>`            | Send a file. Partial names work; AI searches when no name matches. |

**MANAGE**

| Synopsis                 | Description                       |
| ------------------------ | --------------------------------- |
| `/cat <name>`            | Change a file's category.         |
| `/rename <name> [<new>]` | Rename a file; without `<new>` the bot asks for it. |
| `/tag <name> <tag>...`   | Add one or more tags.             |
| `/delete <name>`         | Delete a file, after confirmation.|

**MAINTENANCE**

| Synopsis     | Description                                          |
| ------------ | ---------------------------------------------------- |
| `/classify`  | Categorize and name older files, 8 at a time.        |
| `/stats`     | Show storage statistics.                             |
| `/help`      | Show this help (also syncs Telegram's `/` menu).     |

### Auto-naming

The same AI call that picks the category also suggests a name. It is only used when the original name says nothing — names generated by Telegram/this bot (`photo_…`, `video_…`, `document_…`), camera names (`IMG_`, `DSC_`, `PXL_` …), `Screenshot…`, `微信图片_…`, pure numbers or hashes. Meaningful names like `Resume_Dylan.pdf` are never touched. If the model gives nothing usable the file becomes `<category>_<date>`, and a numeric suffix is added on clashes.

Tap **✏️ Rename** under any saved file (or send `/rename <name>`) and reply with the new name; leave out the extension to keep the old one. `/classify` also renames older files that still have generic names.

### How `/get` finds files

1. Exact name (case-insensitive) → 2. name contains the text → 3. name contains every word, in any order. A single match is sent immediately.
4. Only if nothing matches by name, Workers AI reads the list of file names, categories and tags and suggests up to 5 files — so `/get 我的简历`, `/get jianli` or `/get 加拿大资金证明` work. AI suggestions are shown as a pick list, never sent automatically. One AI search costs roughly 9 Neurons per ~40 files (it scales with the number of files, capped at the 1,500 most recent).

File lists show numbered entries; tap a number to get that file, or **🖼 Preview** to receive the page's images as an album.

**Uploading:** Just send any file, photo, video, or audio message — it's saved and classified automatically. Adding a caption (e.g. "报销用") helps the classifier. Tap **Change category** under the confirmation if it guessed wrong.

---

## Auto-Classification

Each file goes into exactly one of these fixed categories:

| Category | What goes there |
| -------- | --------------- |
| 📚 学习 | Course material, papers, notes, homework |
| 💼 工作 | Contracts, reports, resumes, meeting notes |
| 💰 财务 | Invoices, receipts, bills, tax, bank statements |
| 🪪 证件 | ID cards, passports, visas, certificates, transcripts |
| 📖 书籍 | E-books, novels, comics |
| 📷 照片 | Camera photos |
| 🖼 截图 | Screenshots, chat logs |
| 🎬 影音 | Movies, music, podcasts, voice messages |
| 💿 软件 | Installers, source code, config files |
| 😀 表情包 | Stickers, memes, GIFs |
| 📦 其他 | Anything else |

How it decides:

1. **Rules first, no AI call** — stickers/GIFs → 表情包, voice/video notes → 影音, `.epub/.mobi/...` → 书籍, `.apk/.exe/.dmg/...` → 软件.
2. **Otherwise Workers AI** (`@cf/google/gemma-4-26b-a4b-it`) reads the file name, MIME type, caption, forward source, and a small preview image (photos, image files, or the thumbnail Telegram provides for videos and some documents).
3. **If the AI call fails**, it falls back to a MIME-based guess, so uploads never fail because of classification.

**Cost:** Workers AI gives 10,000 free Neurons per day. A classification is a few hundred input tokens, which is a handful of Neurons, so personal use stays well inside the free allocation.

**Existing files:** files saved before this feature show as ❔ 未分类. Send `/classify` to sort them in batches.

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
const AI_MODEL = '@cf/google/gemma-4-26b-a4b-it'; // Classifier model (needs vision + chat messages)
const CLASSIFY_BATCH_SIZE = 8; // Files per /classify run
```

The categories themselves are the `CATEGORIES` list at the top of `src/index.js`. The category key is stored in the database, so renaming one means updating existing rows too.

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
