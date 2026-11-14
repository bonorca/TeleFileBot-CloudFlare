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

// Quiet period after the last album item before the album summary is sent.
const ALBUM_SETTLE_MS = 2500;

// /get falls back to AI search over at most this many recent files.
const AI_SEARCH_MAX_FILES = 1500;

// Fixed categories. The key is stored in the database, so rename with care.
const CATEGORIES = [
	{ key: '学习', emoji: '📚', desc: '课程资料、讲义、论文、笔记、作业、考试、学习录音' },
	{ key: '工作', emoji: '💼', desc: '合同、报告、方案、简历、会议纪要、项目文档、工作表格' },
	{ key: '财务', emoji: '💰', desc: '发票、收据、账单、报税、银行流水、工资单、保单' },
	{ key: '证件', emoji: '🪪', desc: '身份证、护照、签证、驾照、学生证、各类证书、成绩单' },
	{ key: '书籍', emoji: '📖', desc: '电子书、小说、漫画、杂志' },
	{ key: '照片', emoji: '📷', desc: '拍摄的照片和普通图片：人物、风景、旅行、美食、插画、壁纸' },
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
	if (kind === 'sticker' || kind === 'animation' || /^(sticker|animation)_\d+(_\d+)?\./.test(name)) return '表情包';
	if (kind === 'voice' || kind === 'video_note' || /^(voice|videonote)_\d+(_\d+)?\./.test(name)) return '影音';

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

const CLASSIFY_PROMPT = `你是个人网盘的文件整理助手。根据文件名、文件类型、用户附带的说明文字和图片内容，完成两件事。

一、category：把文件归入下面恰好一个分类：
${CATEGORIES.map((c) => `- ${c.key}：${c.desc}`).join('\n')}

分类要点：
- photo_123.jpg、video_123.mp4、document_123 这类名字是机器生成的，没有含义，此时以图片内容和说明文字为准。
- 图片里有状态栏、聊天气泡、网页或软件界面 → 截图；拍的是证件 → 证件；拍的是票据小票 → 财务。
- 其余图片一律归照片，不要选其他。IMG_1234、DSC_、PXL_ 开头的文件名或 .heic 格式是相机拍的照片。
- PDF/Word 等文档按内容主题判断，不要因为是 PDF 就选书籍。
- 拿不准时选「其他」。

二、name：起一个简短、以后容易搜到的文件名（不含扩展名，2–30 个字）。
- 写清是什么，再加关键的人物、机构、主题或日期，例如「微信聊天_小王_周五开会安排」「鲜果超市小票_2026-11-14」「护照首页」「海边日落」。
- 优先用中文，专有名词保留原文；不要出现 photo、IMG、编号等无意义的词。
- 原文件名已经有意义时，直接用原文件名去掉扩展名。

只输出 JSON，例如 {"category":"财务","name":"鲜果超市小票_2026-11-14"}。`;

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
 * Pull a valid category key and a suggested name out of the model's reply.
 * @returns {{category: string | null, name: string | null}}
 */
function parseClassification(content) {
	let obj = content && typeof content === 'object' ? content : null;
	const text = obj ? '' : String(content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '');
	if (!obj) {
		try {
			obj = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
		} catch {
			obj = {};
		}
	}

	let category = CATEGORY_KEYS.includes(obj.category) ? obj.category : null;
	if (!category) {
		const m = text.match(/"category"\s*:\s*"([^"]+)"/);
		if (m && CATEGORY_KEYS.includes(m[1])) category = m[1];
	}
	if (!category) {
		// Last resort: the reply names exactly one category somewhere
		const found = CATEGORY_KEYS.filter((k) => text.includes(k));
		if (found.length === 1) category = found[0];
	}

	return { category, name: typeof obj.name === 'string' ? obj.name : null };
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
					properties: {
						category: { type: 'string', enum: CATEGORY_KEYS },
						name: { type: 'string', maxLength: 60 },
					},
					required: ['category', 'name'],
					additionalProperties: false,
				},
			},
		},
		chat_template_kwargs: { enable_thinking: false },
		max_completion_tokens: 150,
		temperature: 0,
	});

	return parseClassification(res?.choices?.[0]?.message?.content ?? res?.response);
}

/**
 * Decide a file's category and suggest a name. Never throws: a failure falls
 * back to a MIME-based category so uploads are never blocked.
 *
 * @param {object} file - { kind, fileName, mimeType, fileSize, caption, source, tags, preview }
 * @returns {Promise<{category: string, name: string | null}>} category is a key
 *   from CATEGORY_KEYS; name is the model's suggestion (no extension), or null
 */
async function classifyFile(env, file) {
	const byRule = ruleCategory(file);
	if (byRule) return { category: byRule, name: null };
	if (!env.AI) return { category: fallbackCategory(file.mimeType), name: null };

	const lines = [`文件名：${file.fileName}`, `类型：${file.mimeType || '未知'}`, `大小：${formatFileSize(file.fileSize)}`];
	if (file.caption) lines.push(`说明文字：${file.caption}`);
	if (file.source) lines.push(`转发自：${file.source}`);
	if (file.tags) lines.push(`用户标签：${file.tags}`);
	const userText = lines.join('\n');

	let imageUrl = null;
	if (file.preview) {
		try {
			imageUrl = await fetchImageDataUrl(env, file.preview.fileId, file.preview.mime);
		} catch (err) {
			console.error('Preview download failed:', err);
		}
	}

	let result = { category: null, name: null };
	try {
		result = await askModel(env, userText, imageUrl);
	} catch (err) {
		console.error('AI classification failed:', err);
		// Retry without the image in case the image part was the problem
		if (imageUrl) {
			try {
				result = await askModel(env, userText, null);
			} catch (err2) {
				console.error('AI classification retry failed:', err2);
			}
		}
	}
	return { category: result.category ?? fallbackCategory(file.mimeType), name: result.name };
}

