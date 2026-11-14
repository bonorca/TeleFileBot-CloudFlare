// TeleFileBot — Cloudflare

import { Buffer } from 'node:buffer';

const PAGE_SIZE = 10;
const MAX_FUZZY_RESULTS = 10;
const MAX_FILENAME_LEN = 200;
const CALLBACK_DATA_LIMIT = 64; // Telegram's limit

// ---- Auto-classification ----

// Workers AI model used to classify files. Must accept OpenAI-style messages
// with image_url parts (vision) and return choices[0].message.content.
const AI_MODEL = '@cf/google/gemma-4-26b-a4b-it';

// Images larger than this are not sent to the model (keeps CPU time and
// token usage low). Photos and thumbnails are normally far below it.
const PREVIEW_MAX_BYTES = 1024 * 1024;

// How many unclassified files /classify processes per run.
const CLASSIFY_BATCH_SIZE = 8;

// Fixed categories. The key is stored in the database, so rename with care.
const CATEGORIES = [
	{ key: '学习', emoji: '📚', desc: '课程资料、讲义、论文、笔记、作业、考试、学习录音' },
	{ key: '工作', emoji: '💼', desc: '合同、报告、方案、简历、会议纪要、项目文档、工作表格' },
	{ key: '财务', emoji: '💰', desc: '发票、收据、账单、报税、银行流水、工资单、保单' },
	{ key: '证件', emoji: '🪪', desc: '身份证、护照、签证、驾照、学生证、各类证书、成绩单' },
	{ key: '书籍', emoji: '📖', desc: '电子书、小说、漫画、杂志' },
	{ key: '照片', emoji: '📷', desc: '用相机拍的生活照、人物、风景、旅行、美食' },
	{ key: '截图', emoji: '🖼', desc: '手机或电脑屏幕截图、聊天记录、网页截图' },
	{ key: '影音', emoji: '🎬', desc: '电影、剧集、短视频、音乐、播客、语音' },
	{ key: '软件', emoji: '💿', desc: '安装包、源代码、脚本、配置文件、程序压缩包' },
	{ key: '表情包', emoji: '😀', desc: '表情、贴纸、梗图、GIF 动图' },
	{ key: '其他', emoji: '📦', desc: '以上都不符合' },
];
const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);
const UNCATEGORIZED = '未分类';

