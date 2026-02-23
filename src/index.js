// =============================================================================
// TeleFileBot — Cloudflare Workers + D1
// https://github.com/yourname/telegram-file-vault
// =============================================================================

const PAGE_SIZE = 10;
const MAX_FUZZY_RESULTS = 10;
const MAX_FILENAME_LEN = 200;
const CALLBACK_DATA_LIMIT = 64; // Telegram's limit

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
		return {
			fileId: message.document.file_id,
			fileUniqueId: message.document.file_unique_id,
			fileSize: message.document.file_size ?? 0,
			mimeType: message.document.mime_type ?? '',
			fileName: message.document.file_name ?? `document_${ts}`,
		};
	}

	if (message.photo) {
		const photo = message.photo[message.photo.length - 1]; // largest size
		return {
			fileId: photo.file_id,
			fileUniqueId: photo.file_unique_id,
			fileSize: photo.file_size ?? 0,
			mimeType: 'image/jpeg',
			fileName: `photo_${ts}.jpg`,
		};
	}

	if (message.video) {
		return {
			fileId: message.video.file_id,
			fileUniqueId: message.video.file_unique_id,
			fileSize: message.video.file_size ?? 0,
			mimeType: message.video.mime_type ?? 'video/mp4',
			fileName: message.video.file_name ?? `video_${ts}.mp4`,
		};
	}

	if (message.animation) {
		return {
			fileId: message.animation.file_id,
			fileUniqueId: message.animation.file_unique_id,
			fileSize: message.animation.file_size ?? 0,
			mimeType: message.animation.mime_type ?? 'video/mp4',
			fileName: message.animation.file_name ?? `animation_${ts}.mp4`,
		};
	}

	if (message.audio) {
		return {
			fileId: message.audio.file_id,
			fileUniqueId: message.audio.file_unique_id,
			fileSize: message.audio.file_size ?? 0,
			mimeType: message.audio.mime_type ?? 'audio/mpeg',
			fileName: message.audio.file_name ?? message.audio.title ?? `audio_${ts}.mp3`,
		};
	}

	if (message.voice) {
		return {
			fileId: message.voice.file_id,
			fileUniqueId: message.voice.file_unique_id,
			fileSize: message.voice.file_size ?? 0,
			mimeType: message.voice.mime_type ?? 'audio/ogg',
			fileName: `voice_${ts}.ogg`,
		};
	}

	if (message.video_note) {
		return {
			fileId: message.video_note.file_id,
			fileUniqueId: message.video_note.file_unique_id,
			fileSize: message.video_note.file_size ?? 0,
			mimeType: 'video/mp4',
			fileName: `videonote_${ts}.mp4`,
		};
	}

	if (message.sticker && !message.sticker.is_animated) {
		return {
			fileId: message.sticker.file_id,
			fileUniqueId: message.sticker.file_unique_id,
			fileSize: message.sticker.file_size ?? 0,
			mimeType: 'image/webp',
			fileName: `sticker_${ts}.webp`,
		};
	}

	return null;
}

// =============================================================================
//  Core Command Handlers
// =============================================================================

// ---- /start & /help ----

async function handleHelp(env, chatId) {
	const text = `📦 <b>TeleFileBot</b>

Send any file to save it instantly.

<b>Commands:</b>
/list — List all files
/list <i>tag</i> — Filter by tag
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

	// Persist to database
	await dbRun(
		env.DB,
		`INSERT INTO files (file_name, file_id, file_unique_id, file_size, mime_type, message_id, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[fileName, fileId, fileUniqueId, fileSize, mimeType, channelMsgId, ''],
	);

	await sendMessage(env.BOT_TOKEN, chatId, `✅ File saved\n📄 <b>${escapeHtml(fileName)}</b>\n💾 ${formatFileSize(fileSize)}`);
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

async function sendFileList(env, chatId, editMsgId, tag, page) {
	let files;
	let total;

	if (tag) {
		const pattern = `%${tag}%`;
		files = await dbAll(
			env.DB,
			`SELECT id, file_name, file_size, tags, uploaded_at FROM files
       WHERE tags LIKE ? ORDER BY uploaded_at DESC LIMIT ? OFFSET ?`,
			[pattern, PAGE_SIZE, page * PAGE_SIZE],
		);
		const row = await dbFirst(env.DB, 'SELECT COUNT(*) AS cnt FROM files WHERE tags LIKE ?', [pattern]);
		total = row?.cnt ?? 0;
	} else {
		files = await dbAll(
			env.DB,
			`SELECT id, file_name, file_size, tags, uploaded_at FROM files
       ORDER BY uploaded_at DESC LIMIT ? OFFSET ?`,
			[PAGE_SIZE, page * PAGE_SIZE],
		);
		const row = await dbFirst(env.DB, 'SELECT COUNT(*) AS cnt FROM files', []);
		total = row?.cnt ?? 0;
	}

	if (total === 0) {
		const msg = tag ? `📂 No files found with tag <b>${escapeHtml(tag)}</b>` : '📂 No files stored yet. Send a file to get started!';
		if (editMsgId) {
			await editMessage(env.BOT_TOKEN, chatId, editMsgId, msg);
		} else {
			await sendMessage(env.BOT_TOKEN, chatId, msg);
		}
		return;
	}

	const totalPages = Math.ceil(total / PAGE_SIZE);

	let text = tag ? `📂 Tag: <b>${escapeHtml(tag)}</b>\n` : '📂 <b>All Files</b>\n';
	text += `${total} file${total !== 1 ? 's' : ''} · Page ${page + 1}/${totalPages}\n\n`;

	files.forEach((f, i) => {
		const idx = page * PAGE_SIZE + i + 1;
		const tags = f.tags ? ` 🏷 ${f.tags}` : '';
		text += `${idx}. 📄 <b>${escapeHtml(f.file_name)}</b>\n    💾 ${formatFileSize(f.file_size)}${tags}\n`;
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