// ---- Auto-naming ----

// Names that say nothing about the file. Stickers, voice notes and GIFs are
// deliberately absent: they keep their generated names (see ruleCategory).
const GENERIC_NAME_PATTERNS = [
	/^(photo|video|document|audio)_\d+(_\d+)?(\.\w+)?$/i, // generated by this bot
	/^(img|vid|dsc|dscn|dscf|pxl|mvimg|pano|cimg|imag)[_-]?\d[\d_-]*(\.\w+)?$/i, // cameras
	/^(screenshot|screen shot|截屏|屏幕截图)/i,
	/^(微信图片|mmexport|wx_camera)_?\d+(\.\w+)?$/i,
	/^(image|file|scan|untitled|download|未命名|新建文件)[\s_-]*\(?\d*\)?(\.\w+)?$/i,
	/^[\d\s_-]+(\.\w+)?$/,
	/^[0-9a-f-]{16,}(\.\w+)?$/i,
];

function isGenericName(fileName) {
	return GENERIC_NAME_PATTERNS.some((re) => re.test(fileName));
}

const MIME_EXTENSIONS = {
	'application/pdf': '.pdf',
	'image/jpeg': '.jpg',
	'image/png': '.png',
	'image/webp': '.webp',
	'video/mp4': '.mp4',
	'audio/mpeg': '.mp3',
	'audio/ogg': '.ogg',
	'application/zip': '.zip',
};

function fileExtension(fileName, mimeType = '') {
	const m = fileName.match(/\.[a-z0-9]{1,5}$/i);
	return m ? m[0] : (MIME_EXTENSIONS[mimeType] ?? '');
}

/**
 * The name a file should be stored under. Meaningful names are kept as-is;
 * generic ones become the model's suggestion, or "<category>_<date>" when
 * the model gave nothing usable. Never returns a generic name, so files are
 * renamed at most once.
 */