const BOOK_EXTS = new Set(['epub', 'mobi', 'azw', 'azw3', 'fb2', 'djvu', 'cbz', 'cbr']);
const APP_EXTS = new Set(['apk', 'apks', 'xapk', 'ipa', 'exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'appimage']);

// =============================================================================
//  Telegram API Layer
// =============================================================================

/**
 * Low-level Telegram Bot API call.
 * @param {string} token  - Bot token
 * @param {string} method - Telegram API method name
 * @param {object} body   - JSON-serialisable payload
 * @returns {Promise<object>}
 */
async function tg(token, method, body = {}) {
	const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Telegram API ${method} HTTP ${res.status}: ${text}`);
	}

	const json = await res.json();
	if (!json.ok) {
		throw new Error(`Telegram API ${method} failed: ${json.description || 'unknown error'}`);
	}
	return json;
}

async function sendMessage(token, chatId, text, extra = {}) {
	return tg(token, 'sendMessage', {
		chat_id: chatId,
		text,
		parse_mode: 'HTML',
		...extra,
	});
}

async function forwardMessage(token, chatId, fromChatId, messageId) {
	return tg(token, 'forwardMessage', {
		chat_id: chatId,
		from_chat_id: fromChatId,
		message_id: messageId,
	});
}

async function copyMessage(token, chatId, fromChatId, messageId) {
	return tg(token, 'copyMessage', {
		chat_id: chatId,
		from_chat_id: fromChatId,
		message_id: messageId,
	});
}

async function answerCallback(token, callbackId, text = '') {
	return tg(token, 'answerCallbackQuery', {
		callback_query_id: callbackId,
		text,
	});
}

async function editMessage(token, chatId, messageId, text, extra = {}) {
	return tg(token, 'editMessageText', {
		chat_id: chatId,
		message_id: messageId,
		text,
		parse_mode: 'HTML',
		...extra,
	});
}

// =============================================================================
//  Database Layer
// =============================================================================

async function dbRun(db, sql, params = []) {
	return db
		.prepare(sql)
		.bind(...params)
		.run();
}

async function dbAll(db, sql, params = []) {
	const result = await db
		.prepare(sql)
		.bind(...params)
		.all();
	return result.results ?? [];
}

async function dbFirst(db, sql, params = []) {
	return db
		.prepare(sql)
		.bind(...params)
		.first();
}

// =============================================================================
//  Utility Helpers
// =============================================================================

/**
 * Format bytes into a human-readable string.
 */
function formatFileSize(bytes) {
	if (!bytes || bytes <= 0) return 'Unknown';
	const units = ['B', 'KB', 'MB', 'GB'];
	let i = 0;
	let size = bytes;
	while (size >= 1024 && i < units.length - 1) {
		size /= 1024;
		i++;
	}
	return `${i === 0 ? size : size.toFixed(i > 2 ? 2 : 1)} ${units[i]}`;
}

/**
 * Escape HTML special characters for Telegram HTML parse mode.
 */
function escapeHtml(text) {
	return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Truncate a string to fit Telegram's callback_data limit while
 * keeping it useful.
 */
function truncateForCallback(str, maxLen = 20) {
	return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

/**
 * Sanitise a file name: remove control chars, trim, and cap length.
 */
function sanitizeFileName(name) {
	return name
		.replace(/[\x00-\x1f\x7f]/g, '')
		.replace(/[/\\:*?"<>|]/g, '_')
		.trim()
		.slice(0, MAX_FILENAME_LEN);
}

// =============================================================================
//  File Type Extraction
// =============================================================================

/**
 * Extract file metadata from a Telegram message.
 * Supports: document, photo, video, audio, voice, video_note, sticker, animation.
 * Returns null if the message contains no file.
 */
function extractFileInfo(message) {
	const ts = Date.now();

	if (message.document) {
		const doc = message.document;
		const mimeType = doc.mime_type ?? '';
		// Small image documents are previewed as-is; anything else uses its thumbnail.
		const preview =
			mimeType.startsWith('image/') && (doc.file_size ?? Infinity) <= PREVIEW_MAX_BYTES
				? { fileId: doc.file_id, mime: mimeType }
				: thumbPreview(doc);
		return {
			kind: 'document',
			fileId: doc.file_id,
			fileUniqueId: doc.file_unique_id,
			fileSize: doc.file_size ?? 0,
			mimeType,
			fileName: doc.file_name ?? `document_${ts}`,
			preview,
		};
	}

	if (message.photo) {
		const photo = message.photo[message.photo.length - 1]; // largest size
		// Smallest size that is still legible for the model
		const small = message.photo.find((p) => Math.max(p.width, p.height) >= 512) ?? photo;
		return {
			kind: 'photo',
			fileId: photo.file_id,
			fileUniqueId: photo.file_unique_id,
			fileSize: photo.file_size ?? 0,
			mimeType: 'image/jpeg',
			fileName: `photo_${ts}.jpg`,
			preview: { fileId: small.file_id, mime: 'image/jpeg' },
		};
	}

	if (message.video) {
		return {
			kind: 'video',
			fileId: message.video.file_id,
			fileUniqueId: message.video.file_unique_id,
			fileSize: message.video.file_size ?? 0,
			mimeType: message.video.mime_type ?? 'video/mp4',
			fileName: message.video.file_name ?? `video_${ts}.mp4`,
			preview: thumbPreview(message.video),
		};
	}

	if (message.animation) {
		return {
			kind: 'animation',
			fileId: message.animation.file_id,
			fileUniqueId: message.animation.file_unique_id,
			fileSize: message.animation.file_size ?? 0,
			mimeType: message.animation.mime_type ?? 'video/mp4',
			fileName: message.animation.file_name ?? `animation_${ts}.mp4`,
			preview: null,
		};
	}

	if (message.audio) {
		return {
			kind: 'audio',
			fileId: message.audio.file_id,
			fileUniqueId: message.audio.file_unique_id,
			fileSize: message.audio.file_size ?? 0,
			mimeType: message.audio.mime_type ?? 'audio/mpeg',
			fileName: message.audio.file_name ?? message.audio.title ?? `audio_${ts}.mp3`,
			preview: thumbPreview(message.audio),
		};
	}

	if (message.voice) {
		return {
			kind: 'voice',
			fileId: message.voice.file_id,
			fileUniqueId: message.voice.file_unique_id,
			fileSize: message.voice.file_size ?? 0,
			mimeType: message.voice.mime_type ?? 'audio/ogg',
			fileName: `voice_${ts}.ogg`,
			preview: null,
		};
	}

	if (message.video_note) {
		return {
			kind: 'video_note',
			fileId: message.video_note.file_id,
			fileUniqueId: message.video_note.file_unique_id,
			fileSize: message.video_note.file_size ?? 0,
			mimeType: 'video/mp4',
			fileName: `videonote_${ts}.mp4`,
			preview: null,
		};
	}

	if (message.sticker && !message.sticker.is_animated) {
		return {
			kind: 'sticker',
			fileId: message.sticker.file_id,
			fileUniqueId: message.sticker.file_unique_id,
			fileSize: message.sticker.file_size ?? 0,
			mimeType: 'image/webp',
			fileName: `sticker_${ts}.webp`,
			preview: null,
		};
	}

	return null;
}

/**
 * Preview image from a media object's thumbnail (Bot API renamed `thumb` to `thumbnail`).
 */
function thumbPreview(media) {
	const thumb = media.thumbnail ?? media.thumb;
	return thumb ? { fileId: thumb.file_id, mime: 'image/jpeg' } : null;
}

// =============================================================================
//  Auto-classification
// =============================================================================

/**
 * Categories that can be decided without the model.
 * `kind` is null for files already in the database (backfill); the bot's own
 * generated name prefixes stand in for it there.
 */
function ruleCategory({ kind, fileName }) {
	const name = fileName.toLowerCase();
	if (kind === 'sticker' || kind === 'animation' || /^(sticker|animation)_\d+\./.test(name)) return '表情包';
	if (kind === 'voice' || kind === 'video_note' || /^(voice|videonote)_\d+\./.test(name)) return '影音';

	const ext = name.includes('.') ? name.split('.').pop() : '';
	if (BOOK_EXTS.has(ext)) return '书籍';
	if (APP_EXTS.has(ext)) return '软件';
	return null;
}

/**
 * Used when the model is unavailable or returns something unusable.
 */
function fallbackCategory(mimeType) {
	if (mimeType.startsWith('image/')) return '照片';
	if (mimeType.startsWith('video/') || mimeType.startsWith('audio/')) return '影音';
	return '其他';
}

const CLASSIFY_PROMPT = `你是个人网盘的文件分类器。根据文件名、文件类型、用户附带的说明文字和图片内容，把文件归入下面恰好一个分类：
${CATEGORIES.map((c) => `- ${c.key}：${c.desc}`).join('\n')}

判断要点：
- photo_123.jpg、video_123.mp4、document_123 这类名字是机器生成的，没有含义，此时以图片内容和说明文字为准。
- 图片里有状态栏、聊天气泡、网页或软件界面 → 截图；拍的是证件 → 证件；拍的是票据小票 → 财务。
- PDF/Word 等文档按内容主题判断，不要因为是 PDF 就选书籍。
- 拿不准时选「其他」。

只输出 JSON，例如 {"category":"学习"}。`;

/**
 * Download a Telegram file and return it as a data: URL, or null if it is
 * too large or unavailable.
 */
async function fetchImageDataUrl(env, fileId, mime) {
	const { result } = await tg(env.BOT_TOKEN, 'getFile', { file_id: fileId });
	if (!result?.file_path || (result.file_size ?? 0) > PREVIEW_MAX_BYTES) return null;

	const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${result.file_path}`);
	if (!res.ok) return null;
	const buf = await res.arrayBuffer();
	if (buf.byteLength > PREVIEW_MAX_BYTES) return null;
	return `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
}

/**
 * Pull a valid category key out of the model's reply.
 */
function parseCategory(content) {
	if (content && typeof content === 'object') content = content.category ?? '';
	const text = String(content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '');
	const m = text.match(/"category"\s*:\s*"([^"]+)"/);
	const candidate = (m ? m[1] : text).trim();
	if (CATEGORY_KEYS.includes(candidate)) return candidate;
	// Last resort: the reply names exactly one category somewhere
	const found = CATEGORY_KEYS.filter((k) => text.includes(k));
	return found.length === 1 ? found[0] : null;
}

async function askModel(env, userText, imageUrl) {
	const content = [{ type: 'text', text: userText }];
	if (imageUrl) content.push({ type: 'image_url', image_url: { url: imageUrl, detail: 'low' } });

	const res = await env.AI.run(AI_MODEL, {
		messages: [
			{ role: 'system', content: CLASSIFY_PROMPT },
			{ role: 'user', content },
		],
		response_format: {
			type: 'json_schema',
			json_schema: {
				name: 'file_category',
				strict: true,
				schema: {
					type: 'object',
					properties: { category: { type: 'string', enum: CATEGORY_KEYS } },
					required: ['category'],
					additionalProperties: false,
				},
			},
		},
		chat_template_kwargs: { enable_thinking: false },
		max_completion_tokens: 100,
		temperature: 0,
	});

	return parseCategory(res?.choices?.[0]?.message?.content ?? res?.response);
}

/**
 * Decide a file's category. Never throws: a failure falls back to a
 * MIME-based guess so uploads are never blocked by classification.
 *
 * @param {object} file - { kind, fileName, mimeType, fileSize, caption, source, preview }
 * @returns {Promise<string>} a key from CATEGORY_KEYS
 */
async function classifyFile(env, file) {
	const byRule = ruleCategory(file);
	if (byRule) return byRule;
	if (!env.AI) return fallbackCategory(file.mimeType);

	const lines = [`文件名：${file.fileName}`, `类型：${file.mimeType || '未知'}`, `大小：${formatFileSize(file.fileSize)}`];
	if (file.caption) lines.push(`说明文字：${file.caption}`);
	if (file.source) lines.push(`转发自：${file.source}`);
	const userText = lines.join('\n');

	let imageUrl = null;
	if (file.preview) {
		try {
			imageUrl = await fetchImageDataUrl(env, file.preview.fileId, file.preview.mime);
		} catch (err) {
			console.error('Preview download failed:', err);
		}
	}

	try {
		const category = await askModel(env, userText, imageUrl);
		if (category) return category;
	} catch (err) {
		console.error('AI classification failed:', err);
		// Retry without the image in case the image part was the problem
		if (imageUrl) {
			try {
				const category = await askModel(env, userText, null);
				if (category) return category;
			} catch (err2) {
				console.error('AI classification retry failed:', err2);
			}
		}
	}
	return fallbackCategory(file.mimeType);
}

function categoryLabel(key) {
	const c = CATEGORIES.find((x) => x.key === key);
	return c ? `${c.emoji} ${c.key}` : `❔ ${UNCATEGORIZED}`;
}

/**
 * Inline keyboard for picking a category for file `fileId`, 3 per row.
 */
function categoryKeyboard(fileId) {
	const rows = [];
	for (let i = 0; i < CATEGORIES.length; i += 3) {
		rows.push(
			CATEGORIES.slice(i, i + 3).map((c) => ({
				text: `${c.emoji} ${c.key}`,
				callback_data: `setcat:${fileId}:${c.key}`,
			})),
		);
	}
	rows.push([{ text: '❌ Cancel', callback_data: 'cancel' }]);
	return { inline_keyboard: rows };
}

function changeCategoryButton(fileId) {
	return { inline_keyboard: [[{ text: '✏️ Change category', callback_data: `catmenu:${fileId}` }]] };
}

// =============================================================================
//  Core Command Handlers
// =============================================================================

// ---- /start & /help ----

async function handleHelp(env, chatId) {
	const text = `📦 <b>TeleFileBot</b>

Send any file to save it instantly — it is sorted into a category automatically.
Add a caption when sending to help the classifier.

<b>Commands:</b>
/list — List all files
/list <i>category</i> — Files in a category (e.g. <code>/list 学习</code>)
/list <i>tag</i> — Filter by tag
/cats — Browse categories
/cat <i>filename</i> — Change a file's category
/classify — Sort files saved before auto-classification
/get <i>filename</i> — Retrieve a file (fuzzy match)
/delete <i>filename</i> — Delete a file
/tag <i>filename tag1 tag2</i> — Add tags
/rename <i>old_name new_name</i> — Rename a file
/stats — Storage statistics
/help — Show this help`;

	await sendMessage(env.BOT_TOKEN, chatId, text);
}

// ---- File Upload ----

async function handleFileUpload(env, chatId, message) {
	const info = extractFileInfo(message);
	if (!info) return;

	let { fileId, fileUniqueId, fileSize, mimeType, fileName } = info;
	fileName = sanitizeFileName(fileName);

	// Check for duplicate by unique file ID (exact same file on Telegram servers)
	const duplicate = await dbFirst(env.DB, 'SELECT id, file_name FROM files WHERE file_unique_id = ?', [fileUniqueId]);
	if (duplicate) {
		await sendMessage(env.BOT_TOKEN, chatId, `⚠️ This file already exists as <b>${escapeHtml(duplicate.file_name)}</b>`);
		return;
	}

	// Forward file to the private channel for persistent storage
	let fwd;
	try {
		fwd = await forwardMessage(env.BOT_TOKEN, env.CHANNEL_ID, chatId, message.message_id);
	} catch (err) {
		await sendMessage(
			env.BOT_TOKEN,
			chatId,
			'❌ Failed to forward file to storage channel.\nPlease ensure the bot is an admin of the channel.',
		);
		console.error('Forward failed:', err);
		return;
	}

	const channelMsgId = fwd.result.message_id;

	// Resolve file name conflicts with auto-incrementing suffix
	fileName = await resolveUniqueFileName(env.DB, fileName);

	const origin = message.forward_origin;
	const category = await classifyFile(env, {
		kind: info.kind,
		fileName,
		mimeType,
		fileSize,
		caption: message.caption ?? '',
		source: origin?.chat?.title ?? origin?.sender_chat?.title ?? '',
		preview: info.preview,
	});

	// Persist to database
	const inserted = await dbRun(
		env.DB,
		`INSERT INTO files (file_name, file_id, file_unique_id, file_size, mime_type, message_id, tags, category)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[fileName, fileId, fileUniqueId, fileSize, mimeType, channelMsgId, '', category],
	);

	await sendMessage(
		env.BOT_TOKEN,
		chatId,
		`✅ File saved\n📄 <b>${escapeHtml(fileName)}</b>\n💾 ${formatFileSize(fileSize)}\n🗂 ${categoryLabel(category)}`,
		{ reply_markup: changeCategoryButton(inserted.meta.last_row_id) },
	);
}