function autoFileName(fileName, mimeType, { category, name }, date) {
	if (!isGenericName(fileName)) return fileName;
	const ext = fileExtension(fileName, mimeType);

	let base = sanitizeFileName(name ?? '')
		.replace(/\.[a-z0-9]{1,5}$/i, '') // the model sometimes adds an extension
		.replace(/\s+/g, ' ')
		.slice(0, 40)
		.trim();
	if (!base || isGenericName(base + ext)) base = `${category}_${date}`;
	return base + ext;
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

/**
 * Buttons under a saved/renamed/recategorized file.
 */
function fileActionsKeyboard(fileId, { withGet = false } = {}) {
	const row = [
		{ text: '✏️ Rename', callback_data: `ren:${fileId}` },
		{ text: '🗂 Category', callback_data: `catmenu:${fileId}` },
	];
	if (withGet) row.unshift({ text: '⬇️ Get', callback_data: `get:${fileId}` });
	return { inline_keyboard: [row] };
}

// =============================================================================
//  Core Command Handlers
// =============================================================================

// ---- /start & /help ----

// Shown in Telegram's "/" command menu. Kept in sync with the /help text.
const BOT_COMMANDS = [
	{ command: 'list', description: 'Browse by category' },
	{ command: 'all', description: 'All files' },
	{ command: 'get', description: 'Send a file (partial name or description)' },
	{ command: 'cat', description: "Change a file's category" },
	{ command: 'rename', description: 'Rename a file' },
	{ command: 'tag', description: 'Add tags to a file' },
	{ command: 'delete', description: 'Delete a file' },
	{ command: 'classify', description: 'Categorize and name older files' },
	{ command: 'stats', description: 'Storage statistics' },
	{ command: 'help', description: 'How to use this bot' },
];

async function handleHelp(env, chatId) {
	const text = `📦 <b>TeleFileBot</b>
Send any file to save it. It is categorized automatically, and files with
meaningless names (photo_123.jpg, IMG_4521.HEIC) are renamed after their
content. A caption helps with both; on an album it applies to every file.

<b>BROWSE</b>
/list [&lt;category&gt;]
      List categories, or the files in &lt;category&gt;. A tag also works.
/all
      List all files, newest first.
/get &lt;name&gt;
      Send a file. Partial names work; AI searches when no name matches.

<b>MANAGE</b>
/cat &lt;name&gt;
      Change a file's category.
/rename &lt;name&gt; [&lt;new&gt;]
      Rename a file. Without &lt;new&gt;, the bot asks for it.
/tag &lt;name&gt; &lt;tag&gt;...
      Add one or more tags.
/delete &lt;name&gt;
      Delete a file, after confirmation.

<b>MAINTENANCE</b>
/classify
      Categorize and name older files, 8 at a time.
/stats
      Show storage statistics.
/help
      Show this help.

<b>NOTATION</b>
&lt;arg&gt; required · [arg] optional · ... repeatable`;

	await sendMessage(env.BOT_TOKEN, chatId, text);

	// Keep Telegram's "/" menu in sync; failure here is harmless
	try {
		await tg(env.BOT_TOKEN, 'setMyCommands', { commands: BOT_COMMANDS });
	} catch (err) {
		console.error('setMyCommands failed:', err);
	}
}

// ---- File Upload ----

async function handleFileUpload(env, chatId, message, ctx) {
	const info = extractFileInfo(message);
	if (!info) return;

	// Album items are reported together in one summary (see scheduleAlbumSummary)
	const groupId = message.media_group_id ?? '';
	let caption = message.caption ?? '';
	if (groupId) caption = await rememberAlbumCaption(env, groupId, caption);

	let { fileId, fileUniqueId, fileSize, mimeType, fileName } = info;
	fileName = sanitizeFileName(fileName);

	// Check for duplicate by unique file ID (exact same file on Telegram servers)
	const duplicate = await dbFirst(env.DB, 'SELECT id, file_name FROM files WHERE file_unique_id = ?', [fileUniqueId]);
	if (duplicate) {
		if (groupId) {
			await dbRun(env.DB, 'UPDATE media_groups SET dup_count = dup_count + 1 WHERE group_id = ?', [groupId]);
			await scheduleAlbumSummary(env, chatId, groupId, ctx);
			return;
		}
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

	const origin = message.forward_origin;
	const result = await classifyFile(env, {
		kind: info.kind,
		fileName,
		mimeType,
		fileSize,
		caption,
		source: origin?.chat?.title ?? origin?.sender_chat?.title ?? '',
		preview: info.preview,
	});
	const { category } = result;

	// Replace meaningless names (photo_123.jpg, IMG_4521.HEIC …), then make unique
	const uploadDate = new Date((message.date ?? Date.now() / 1000) * 1000).toISOString().slice(0, 10);
	const autoNamed = autoFileName(fileName, mimeType, result, uploadDate);
	const renamed = autoNamed !== fileName;
	fileName = await resolveUniqueFileName(env.DB, autoNamed);

	// Persist to database
	const inserted = await dbRun(
		env.DB,
		`INSERT INTO files (file_name, file_id, file_unique_id, file_size, mime_type, message_id, tags, category, media_group_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[fileName, fileId, fileUniqueId, fileSize, mimeType, channelMsgId, '', category, groupId],
	);

	if (groupId) {
		await scheduleAlbumSummary(env, chatId, groupId, ctx);
		return;
	}

	await sendMessage(
		env.BOT_TOKEN,
		chatId,
		`✅ Saved as <b>${escapeHtml(fileName)}</b>${renamed ? ' <i>(auto-named)</i>' : ''}\n` +
			`🗂 ${categoryLabel(category)} · 💾 ${formatFileSize(fileSize)}`,
		{ reply_markup: fileActionsKeyboard(inserted.meta.last_row_id) },
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

// ---- Albums (media groups) ----
//
// Telegram delivers each item of an album as a separate update, often in
// parallel, with no "last item" marker. Every item bumps media_groups.seq
// when it is done; after ALBUM_SETTLE_MS, only the item whose seq is still
// the latest reports. A late straggler reports again, editing the summary.

/**
 * Record an album's caption (only the first item usually carries one) and
 * return the caption known for the album so far.
 */
async function rememberAlbumCaption(env, groupId, caption) {
	const row = await dbFirst(
		env.DB,
		`INSERT INTO media_groups (group_id, caption) VALUES (?, ?)
     ON CONFLICT(group_id) DO UPDATE SET caption = CASE WHEN excluded.caption != '' THEN excluded.caption ELSE media_groups.caption END
     RETURNING caption`,
		[groupId, caption],
	);
	return row?.caption ?? caption;
}

/**
 * Mark one album item as processed and arrange for the summary to be sent
 * once the album has gone quiet. Runs after the webhook response when
 * `ctx.waitUntil` is available, so Telegram can deliver the next item.
 */
async function scheduleAlbumSummary(env, chatId, groupId, ctx) {
	const row = await dbFirst(env.DB, 'UPDATE media_groups SET seq = seq + 1 WHERE group_id = ? RETURNING seq', [groupId]);
	const settleMs = Number(env.ALBUM_SETTLE_MS) || ALBUM_SETTLE_MS;

	const task = (async () => {
		await new Promise((resolve) => setTimeout(resolve, settleMs));
		const now = await dbFirst(env.DB, 'SELECT seq FROM media_groups WHERE group_id = ?', [groupId]);
		if (now?.seq !== row?.seq) return; // a later item will report
		await sendAlbumSummary(env, chatId, groupId);
	})().catch((err) => console.error('Album summary failed:', err));

	if (ctx?.waitUntil) ctx.waitUntil(task);
	else await task;
}

async function sendAlbumSummary(env, chatId, groupId) {
	const files = await dbAll(env.DB, 'SELECT id, file_name, file_size, category FROM files WHERE media_group_id = ? ORDER BY id', [groupId]);
	const group = await dbFirst(env.DB, 'SELECT caption, dup_count FROM media_groups WHERE group_id = ?', [groupId]);
	const dups = group?.dup_count ?? 0;

	let text;
	if (files.length === 0) {
		text = `⚠️ All ${dups} file${dups !== 1 ? 's' : ''} in this album were already saved.`;
	} else {
		const counts = {};
		for (const f of files) counts[f.category] = (counts[f.category] ?? 0) + 1;
		const breakdown = Object.entries(counts)
			.sort((a, b) => b[1] - a[1])
			.map(([cat, n]) => `${categoryLabel(cat)} ×${n}`)
			.join(' · ');

		text = `📦 Saved ${files.length} file${files.length !== 1 ? 's' : ''} from an album\n🗂 ${breakdown}`;
		if (group?.caption) text += `\n💬 <i>${escapeHtml(group.caption)}</i>`;
		if (dups) text += `\n⚠️ ${dups} already saved, skipped`;
		text += '\n\n';
		files.forEach((f, i) => {
			text += `<b>${i + 1}.</b> ${escapeHtml(f.file_name)} · ${categoryLabel(f.category)}\n`;
		});
		text += '\n<i>Tap a number to rename, recategorize or get a file.</i>';
	}

	const buttons = files.map((f, i) => ({ text: String(i + 1), callback_data: `file:${f.id}` }));
	const keyboard = [];
	for (let i = 0; i < buttons.length; i += 5) keyboard.push(buttons.slice(i, i + 5));
	const extra = { reply_markup: { inline_keyboard: keyboard } };

	// Claim the right to send; whoever loses edits the message instead
	const claim = await dbRun(env.DB, 'UPDATE media_groups SET summary_msg_id = -1 WHERE group_id = ? AND summary_msg_id IS NULL', [
		groupId,
	]);
	if (claim.meta?.changes === 1) {
		const sent = await sendMessage(env.BOT_TOKEN, chatId, text, extra);
		await dbRun(env.DB, 'UPDATE media_groups SET summary_msg_id = ? WHERE group_id = ?', [sent.result.message_id, groupId]);
		return;
	}

	// Someone else sent (or is sending) the summary: wait for its id, then edit
	for (let attempt = 0; attempt < 20; attempt++) {
		const row = await dbFirst(env.DB, 'SELECT summary_msg_id FROM media_groups WHERE group_id = ?', [groupId]);
		if (row?.summary_msg_id > 0) {
			try {
				await editMessage(env.BOT_TOKEN, chatId, row.summary_msg_id, text, extra);
			} catch (err) {
				if (!String(err).includes('message is not modified')) throw err;
			}
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

/**
 * Detail card for one file, opened from an album summary.
 */
async function sendFileCard(env, chatId, fileId) {
	const f = await dbFirst(env.DB, 'SELECT id, file_name, file_size, mime_type, category, tags FROM files WHERE id = ?', [fileId]);
	if (!f) return false;
	const meta = [categoryLabel(f.category), formatFileSize(f.file_size)];
	if (f.tags) meta.push(`🏷 ${f.tags}`);
	await sendMessage(env.BOT_TOKEN, chatId, `${fileIcon(f.mime_type)} <b>${escapeHtml(f.file_name)}</b>\n<i>${escapeHtml(meta.join(' · '))}</i>`, {
		reply_markup: fileActionsKeyboard(f.id, { withGet: true }),
	});
	return true;
}

// ---- /list & /all ----

/**
 * /list           → category overview
 * /list <filter>  → files in a category, or with a tag
 */
async function handleList(env, chatId, args) {
	const filter = args.trim();
	if (filter) {
		await sendFileList(env, chatId, null, filter, 0);
	} else {
		await sendCategoryOverview(env, chatId, null);
	}
}

async function sendCategoryOverview(env, chatId, editMsgId) {
	const rows = await dbAll(env.DB, `SELECT COALESCE(category, '') AS category, COUNT(*) AS cnt FROM files GROUP BY 1`, []);
	const counts = Object.fromEntries(rows.map((r) => [r.category, r.cnt]));
	const total = rows.reduce((sum, r) => sum + r.cnt, 0);

	if (total === 0) {
		const msg = '📂 No files stored yet. Send a file to get started!';
		if (editMsgId) await editMessage(env.BOT_TOKEN, chatId, editMsgId, msg);
		else await sendMessage(env.BOT_TOKEN, chatId, msg);
		return;
	}

	const buttons = CATEGORIES.filter((c) => counts[c.key]).map((c) => ({
		text: `${c.emoji} ${c.key} · ${counts[c.key]}`,
		callback_data: `page:0:${c.key}`,
	}));
	if (counts['']) {
		buttons.push({ text: `❔ ${UNCATEGORIZED} · ${counts['']}`, callback_data: `page:0:${UNCATEGORIZED}` });
	}

	const keyboard = [];
	for (let i = 0; i < buttons.length; i += 2) keyboard.push(buttons.slice(i, i + 2));
	keyboard.push([{ text: `📂 All files · ${total}`, callback_data: 'page:0' }]);

	let text = `🗂 <b>Categories</b>\n${total} file${total !== 1 ? 's' : ''} in ${buttons.length} categor${buttons.length !== 1 ? 'ies' : 'y'}`;
	if (counts['']) text += `\n\n❔ ${counts['']} uncategorized — send /classify to sort them`;

	const extra = { reply_markup: { inline_keyboard: keyboard } };
	if (editMsgId) await editMessage(env.BOT_TOKEN, chatId, editMsgId, text, extra);
	else await sendMessage(env.BOT_TOKEN, chatId, text, extra);
}

/**
 * Images that can go into a preview album. Stickers can't be sent as photos.
 */
function isPreviewable(f) {
	return (f.mime_type ?? '').startsWith('image/') && !/^sticker_\d+(_\d+)?\.webp$/.test(f.file_name);
}

function fileIcon(mimeType = '') {
	if (mimeType.startsWith('image/')) return '🖼';
	if (mimeType.startsWith('video/')) return '🎬';
	if (mimeType.startsWith('audio/')) return '🎵';
	return '📄';
}

/**
 * One page of files for a filter.
 * `filter` is a category key, UNCATEGORIZED, a free-form tag, or '' for all files.
 * Category names are Chinese and tags are ASCII-only, so they never collide.
 */
async function queryFilePage(env, filter, page) {
	const isCategory = CATEGORY_KEYS.includes(filter) || filter === UNCATEGORIZED;
	let where = '';
	let params = [];
	if (filter === UNCATEGORIZED) {
		where = "WHERE category = '' OR category IS NULL";
	} else if (isCategory) {
		where = 'WHERE category = ?';
		params = [filter];
	} else if (filter) {
		where = 'WHERE tags LIKE ?';
		params = [`%${filter}%`];
	}

	const files = await dbAll(
		env.DB,
		`SELECT id, file_name, file_id, file_size, mime_type, tags, category, uploaded_at FROM files
     ${where} ORDER BY uploaded_at DESC, id DESC LIMIT ? OFFSET ?`,
		[...params, PAGE_SIZE, page * PAGE_SIZE],
	);
	const countRow = await dbFirst(env.DB, `SELECT COUNT(*) AS cnt FROM files ${where}`, params);
	return { files, total: countRow?.cnt ?? 0, isCategory };
}

async function sendFileList(env, chatId, editMsgId, filter, page) {
	const { files, total, isCategory } = await queryFilePage(env, filter, page);
	const back = [{ text: '🗂 Categories', callback_data: 'cats' }];

	if (total === 0) {
		const msg = isCategory
			? `📂 No files in <b>${escapeHtml(filter)}</b>`
			: filter
				? `📂 No files found with tag <b>${escapeHtml(filter)}</b>`
				: '📂 No files stored yet. Send a file to get started!';
		const extra = { reply_markup: { inline_keyboard: [back] } };
		if (editMsgId) await editMessage(env.BOT_TOKEN, chatId, editMsgId, msg, extra);
		else await sendMessage(env.BOT_TOKEN, chatId, msg, extra);
		return;
	}

	const totalPages = Math.ceil(total / PAGE_SIZE);

	let text = isCategory
		? `<b>${escapeHtml(categoryLabel(filter === UNCATEGORIZED ? '' : filter))}</b>`
		: filter
			? `🏷 <b>${escapeHtml(filter)}</b>`
			: '📂 <b>All files</b>';
	text += `\n${total} file${total !== 1 ? 's' : ''} · page ${page + 1}/${totalPages}\n\n`;

	files.forEach((f, i) => {
		const idx = page * PAGE_SIZE + i + 1;
		const meta = [formatFileSize(f.file_size)];
		if (!isCategory) meta.push(categoryLabel(f.category));
		if (f.tags) meta.push(`🏷 ${f.tags}`);
		text += `<b>${idx}.</b> ${fileIcon(f.mime_type)} ${escapeHtml(f.file_name)}\n      <i>${escapeHtml(meta.join(' · '))}</i>\n`;
	});

	// Inline keyboard: numbered file buttons (5 per row), then navigation
	const keyboard = [];
	const fileButtons = files.map((f, i) => ({ text: String(page * PAGE_SIZE + i + 1), callback_data: `get:${f.id}` }));
	for (let i = 0; i < fileButtons.length; i += 5) keyboard.push(fileButtons.slice(i, i + 5));

	const param = filter ? `:${filter}` : '';
	const nav = [];
	if (page > 0) nav.push({ text: '⬅️', callback_data: `page:${page - 1}${param}` });
	if (files.some(isPreviewable)) {
		nav.push({ text: '🖼 Preview', callback_data: `prev:${page}${param}` });
	}
	if (page < totalPages - 1) nav.push({ text: '➡️', callback_data: `page:${page + 1}${param}` });
	if (nav.length) keyboard.push(nav);
	keyboard.push(back);

	const extra = { reply_markup: { inline_keyboard: keyboard } };
	if (editMsgId) await editMessage(env.BOT_TOKEN, chatId, editMsgId, text, extra);
	else await sendMessage(env.BOT_TOKEN, chatId, text, extra);
}

/**
 * Send the images on one list page as a Telegram album, captioned with
 * their list numbers so they can be matched to the list.
 */
async function sendPagePreview(env, chatId, filter, page) {
	const { files } = await queryFilePage(env, filter, page);
	const images = files
		.map((f, i) => ({ ...f, idx: page * PAGE_SIZE + i + 1 }))
		.filter(isPreviewable)
		.slice(0, 10); // Telegram album limit
	if (images.length === 0) return 0;

	const build = (type) =>
		images.map((f) => ({ type, media: f.file_id, caption: `${f.idx}. ${f.file_name}`.slice(0, 1024) }));

	if (images.length === 1) {
		try {
			await tg(env.BOT_TOKEN, 'sendPhoto', { chat_id: chatId, photo: images[0].file_id, caption: build('photo')[0].caption });
		} catch {
			await tg(env.BOT_TOKEN, 'sendDocument', { chat_id: chatId, document: images[0].file_id, caption: build('document')[0].caption });
		}
		return 1;
	}

	try {
		await tg(env.BOT_TOKEN, 'sendMediaGroup', { chat_id: chatId, media: build('photo') });
	} catch {
		// Images saved as files (not compressed photos) have document file IDs
		try {
			await tg(env.BOT_TOKEN, 'sendMediaGroup', { chat_id: chatId, media: build('document') });
		} catch (err) {
			// Mixed photo/document pages can't form one album; send them one by one
			console.error('Album preview failed, sending individually:', err);
			for (const f of images) {
				const caption = `${f.idx}. ${f.file_name}`.slice(0, 1024);
				try {
					await tg(env.BOT_TOKEN, 'sendPhoto', { chat_id: chatId, photo: f.file_id, caption });
				} catch {
					await tg(env.BOT_TOKEN, 'sendDocument', { chat_id: chatId, document: f.file_id, caption }).catch(() => {});
				}
			}
		}
	}
	return images.length;
}

// ---- /get ----

/**
 * Find files by name, from strictest to loosest:
 *   1. exact name (case-insensitive)
 *   2. name contains the keyword
 *   3. name contains every word of the keyword, in any order
 *   4. AI search over names, categories and tags (only when 1–3 find nothing)
 * @returns {Promise<{files: object[], via: 'name' | 'ai'}>}
 */
async function findFiles(env, keyword) {
	const cols = 'id, file_name, file_size, message_id';

	const exact = await dbAll(env.DB, `SELECT ${cols} FROM files WHERE file_name = ? COLLATE NOCASE LIMIT 1`, [keyword]);
	if (exact.length) return { files: exact, via: 'name' };

	const contains = await dbAll(env.DB, `SELECT ${cols} FROM files WHERE file_name LIKE ? ORDER BY uploaded_at DESC LIMIT ?`, [
		`%${keyword}%`,
		MAX_FUZZY_RESULTS,
	]);
	if (contains.length) return { files: contains, via: 'name' };

	const words = keyword.split(/[\s_\-.]+/).filter(Boolean);
	if (words.length > 1) {
		const where = words.map(() => 'file_name LIKE ?').join(' AND ');
		const allWords = await dbAll(env.DB, `SELECT ${cols} FROM files WHERE ${where} ORDER BY uploaded_at DESC LIMIT ?`, [
			...words.map((w) => `%${w}%`),
			MAX_FUZZY_RESULTS,
		]);
		if (allWords.length) return { files: allWords, via: 'name' };
	}

	const ids = await aiSearchFileIds(env, keyword);
	if (ids.length === 0) return { files: [], via: 'ai' };
	const rows = await dbAll(env.DB, `SELECT ${cols} FROM files WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
	const byId = new Map(rows.map((r) => [r.id, r]));
	return { files: ids.map((id) => byId.get(id)).filter(Boolean), via: 'ai' };
}

const SEARCH_PROMPT = `你在帮用户从个人网盘里找文件。用户的描述可能是中文或英文、缩写、拼音、同义词，也可能只描述了内容（比如"我的简历""加拿大签证材料"）。
根据文件名、分类和标签，从列表里选出最可能是用户要找的文件，最多 5 个，最可能的排在前面。
没有相关的就返回空数组，不要硬凑。只输出 JSON，例如 {"ids":[12,3]}。`;

/**
 * Ask the model which stored files match a free-text description.
 * Never throws; returns [] when the model is unavailable or unsure.
 */
async function aiSearchFileIds(env, query) {
	if (!env.AI) return [];
	const rows = await dbAll(env.DB, 'SELECT id, file_name, category, tags FROM files ORDER BY uploaded_at DESC LIMIT ?', [
		AI_SEARCH_MAX_FILES,
	]);
	if (rows.length === 0) return [];

	const list = rows.map((r) => [r.id, r.file_name, r.category || UNCATEGORIZED, r.tags].filter(Boolean).join(' | ')).join('\n');

	try {
		const res = await env.AI.run(AI_MODEL, {
			messages: [
				{ role: 'system', content: SEARCH_PROMPT },
				{ role: 'user', content: `要找：${query}\n\n文件列表（id | 文件名 | 分类 | 标签）：\n${list}` },
			],
			response_format: {
				type: 'json_schema',
				json_schema: {
					name: 'file_search',
					strict: true,
					schema: {
						type: 'object',
						properties: { ids: { type: 'array', items: { type: 'integer' }, maxItems: 5 } },
						required: ['ids'],
						additionalProperties: false,
					},
				},
			},
			chat_template_kwargs: { enable_thinking: false },
			max_completion_tokens: 100,
			temperature: 0,
		});

		const known = new Set(rows.map((r) => r.id));
		return [...new Set(parseIds(res?.choices?.[0]?.message?.content ?? res?.response))].filter((id) => known.has(id)).slice(0, 5);
	} catch (err) {
		console.error('AI search failed:', err);
		return [];
	}
}

function parseIds(content) {
	if (content && typeof content === 'object') return (content.ids ?? []).map(Number).filter(Number.isInteger);
	const text = String(content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '');
	const m = text.match(/"ids"\s*:\s*\[([^\]]*)\]/);
	if (!m) return [];
	return m[1]
		.split(',')
		.map((s) => parseInt(s, 10))
		.filter(Number.isInteger);
}

async function handleGet(env, chatId, args) {
	const keyword = args.trim();
	if (!keyword) {
		await sendMessage(env.BOT_TOKEN, chatId, 'Usage: <code>/get &lt;name&gt;</code>\nPartial names work. If nothing matches, AI searches by meaning.');
		return;
	}

	const { files, via } = await findFiles(env, keyword);

	if (files.length === 0) {
		await sendMessage(env.BOT_TOKEN, chatId, `❌ No files matching <b>${escapeHtml(keyword)}</b>, and AI search found nothing either.`);
		return;
	}

	// A single name match is sent straight away; AI results are always confirmed first
	if (files.length === 1 && via === 'name') {
		try {
			await copyMessage(env.BOT_TOKEN, chatId, env.CHANNEL_ID, files[0].message_id);
		} catch {
			await sendMessage(env.BOT_TOKEN, chatId, '❌ Failed to retrieve file. It may have been deleted from the channel.');
		}
		return;
	}

	let text =
		via === 'ai'
			? `🤖 No file name contains <b>${escapeHtml(keyword)}</b>. AI suggests:\n\n`
			: `🔍 Found ${files.length} matching files:\n\n`;
	const buttons = [];
	files.forEach((f, i) => {
		text += `<b>${i + 1}.</b> ${escapeHtml(f.file_name)} · ${formatFileSize(f.file_size)}\n`;
		buttons.push({ text: String(i + 1), callback_data: `get:${f.id}` });
	});

	const keyboard = [];
	for (let i = 0; i < buttons.length; i += 5) keyboard.push(buttons.slice(i, i + 5));
	await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

// ---- /delete ----

async function handleDelete(env, chatId, args) {
	const keyword = args.trim();
	if (!keyword) {
		await sendMessage(env.BOT_TOKEN, chatId, 'Usage: <code>/delete &lt;name&gt;</code>');
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
		await sendMessage(env.BOT_TOKEN, chatId, 'Usage: <code>/tag &lt;name&gt; &lt;tag&gt;...</code>');
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

// Start of the force-reply prompt; a reply to a bot message starting with
// this is treated as the new name (the file id is on the prompt's last line).
const RENAME_PROMPT = '✏️ Reply with a new name for';

/**
 * /rename <name> <new>  → rename directly (both names without spaces)
 * /rename <name>        → find the file and ask for the new name
 */
async function handleRename(env, chatId, args) {
	const query = args.trim();
	if (!query) {
		await sendMessage(env.BOT_TOKEN, chatId, 'Usage: <code>/rename &lt;name&gt; [&lt;new&gt;]</code>\nWithout &lt;new&gt;, the bot asks for it.');
		return;
	}

	const parts = query.split(/\s+/);
	if (parts.length === 2) {
		const file = await dbFirst(env.DB, 'SELECT id FROM files WHERE file_name = ?', [parts[0]]);
		if (file) {
			await applyRename(env, chatId, file.id, parts[1]);
			return;
		}
	}

	// Otherwise the whole argument names the file (spaces allowed)
	const exact = await dbFirst(env.DB, 'SELECT id, file_name FROM files WHERE file_name = ? COLLATE NOCASE', [query]);
	const matches = exact ? [exact] : await dbAll(env.DB, 'SELECT id, file_name FROM files WHERE file_name LIKE ? LIMIT 5', [`%${query}%`]);

	if (matches.length === 0) {
		await sendMessage(env.BOT_TOKEN, chatId, `❌ No files matching <b>${escapeHtml(query)}</b>`);
		return;
	}
	if (matches.length === 1) {
		await sendRenamePrompt(env, chatId, matches[0]);
		return;
	}

	let text = '🔍 Which file?\n\n';
	const buttons = matches.map((m, i) => {
		text += `<b>${i + 1}.</b> ${escapeHtml(m.file_name)}\n`;
		return { text: String(i + 1), callback_data: `ren:${m.id}` };
	});
	await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: [buttons] } });
}

async function sendRenamePrompt(env, chatId, file) {
	await sendMessage(
		env.BOT_TOKEN,
		chatId,
		`${RENAME_PROMPT} <b>${escapeHtml(file.file_name)}</b>\n<i>Leave out the extension to keep it.</i>\n#${file.id}`,
		{ reply_markup: { force_reply: true, input_field_placeholder: file.file_name.slice(0, 64) } },
	);
}

/**
 * Rename file `fileId`. The old extension is kept when `rawName` has none.
 */
async function applyRename(env, chatId, fileId, rawName) {
	const file = await dbFirst(env.DB, 'SELECT id, file_name, mime_type FROM files WHERE id = ?', [fileId]);
	if (!file) {
		await sendMessage(env.BOT_TOKEN, chatId, '❌ That file no longer exists.');
		return;
	}

	let newName = sanitizeFileName(rawName);
	if (!newName) {
		await sendMessage(env.BOT_TOKEN, chatId, '❌ The new name is empty.');
		return;
	}
	if (!/\.[a-z0-9]{1,5}$/i.test(newName)) newName += fileExtension(file.file_name, file.mime_type ?? '');
	if (newName === file.file_name) {
		await sendMessage(env.BOT_TOKEN, chatId, `Name unchanged: <b>${escapeHtml(newName)}</b>`);
		return;
	}

	const conflict = await dbFirst(env.DB, 'SELECT id FROM files WHERE file_name = ? AND id != ?', [newName, file.id]);
	if (conflict) {
		await sendMessage(env.BOT_TOKEN, chatId, `❌ A file named <b>${escapeHtml(newName)}</b> already exists.`);
		return;
	}

	await dbRun(env.DB, 'UPDATE files SET file_name = ? WHERE id = ?', [newName, file.id]);
	await sendMessage(env.BOT_TOKEN, chatId, `✏️ Renamed\n<b>${escapeHtml(file.file_name)}</b> → <b>${escapeHtml(newName)}</b>`, {
		reply_markup: fileActionsKeyboard(file.id),
	});
}

// ---- /cat ----

async function handleSetCategory(env, chatId, args) {
	const keyword = args.trim();
	if (!keyword) {
		await sendMessage(env.BOT_TOKEN, chatId, 'Usage: <code>/cat &lt;name&gt;</code>\nShows category buttons for that file.');
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
 * Tidy up older files in batches of CLASSIFY_BATCH_SIZE: give a category to
 * files without one, and a real name to files with a generic one.
 */
async function handleClassify(env, chatId, editMsgId = null) {
	const { results, remaining } = await classifyPendingBatch(env);

	if (results.length === 0) {
		const msg = '✅ Every file has a category and a real name.';
		if (editMsgId) await editMessage(env.BOT_TOKEN, chatId, editMsgId, msg);
		else await sendMessage(env.BOT_TOKEN, chatId, msg);
		return;
	}

	let text = `🗂 Processed ${results.length} file${results.length !== 1 ? 's' : ''}:\n\n`;
	for (const r of results) {
		text += `${categoryLabel(r.category)} · ${escapeHtml(r.name)}`;
		if (r.oldName !== r.name) text += `\n      <i>was ${escapeHtml(r.oldName)}</i>`;
		text += '\n';
	}
	text += remaining > 0 ? `\n${remaining} left.` : '\n✅ All done.';

	const extra = remaining > 0 ? { reply_markup: { inline_keyboard: [[{ text: '▶️ Continue', callback_data: 'classify_more' }]] } } : {};
	if (editMsgId) await editMessage(env.BOT_TOKEN, chatId, editMsgId, text, extra);
	else await sendMessage(env.BOT_TOKEN, chatId, text, extra);
}

/**
 * Process one batch of files that are uncategorized or generically named.
 * An existing category is kept; only missing ones are filled in.
 * @returns {Promise<{results: {id: number, oldName: string, name: string, category: string}[], remaining: number}>}
 */
async function classifyPendingBatch(env) {
	// Generic names are matched in JS, so scan names (cheap: names only)
	const all = await dbAll(
		env.DB,
		'SELECT id, file_name, file_id, file_size, mime_type, tags, category, uploaded_at FROM files ORDER BY uploaded_at DESC, id DESC',
		[],
	);
	const needsWork = all.filter((f) => !f.category || isGenericName(f.file_name));
	const batch = needsWork.slice(0, CLASSIFY_BATCH_SIZE);
	if (batch.length === 0) return { results: [], remaining: 0 };

	// Model calls in parallel …
	const suggestions = await Promise.all(
		batch.map((f) => {
			const mimeType = f.mime_type ?? '';
			const isSmallImage = mimeType.startsWith('image/') && (f.file_size ?? Infinity) <= PREVIEW_MAX_BYTES;
			return classifyFile(env, {
				kind: null,
				fileName: f.file_name,
				mimeType,
				fileSize: f.file_size,
				caption: '',
				source: '',
				tags: f.tags ?? '',
				preview: isSmallImage ? { fileId: f.file_id, mime: mimeType } : null,
			});
		}),
	);

	// … writes one at a time, so two files can't claim the same new name
	const results = [];
	for (let i = 0; i < batch.length; i++) {
		const f = batch[i];
		const category = f.category || suggestions[i].category;
		const date = (f.uploaded_at ?? '').slice(0, 10) || new Date().toISOString().slice(0, 10);
		const wanted = autoFileName(f.file_name, f.mime_type ?? '', { category, name: suggestions[i].name }, date);
		const name = wanted === f.file_name ? wanted : await resolveUniqueFileName(env.DB, wanted);
		await dbRun(env.DB, 'UPDATE files SET category = ?, file_name = ? WHERE id = ?', [category, name, f.id]);
		results.push({ id: f.id, oldName: f.file_name, name, category });
	}

	return { results, remaining: needsWork.length - batch.length };
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

		// File detail card (from an album summary)
		if (data.startsWith('file:')) {
			const found = await sendFileCard(env, chatId, parseInt(data.split(':')[1], 10));
			await answerCallback(env.BOT_TOKEN, callback.id, found ? '' : 'File not found');
			return;
		}

		// Ask for a new name
		if (data.startsWith('ren:')) {
			const fileId = parseInt(data.split(':')[1], 10);
			const file = await dbFirst(env.DB, 'SELECT id, file_name FROM files WHERE id = ?', [fileId]);
			if (file) {
				await sendRenamePrompt(env, chatId, file);
				await answerCallback(env.BOT_TOKEN, callback.id);
			} else {
				await answerCallback(env.BOT_TOKEN, callback.id, 'File not found');
			}
			return;
		}

		// Back to category overview
		if (data === 'cats') {
			await sendCategoryOverview(env, chatId, msgId);
			await answerCallback(env.BOT_TOKEN, callback.id);
			return;
		}

		// Image preview album for a list page
		if (data.startsWith('prev:')) {
			const rest = data.slice(5);
			const colonIdx = rest.indexOf(':');
			const page = parseInt(colonIdx > -1 ? rest.slice(0, colonIdx) : rest, 10);
			const filter = colonIdx > -1 ? rest.slice(colonIdx + 1) : '';
			await answerCallback(env.BOT_TOKEN, callback.id, 'Sending previews…');
			await sendPagePreview(env, chatId, filter, page);
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
				reply_markup: fileActionsKeyboard(fileId),
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

async function handleMessage(env, message, ctx) {
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
		await handleFileUpload(env, chatId, message, ctx);
		return;
	}

	// Text command
	const text = (message.text ?? '').trim();
	if (!text) return;

	// Reply to a rename prompt → the text is the new name
	const prompt = message.reply_to_message;
	if (prompt?.from?.is_bot && (prompt.text ?? '').startsWith(RENAME_PROMPT) && !text.startsWith('/')) {
		const idMatch = prompt.text.match(/#(\d+)\s*$/);
		if (idMatch) {
			await applyRename(env, chatId, parseInt(idMatch[1], 10), text);
			return;
		}
	}

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
		case 'all':
			await sendFileList(env, chatId, null, '', 0);
			break;
		case 'cats': // old name, kept as an alias
			await sendCategoryOverview(env, chatId, null);
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
	async fetch(request, env, ctx) {
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
			await tg(env.BOT_TOKEN, 'setMyCommands', { commands: BOT_COMMANDS });
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
					await handleMessage(env, update.message, ctx);
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