/**
 * If a file with the same name already exists, append _1, _2, etc.
 */
async function resolveUniqueFileName(db, fileName) {
	const exists = await dbFirst(db, 'SELECT id FROM files WHERE file_name = ?', [fileName]);
	if (!exists) return fileName;

	const dotIdx = fileName.lastIndexOf('.');
	const base = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
	const ext = dotIdx > 0 ? fileName.slice(dotIdx) : '';

	let counter = 1;
	let candidate;
	do {
		candidate = `${base}_${counter}${ext}`;
		counter++;
		if (counter > 1000) {
			// Safety valve – should never happen
			candidate = `${base}_${Date.now()}${ext}`;
			break;
		}
	} while (await dbFirst(db, 'SELECT id FROM files WHERE file_name = ?', [candidate]));

	return candidate;
}

// ---- /list ----

async function handleList(env, chatId, args) {
	const tag = args.trim();
	await sendFileList(env, chatId, null, tag, 0);
}

/**
 * `tag` is either a category key, UNCATEGORIZED, or a free-form tag.
 * Category names are Chinese and tags are ASCII-only, so they never collide.
 */
async function sendFileList(env, chatId, editMsgId, tag, page) {
	const isCategory = CATEGORY_KEYS.includes(tag) || tag === UNCATEGORIZED;
	let where = '';
	let params = [];
	if (tag === UNCATEGORIZED) {
		where = "WHERE category = '' OR category IS NULL";
	} else if (isCategory) {
		where = 'WHERE category = ?';
		params = [tag];
	} else if (tag) {
		where = 'WHERE tags LIKE ?';
		params = [`%${tag}%`];
	}

	const files = await dbAll(
		env.DB,
		`SELECT id, file_name, file_size, tags, category, uploaded_at FROM files
     ${where} ORDER BY uploaded_at DESC LIMIT ? OFFSET ?`,
		[...params, PAGE_SIZE, page * PAGE_SIZE],
	);
	const countRow = await dbFirst(env.DB, `SELECT COUNT(*) AS cnt FROM files ${where}`, params);
	const total = countRow?.cnt ?? 0;

	if (total === 0) {
		const msg = isCategory
			? `📂 No files in <b>${escapeHtml(tag)}</b>`
			: tag
				? `📂 No files found with tag <b>${escapeHtml(tag)}</b>`
				: '📂 No files stored yet. Send a file to get started!';
		if (editMsgId) {
			await editMessage(env.BOT_TOKEN, chatId, editMsgId, msg);
		} else {
			await sendMessage(env.BOT_TOKEN, chatId, msg);
		}
		return;
	}

	const totalPages = Math.ceil(total / PAGE_SIZE);

	let text = isCategory
		? `🗂 <b>${escapeHtml(categoryLabel(tag === UNCATEGORIZED ? '' : tag))}</b>\n`
		: tag
			? `📂 Tag: <b>${escapeHtml(tag)}</b>\n`
			: '📂 <b>All Files</b>\n';
	text += `${total} file${total !== 1 ? 's' : ''} · Page ${page + 1}/${totalPages}\n\n`;

	files.forEach((f, i) => {
		const idx = page * PAGE_SIZE + i + 1;
		const cat = isCategory ? '' : ` · ${categoryLabel(f.category)}`;
		const tags = f.tags ? ` 🏷 ${f.tags}` : '';
		text += `${idx}. 📄 <b>${escapeHtml(f.file_name)}</b>\n    💾 ${formatFileSize(f.file_size)}${cat}${tags}\n`;
	});

	// Build inline keyboard: file buttons (2 per row) + navigation
	const keyboard = [];

	for (let i = 0; i < files.length; i += 2) {
		const row = [
			{
				text: `📄 ${truncateForCallback(files[i].file_name)}`,
				callback_data: `get:${files[i].id}`,
			},
		];
		if (files[i + 1]) {
			row.push({
				text: `📄 ${truncateForCallback(files[i + 1].file_name)}`,
				callback_data: `get:${files[i + 1].id}`,
			});
		}
		keyboard.push(row);
	}

	// Pagination buttons
	const nav = [];
	const tagParam = tag ? `:${tag}` : '';
	if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: `page:${page - 1}${tagParam}` });
	if (page < totalPages - 1) nav.push({ text: 'Next ➡️', callback_data: `page:${page + 1}${tagParam}` });
	if (nav.length) keyboard.push(nav);

	const markup = { inline_keyboard: keyboard };

	if (editMsgId) {
		await editMessage(env.BOT_TOKEN, chatId, editMsgId, text, {
			reply_markup: markup,
		});
	} else {
		await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: markup });
	}
}

// ---- /get ----

async function handleGet(env, chatId, args) {
	const keyword = args.trim();
	if (!keyword) {
		await sendMessage(env.BOT_TOKEN, chatId, 'Usage: <code>/get filename</code>\nSupports fuzzy matching.');
		return;
	}

	const pattern = `%${keyword}%`;
	const files = await dbAll(
		env.DB,
		`SELECT id, file_name, file_size, message_id FROM files
     WHERE file_name LIKE ? ORDER BY uploaded_at DESC LIMIT ?`,
		[pattern, MAX_FUZZY_RESULTS],
	);

	if (files.length === 0) {
		await sendMessage(env.BOT_TOKEN, chatId, `❌ No files matching <b>${escapeHtml(keyword)}</b>`);
		return;
	}

	if (files.length === 1) {
		try {
			await copyMessage(env.BOT_TOKEN, chatId, env.CHANNEL_ID, files[0].message_id);
		} catch {
			await sendMessage(env.BOT_TOKEN, chatId, '❌ Failed to retrieve file. It may have been deleted from the channel.');
		}
		return;
	}

	// Multiple matches — let user pick
	let text = `🔍 Found ${files.length} matching file${files.length !== 1 ? 's' : ''}:\n\n`;
	const buttons = [];
	for (const f of files) {
		text += `📄 <b>${escapeHtml(f.file_name)}</b> · ${formatFileSize(f.file_size)}\n`;
		buttons.push([
			{
				text: `📄 ${truncateForCallback(f.file_name, 30)}`,
				callback_data: `get:${f.id}`,
			},
		]);
	}

	await sendMessage(env.BOT_TOKEN, chatId, text, {
		reply_markup: { inline_keyboard: buttons },
	});
}

// ---- /delete ----

async function handleDelete(env, chatId, args) {
	const keyword = args.trim();
	if (!keyword) {
		await sendMessage(env.BOT_TOKEN, chatId, 'Usage: <code>/delete filename</code>');
		return;
	}

	// Try exact match first
	const file = await dbFirst(env.DB, 'SELECT id, file_name FROM files WHERE file_name = ?', [keyword]);

	if (file) {
		await sendDeleteConfirmation(env, chatId, file);
		return;
	}

	// Fuzzy match
	const pattern = `%${keyword}%`;
	const matches = await dbAll(env.DB, 'SELECT id, file_name FROM files WHERE file_name LIKE ? LIMIT 5', [pattern]);

	if (matches.length === 0) {
		await sendMessage(env.BOT_TOKEN, chatId, `❌ No files matching <b>${escapeHtml(keyword)}</b>`);
		return;
	}

	if (matches.length === 1) {
		await sendDeleteConfirmation(env, chatId, matches[0]);
		return;
	}

	// Multiple candidates
	let text = '🔍 Which file do you want to delete?\n\n';
	const buttons = [];
	for (const m of matches) {
		text += `📄 ${escapeHtml(m.file_name)}\n`;
		buttons.push([
			{
				text: `🗑 ${truncateForCallback(m.file_name, 30)}`,
				callback_data: `del:${m.id}`,
			},
		]);
	}
	await sendMessage(env.BOT_TOKEN, chatId, text, {
		reply_markup: { inline_keyboard: buttons },
	});
}

async function sendDeleteConfirmation(env, chatId, file) {
	await sendMessage(env.BOT_TOKEN, chatId, `Delete <b>${escapeHtml(file.file_name)}</b>?`, {
		reply_markup: {
			inline_keyboard: [
				[
					{ text: '✅ Confirm', callback_data: `confirm_del:${file.id}` },
					{ text: '❌ Cancel', callback_data: 'cancel' },
				],
			],
		},
	});
}

// ---- /tag ----

async function handleTag(env, chatId, args) {
	const parts = args.trim().split(/\s+/);
	if (parts.length < 2) {
		await sendMessage(env.BOT_TOKEN, chatId, 'Usage: <code>/tag filename tag1 tag2 ...</code>');
		return;
	}

	const fileName = parts[0];
	const newTags = parts.slice(1).map((t) => t.replace(/[^a-zA-Z0-9_\-]/g, ''));

	// Exact match
	const file = await dbFirst(env.DB, 'SELECT id, file_name, tags FROM files WHERE file_name = ?', [fileName]);

	if (file) {
		await applyTags(env, chatId, file, newTags);
		return;
	}

	// Fuzzy match
	const pattern = `%${fileName}%`;
	const matches = await dbAll(env.DB, 'SELECT id, file_name, tags FROM files WHERE file_name LIKE ? LIMIT 5', [pattern]);

	if (matches.length === 0) {
		await sendMessage(env.BOT_TOKEN, chatId, `❌ No files matching <b>${escapeHtml(fileName)}</b>`);
		return;
	}

	if (matches.length === 1) {
		await applyTags(env, chatId, matches[0], newTags);
		return;
	}

	let text = '🔍 Which file do you want to tag?\n\n';
	const buttons = [];
	for (const m of matches) {
		text += `📄 ${escapeHtml(m.file_name)}\n`;
		buttons.push([
			{
				text: `🏷 ${truncateForCallback(m.file_name, 25)}`,
				callback_data: `tag:${m.id}:${newTags.join(',')}`,
			},
		]);
	}
	await sendMessage(env.BOT_TOKEN, chatId, text, {
		reply_markup: { inline_keyboard: buttons },
	});
}

async function applyTags(env, chatId, file, newTags) {
	const existingTags = file.tags ? file.tags.split(',').filter(Boolean) : [];
	const merged = [...new Set([...existingTags, ...newTags])].filter(Boolean);
	const tagStr = merged.join(',');

	await dbRun(env.DB, 'UPDATE files SET tags = ? WHERE id = ?', [tagStr, file.id]);
	await sendMessage(
		env.BOT_TOKEN,
		chatId,
		`🏷 Tags updated\n📄 <b>${escapeHtml(file.file_name)}</b>\nTags: ${merged.map((t) => `#${t}`).join(' ')}`,
	);
}

// ---- /rename ----

async function handleRename(env, chatId, args) {
	const parts = args.trim().split(/\s+/);
	if (parts.length !== 2) {
		await sendMessage(env.BOT_TOKEN, chatId, 'Usage: <code>/rename old_name new_name</code>');
		return;
	}

	const [oldName, rawNewName] = parts;
	const newName = sanitizeFileName(rawNewName);

	const file = await dbFirst(env.DB, 'SELECT id, file_name FROM files WHERE file_name = ?', [oldName]);
	if (!file) {
		await sendMessage(env.BOT_TOKEN, chatId, `❌ File <b>${escapeHtml(oldName)}</b> not found.`);
		return;
	}

	const conflict = await dbFirst(env.DB, 'SELECT id FROM files WHERE file_name = ?', [newName]);
	if (conflict) {
		await sendMessage(env.BOT_TOKEN, chatId, `❌ A file named <b>${escapeHtml(newName)}</b> already exists.`);
		return;
	}

	await dbRun(env.DB, 'UPDATE files SET file_name = ? WHERE id = ?', [newName, file.id]);
	await sendMessage(env.BOT_TOKEN, chatId, `✏️ Renamed\n<b>${escapeHtml(oldName)}</b> → <b>${escapeHtml(newName)}</b>`);
}

// ---- /cats ----

async function handleCategories(env, chatId) {
	const rows = await dbAll(env.DB, `SELECT COALESCE(category, '') AS category, COUNT(*) AS cnt FROM files GROUP BY 1`, []);
	const counts = Object.fromEntries(rows.map((r) => [r.category, r.cnt]));

	let text = '🗂 <b>Categories</b>\n\n';
	const buttons = [];
	for (const c of CATEGORIES) {
		const n = counts[c.key] ?? 0;
		text += `${c.emoji} ${c.key}: ${n}\n`;
		if (n > 0) buttons.push({ text: `${c.emoji} ${c.key} (${n})`, callback_data: `page:0:${c.key}` });
	}
	const unclassified = counts[''] ?? 0;
	if (unclassified > 0) {
		text += `\n❔ ${UNCATEGORIZED}: ${unclassified} — send /classify to sort them`;
		buttons.push({ text: `❔ ${UNCATEGORIZED} (${unclassified})`, callback_data: `page:0:${UNCATEGORIZED}` });
	}

	const keyboard = [];
	for (let i = 0; i < buttons.length; i += 2) keyboard.push(buttons.slice(i, i + 2));
	await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

// ---- /cat ----

async function handleSetCategory(env, chatId, args) {
	const keyword = args.trim();
	if (!keyword) {
		await sendMessage(env.BOT_TOKEN, chatId, 'Usage: <code>/cat filename</code>\nShows category buttons for that file.');
		return;
	}

	const exact = await dbFirst(env.DB, 'SELECT id, file_name, category FROM files WHERE file_name = ?', [keyword]);
	const matches = exact
		? [exact]
		: await dbAll(env.DB, 'SELECT id, file_name, category FROM files WHERE file_name LIKE ? LIMIT 5', [`%${keyword}%`]);

	if (matches.length === 0) {
		await sendMessage(env.BOT_TOKEN, chatId, `❌ No files matching <b>${escapeHtml(keyword)}</b>`);
		return;
	}

	if (matches.length === 1) {
		await sendCategoryMenu(env, chatId, null, matches[0]);
		return;
	}

	let text = '🔍 Which file?\n\n';
	const buttons = [];
	for (const m of matches) {
		text += `📄 ${escapeHtml(m.file_name)} · ${categoryLabel(m.category)}\n`;
		buttons.push([{ text: `🗂 ${truncateForCallback(m.file_name, 30)}`, callback_data: `catmenu:${m.id}` }]);
	}
	await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: buttons } });
}

async function sendCategoryMenu(env, chatId, editMsgId, file) {
	const text = `🗂 Pick a category for <b>${escapeHtml(file.file_name)}</b>\nCurrent: ${categoryLabel(file.category)}`;
	const extra = { reply_markup: categoryKeyboard(file.id) };
	if (editMsgId) {
		await editMessage(env.BOT_TOKEN, chatId, editMsgId, text, extra);
	} else {
		await sendMessage(env.BOT_TOKEN, chatId, text, extra);
	}
}

// ---- /classify ----

/**
 * Classify up to CLASSIFY_BATCH_SIZE files that have no category yet
 * (files saved before auto-classification existed).
 */
async function handleClassify(env, chatId, editMsgId = null) {
	const pending = await dbAll(
		env.DB,
		`SELECT id, file_name, file_id, file_size, mime_type FROM files
     WHERE category = '' OR category IS NULL ORDER BY uploaded_at DESC LIMIT ?`,
		[CLASSIFY_BATCH_SIZE],
	);

	if (pending.length === 0) {
		const msg = '✅ Every file already has a category.';
		if (editMsgId) await editMessage(env.BOT_TOKEN, chatId, editMsgId, msg);
		else await sendMessage(env.BOT_TOKEN, chatId, msg);
		return;
	}

	const results = await Promise.all(
		pending.map(async (f) => {
			const mimeType = f.mime_type ?? '';
			const isSmallImage = mimeType.startsWith('image/') && (f.file_size ?? Infinity) <= PREVIEW_MAX_BYTES;
			const category = await classifyFile(env, {
				kind: null,
				fileName: f.file_name,
				mimeType,
				fileSize: f.file_size,
				caption: '',
				source: '',
				preview: isSmallImage ? { fileId: f.file_id, mime: mimeType } : null,
			});
			await dbRun(env.DB, 'UPDATE files SET category = ? WHERE id = ?', [category, f.id]);
			return { name: f.file_name, category };
		}),
	);

	const left = await dbFirst(env.DB, "SELECT COUNT(*) AS cnt FROM files WHERE category = '' OR category IS NULL", []);
	const remaining = left?.cnt ?? 0;

	let text = `🗂 Classified ${results.length} file${results.length !== 1 ? 's' : ''}:\n\n`;
	for (const r of results) text += `${categoryLabel(r.category)} · ${escapeHtml(r.name)}\n`;
	text += remaining > 0 ? `\n${remaining} left.` : '\n✅ All done.';

	const extra = remaining > 0 ? { reply_markup: { inline_keyboard: [[{ text: '▶️ Continue', callback_data: 'classify_more' }]] } } : {};
	if (editMsgId) await editMessage(env.BOT_TOKEN, chatId, editMsgId, text, extra);
	else await sendMessage(env.BOT_TOKEN, chatId, text, extra);
}

// ---- /stats ----

async function handleStats(env, chatId) {
	const countRow = await dbFirst(env.DB, 'SELECT COUNT(*) AS cnt, COALESCE(SUM(file_size), 0) AS total_size FROM files', []);

	const count = countRow?.cnt ?? 0;
	const totalSize = countRow?.total_size ?? 0;

	const typeRows = await dbAll(
		env.DB,
		`SELECT
       CASE
         WHEN mime_type LIKE 'image/%' THEN 'Images'
         WHEN mime_type LIKE 'video/%' THEN 'Videos'
         WHEN mime_type LIKE 'audio/%' THEN 'Audio'
         ELSE 'Other'
       END AS category,
       COUNT(*) AS cnt
     FROM files GROUP BY category ORDER BY cnt DESC`,
		[],
	);

	let text = `📊 <b>Storage Statistics</b>\n\n`;
	text += `📁 Total files: <b>${count}</b>\n`;
	text += `💾 Total size: <b>${formatFileSize(totalSize)}</b>\n`;

	if (typeRows.length > 0) {
		text += `\n<b>By type:</b>\n`;
		for (const r of typeRows) {
			text += `  • ${r.category}: ${r.cnt}\n`;
		}
	}

	const catRows = await dbAll(
		env.DB,
		`SELECT COALESCE(category, '') AS category, COUNT(*) AS cnt FROM files GROUP BY 1 ORDER BY cnt DESC`,
		[],
	);
	if (catRows.length > 0) {
		text += `\n<b>By category:</b>\n`;
		for (const r of catRows) {
			text += `  • ${categoryLabel(r.category)}: ${r.cnt}\n`;
		}
	}

	await sendMessage(env.BOT_TOKEN, chatId, text);
}

// =============================================================================
//  Callback Query Handler
// =============================================================================

async function handleCallback(env, callback) {
	const chatId = callback.message?.chat?.id;
	const msgId = callback.message?.message_id;
	const data = callback.data;

	if (!chatId || !data) {
		await answerCallback(env.BOT_TOKEN, callback.id);
		return;
	}

	// Auth check
	if (String(chatId) !== String(env.ADMIN_ID)) {
		await answerCallback(env.BOT_TOKEN, callback.id, '⛔ Unauthorized');
		return;
	}

	try {
		// Retrieve file
		if (data.startsWith('get:')) {
			const fileId = parseInt(data.split(':')[1], 10);
			const file = await dbFirst(env.DB, 'SELECT file_name, message_id FROM files WHERE id = ?', [fileId]);
			if (file) {
				await copyMessage(env.BOT_TOKEN, chatId, env.CHANNEL_ID, file.message_id);
				await answerCallback(env.BOT_TOKEN, callback.id, file.file_name);
			} else {
				await answerCallback(env.BOT_TOKEN, callback.id, 'File not found');
			}
			return;
		}

		// Pagination
		if (data.startsWith('page:')) {
			const rest = data.slice(5);
			const colonIdx = rest.indexOf(':');
			let page, tag;
			if (colonIdx > -1) {
				page = parseInt(rest.slice(0, colonIdx), 10);
				tag = rest.slice(colonIdx + 1);
			} else {
				page = parseInt(rest, 10);
				tag = '';
			}
			await sendFileList(env, chatId, msgId, tag, page);
			await answerCallback(env.BOT_TOKEN, callback.id);
			return;
		}

		// Confirm delete
		if (data.startsWith('confirm_del:')) {
			const fileId = parseInt(data.split(':')[1], 10);
			const file = await dbFirst(env.DB, 'SELECT file_name FROM files WHERE id = ?', [fileId]);
			if (file) {
				await dbRun(env.DB, 'DELETE FROM files WHERE id = ?', [fileId]);
				await editMessage(env.BOT_TOKEN, chatId, msgId, `🗑 Deleted <b>${escapeHtml(file.file_name)}</b>`);
				await answerCallback(env.BOT_TOKEN, callback.id, 'Deleted');
			} else {
				await answerCallback(env.BOT_TOKEN, callback.id, 'Already deleted');
			}
			return;
		}

		// Delete selection
		if (data.startsWith('del:')) {
			const fileId = parseInt(data.split(':')[1], 10);
			const file = await dbFirst(env.DB, 'SELECT id, file_name FROM files WHERE id = ?', [fileId]);
			if (file) {
				await editMessage(env.BOT_TOKEN, chatId, msgId, `Delete <b>${escapeHtml(file.file_name)}</b>?`, {
					reply_markup: {
						inline_keyboard: [
							[
								{
									text: '✅ Confirm',
									callback_data: `confirm_del:${file.id}`,
								},
								{ text: '❌ Cancel', callback_data: 'cancel' },
							],
						],
					},
				});
			}
			await answerCallback(env.BOT_TOKEN, callback.id);
			return;
		}

		// Tag callback
		if (data.startsWith('tag:')) {
			const parts = data.split(':');
			const fileId = parseInt(parts[1], 10);
			const newTags = parts[2] ? parts[2].split(',') : [];
			const file = await dbFirst(env.DB, 'SELECT id, file_name, tags FROM files WHERE id = ?', [fileId]);
			if (file) {
				await applyTags(env, chatId, file, newTags);
			}
			await answerCallback(env.BOT_TOKEN, callback.id, 'Tags updated');
			return;
		}

		// Show category picker
		if (data.startsWith('catmenu:')) {
			const fileId = parseInt(data.split(':')[1], 10);
			const file = await dbFirst(env.DB, 'SELECT id, file_name, category FROM files WHERE id = ?', [fileId]);
			if (file) {
				await sendCategoryMenu(env, chatId, msgId, file);
				await answerCallback(env.BOT_TOKEN, callback.id);
			} else {
				await answerCallback(env.BOT_TOKEN, callback.id, 'File not found');
			}
			return;
		}

		// Apply chosen category
		if (data.startsWith('setcat:')) {
			const [, rawId, key] = data.split(':');
			const fileId = parseInt(rawId, 10);
			const file = await dbFirst(env.DB, 'SELECT id, file_name FROM files WHERE id = ?', [fileId]);
			if (!file || !CATEGORY_KEYS.includes(key)) {
				await answerCallback(env.BOT_TOKEN, callback.id, 'File not found');
				return;
			}
			await dbRun(env.DB, 'UPDATE files SET category = ? WHERE id = ?', [key, fileId]);
			await editMessage(env.BOT_TOKEN, chatId, msgId, `🗂 <b>${escapeHtml(file.file_name)}</b> → ${categoryLabel(key)}`, {
				reply_markup: changeCategoryButton(fileId),
			});
			await answerCallback(env.BOT_TOKEN, callback.id, key);
			return;
		}

		// Next batch of /classify
		if (data === 'classify_more') {
			await answerCallback(env.BOT_TOKEN, callback.id, 'Classifying…');
			await handleClassify(env, chatId, msgId);
			return;
		}

		// Cancel
		if (data === 'cancel') {
			await editMessage(env.BOT_TOKEN, chatId, msgId, 'Cancelled.');
			await answerCallback(env.BOT_TOKEN, callback.id);
			return;
		}
	} catch (err) {
		console.error('Callback handler error:', err);
		await answerCallback(env.BOT_TOKEN, callback.id, '⚠️ An error occurred');
	}
}

// =============================================================================
//  Message Router
// =============================================================================

async function handleMessage(env, message) {
	const chatId = message.chat?.id;
	if (!chatId) return;

	// Auth: only the admin can interact
	if (String(chatId) !== String(env.ADMIN_ID)) {
		await sendMessage(env.BOT_TOKEN, chatId, '⛔ Unauthorized');
		return;
	}

	// File message → upload
	if (
		message.document ||
		message.photo ||
		message.video ||
		message.audio ||
		message.voice ||
		message.video_note ||
		message.animation ||
		message.sticker
	) {
		await handleFileUpload(env, chatId, message);
		return;
	}

	// Text command
	const text = (message.text ?? '').trim();
	if (!text) return;

	// Parse command (handles @BotUsername suffix in groups)
	const match = text.match(/^\/(\w+)(@\w+)?(.*)/s);
	if (!match) return;

	const cmd = match[1].toLowerCase();
	const args = (match[3] ?? '').trim();

	switch (cmd) {
		case 'start':
		case 'help':
			await handleHelp(env, chatId);
			break;
		case 'list':
			await handleList(env, chatId, args);
			break;
		case 'get':
			await handleGet(env, chatId, args);
			break;
		case 'delete':
			await handleDelete(env, chatId, args);
			break;
		case 'tag':
			await handleTag(env, chatId, args);
			break;
		case 'rename':
			await handleRename(env, chatId, args);
			break;
		case 'stats':
			await handleStats(env, chatId);
			break;
		case 'cats':
			await handleCategories(env, chatId);
			break;
		case 'cat':
			await handleSetCategory(env, chatId, args);
			break;
		case 'classify':
			await handleClassify(env, chatId);
			break;
		default:
			// Unknown command — silently ignore
			break;
	}
}

// =============================================================================
//  Worker Entrypoint
// =============================================================================

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		// --- Health check ---
		if (url.pathname === '/' || url.pathname === '/health') {
			return Response.json({ status: 'ok', bot: 'TeleFileBot' });
		}

		// --- Register webhook ---
		if (url.pathname === '/registerWebhook') {
			const webhookUrl = `${url.origin}/webhook/${env.BOT_SECRET}`;
			const result = await tg(env.BOT_TOKEN, 'setWebhook', {
				url: webhookUrl,
				allowed_updates: ['message', 'callback_query'],
				drop_pending_updates: true,
			});
			return Response.json(result, { status: 200 });
		}

		// --- Unregister webhook ---
		if (url.pathname === '/unregisterWebhook') {
			const result = await tg(env.BOT_TOKEN, 'deleteWebhook', {
				drop_pending_updates: true,
			});
			return Response.json(result, { status: 200 });
		}

		// --- Webhook endpoint ---
		if (url.pathname === `/webhook/${env.BOT_SECRET}`) {
			if (request.method !== 'POST') {
				return new Response('Method Not Allowed', { status: 405 });
			}

			let update;
			try {
				update = await request.json();
			} catch {
				return new Response('Bad Request', { status: 400 });
			}

			try {
				if (update.message) {
					await handleMessage(env, update.message);
				} else if (update.callback_query) {
					await handleCallback(env, update.callback_query);
				}
			} catch (err) {
				console.error('Error processing update:', err);
				// Still return 200 to prevent Telegram from retrying
			}

			return new Response('ok', { status: 200 });
		}

		// --- 404 ---
		return new Response('Not Found', { status: 404 });
	},
};
