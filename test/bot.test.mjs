// End-to-end tests for src/index.js: a real SQLite database (node:sqlite)
// behind a D1-like wrapper, a fake Telegram API (global fetch) and a fake
// Workers AI. Run with `npm test` (Node 22.5+).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = join(root, 'schema.sql');
const oldSchemaPath = join(root, 'test', 'fixtures', 'schema-v1.sql'); // the original schema, before any migration
const migrationPath = join(root, 'migrations', '0001_add_category.sql');

// Load a copy of the worker that also exports STRINGS, for the i18n check
const workerCopy = join(mkdtempSync(join(tmpdir(), 'telebot-test-')), 'index.mjs');
writeFileSync(workerCopy, readFileSync(join(root, 'src', 'index.js'), 'utf8') + '\nexport { STRINGS };\n');
const workerModule = await import(pathToFileURL(workerCopy).href);
const worker = workerModule.default;

// Set to a function(sql) that returns true to make that query throw once
let dbFailOnce = null;
function d1(db) {
	return {
		prepare(sql) {
			let params = [];
			const maybeFail = () => {
				if (dbFailOnce && dbFailOnce(sql)) {
					dbFailOnce = null;
					throw new Error('D1_ERROR: simulated failure');
				}
			};
			const stmt = {
				bind(...p) { params = p; maybeFail(); return stmt; },
				run() {
					const r = db.prepare(sql).run(...params);
					return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
				},
				all() { return { results: db.prepare(sql).all(...params) }; },
				first() { return db.prepare(sql).get(...params) ?? null; },
			};
			return stmt;
		},
	};
}

// ---- Telegram mock ----
const tgCalls = [];
let channelMsgId = 1000;
// Set to a function({method, body}) returning a Response to fake a Telegram error
let tgHook = null;
globalThis.fetch = async (url, init) => {
	url = String(url);
	if (url.includes('/file/bot')) {
		return new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]));
	}
	const method = url.split('/').pop();
	const body = init?.body ? JSON.parse(init.body) : {};
	tgCalls.push({ method, body });
	const hooked = tgHook?.({ method, body });
	if (hooked) return hooked;
	let result = true;
	if (method === 'forwardMessage') result = { message_id: ++channelMsgId };
	if (method === 'getFile') result = { file_id: body.file_id, file_size: 6, file_path: `photos/${body.file_id}.jpg` };
	if (method === 'sendMessage' || method === 'editMessageText') result = { message_id: 1 };
	return Response.json({ ok: true, result });
};

// ---- AI mock ----
const aiCalls = [];
let aiBehavior = () => ({ choices: [{ message: { content: '{"category":"财务"}' } }] });
const AI = { run: async (model, input) => { aiCalls.push({ model, input }); return aiBehavior(input); } };

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(schemaPath, 'utf8'));
const ADMIN = 42;
const env = { DB: d1(db), AI, BOT_TOKEN: 'T', BOT_SECRET: 'S', CHANNEL_ID: '-100', ADMIN_ID: String(ADMIN) };

async function send(update) {
	tgCalls.length = 0;
	const res = await worker.fetch(new Request('https://x/webhook/S', { method: 'POST', body: JSON.stringify(update) }), env);
	assert.equal(res.status, 200);
	return tgCalls;
}
const msg = (extra) => ({ message: { message_id: 7, chat: { id: ADMIN }, ...extra } });
const cb = (data) => ({ callback_query: { id: 'c', data, message: { message_id: 5, chat: { id: ADMIN } } } });
const lastText = (calls) => calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').pop();

// 1. Document with caption → AI → 财务, with change-category button
let calls = await send(msg({ document: { file_id: 'd1', file_unique_id: 'u1', file_name: '2024发票.pdf', mime_type: 'application/pdf', file_size: 1000 }, caption: '报销用' }));
assert.equal(aiCalls.length, 1);
assert.equal(aiCalls[0].model, '@cf/google/gemma-4-26b-a4b-it');
const userText = aiCalls[0].input.messages[1].content[0].text;
assert.match(userText, /2024发票\.pdf/);
assert.match(userText, /报销用/);
assert.equal(aiCalls[0].input.messages[1].content.length, 1, 'no image for pdf without thumbnail');
assert.deepEqual(aiCalls[0].input.chat_template_kwargs, { enable_thinking: false });
let m = lastText(calls);
assert.match(m.body.text, /💰 Finance/);
assert.match(m.body.text, /Saved as <b>2024发票\.pdf<\/b>\n/, 'meaningful name kept, not marked auto-named');
assert.deepEqual(m.body.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['ren:1', 'catmenu:1']);
assert.equal(db.prepare('SELECT category FROM files WHERE id=1').get().category, '财务');
console.log('ok 1 document → AI → 财务');

// 2. Photo → preview downloaded as data URL, mid-size picked
aiBehavior = () => ({ choices: [{ message: { content: '{"category":"截图"}' } }] });
calls = await send(msg({ photo: [
	{ file_id: 'p_s', file_unique_id: 'ps', width: 90, height: 160 },
	{ file_id: 'p_m', file_unique_id: 'pm', width: 720, height: 1280 },
	{ file_id: 'p_l', file_unique_id: 'pl', width: 1080, height: 1920, file_size: 300000 },
] }));
const getFile = calls.find((c) => c.method === 'getFile');
assert.equal(getFile.body.file_id, 'p_m');
const imgPart = aiCalls.at(-1).input.messages[1].content[1];
assert.equal(imgPart.type, 'image_url');
assert.match(imgPart.image_url.url, /^data:image\/jpeg;base64,\/9j\//);
assert.match(lastText(calls).body.text, /🖼 Screenshots/);
const today = new Date().toISOString().slice(0, 10);
assert.ok(lastText(calls).body.text.includes(`Saved as <b>Screenshots_${today}.jpg</b> <i>(auto-named)</i>`), 'no AI name → category_date');
console.log('ok 2 photo → image sent to model → 截图');

// 2b. Auto-naming from the model's suggestion
const photoMsg = (id) => msg({ date: 1794614400, photo: [{ file_id: id, file_unique_id: id + 'u', width: 800, height: 600 }] });
aiBehavior = () => ({ choices: [{ message: { content: '{"category":"财务","name":"鲜果超市小票_2026-11-14.jpg"}' } }] });
calls = await send(photoMsg('n1'));
assert.match(lastText(calls).body.text, /Saved as <b>鲜果超市小票_2026-11-14\.jpg<\/b> <i>\(auto-named\)<\/i>/, 'extension from model stripped, original kept');
assert.match(aiCalls.at(-1).input.messages[0].content, /^You organize files[\s\S]*2\. name:[\s\S]*in English/, 'English prompt by default');
assert.deepEqual(aiCalls.at(-1).input.response_format.json_schema.schema.properties.category.enum.slice(0, 3), ['study', 'work', 'finance'], 'ASCII ids in English prompts');
assert.match(aiCalls.at(-1).input.messages[1].content[0].text, /^File name: photo_/);
calls = await send(photoMsg('n2'));
assert.match(lastText(calls).body.text, /Saved as <b>鲜果超市小票_2026-11-14_1\.jpg<\/b>/, 'duplicate names get a suffix');
aiBehavior = () => ({ choices: [{ message: { content: '{"category":"照片","name":"IMG_0001"}' } }] });
calls = await send(photoMsg('n3'));
assert.match(lastText(calls).body.text, /Saved as <b>Photos_2026-11-14\.jpg<\/b>/, 'generic AI name → category_date (message date)');
aiBehavior = () => ({ choices: [{ message: { content: '{"category":"学习","name":"完全不同的名字"}' } }] });
calls = await send(msg({ document: { file_id: 'dn', file_unique_id: 'dnu', file_name: 'CS5800 notes.pdf', mime_type: 'application/pdf' } }));
assert.match(lastText(calls).body.text, /Saved as <b>CS5800 notes\.pdf<\/b>\n/, 'meaningful names never replaced');
aiBehavior = () => ({ choices: [{ message: { content: '{"category":"影音","name":"猫咪跳上桌子"}' } }] });
calls = await send(msg({ document: { file_id: 'ds', file_unique_id: 'dsu', file_name: 'IMG_4521.MOV', mime_type: 'video/quicktime' } }));
assert.match(lastText(calls).body.text, /Saved as <b>猫咪跳上桌子\.MOV<\/b>/, 'camera names replaced, extension kept');
calls = await send(msg({ document: { file_id: 'dw', file_unique_id: 'dwu', file_name: 'Screenshot_20261101-093000_WeChat.jpg', mime_type: 'image/jpeg', file_size: 5000 } }));
assert.match(lastText(calls).body.text, /Saved as <b>猫咪跳上桌子\.jpg<\/b>/, 'screenshot names count as generic');
calls = await send(msg({ document: { file_id: 'dx', file_unique_id: 'dxu', file_name: 'document_1794614400', mime_type: 'application/pdf' } }));
assert.match(lastText(calls).body.text, /Saved as <b>猫咪跳上桌子\.pdf<\/b>/, 'extension from MIME when name has none');
let sticker = await send(msg({ sticker: { file_id: 's9', file_unique_id: 's9u', is_animated: false } }));
assert.match(lastText(sticker).body.text, /Saved as <b>sticker_\d+\.webp<\/b>\n/, 'stickers keep generated names');
aiBehavior = () => ({ choices: [{ message: { content: '{"category":"截图"}' } }] });
console.log('ok 2b auto-naming: suggestion, suffix, fallbacks, keep meaningful');

// 3. Sticker → rule, no AI
let n = aiCalls.length;
calls = await send(msg({ sticker: { file_id: 's1', file_unique_id: 'su1', is_animated: false } }));
assert.equal(aiCalls.length, n);
assert.match(lastText(calls).body.text, /😀 Stickers/);
// APK → rule
calls = await send(msg({ document: { file_id: 'a1', file_unique_id: 'au1', file_name: 'app.APK', mime_type: 'application/vnd.android.package-archive' } }));
assert.equal(aiCalls.length, n);
assert.match(lastText(calls).body.text, /💿 Software/);
console.log('ok 3 sticker/apk → rules, no AI call');

// 4. AI fails with image → retried without image
let attempt = 0;
aiBehavior = (input) => {
	attempt++;
	if (input.messages[1].content.length > 1) throw new Error('image not supported');
	return { choices: [{ message: { content: '{"category":"证件"}' } }] };
};
calls = await send(msg({ photo: [{ file_id: 'p2', file_unique_id: 'p2u', width: 800, height: 600 }] }));
assert.equal(attempt, 2);
assert.match(lastText(calls).body.text, /🪪 IDs/);
console.log('ok 4 image failure → text-only retry');

// 5. Garbage reply → MIME fallback; AI missing → fallback
aiBehavior = () => ({ choices: [{ message: { content: 'I think it is a nice video' } }] });
calls = await send(msg({ video: { file_id: 'v1', file_unique_id: 'vu1', file_name: 'clip.mp4', mime_type: 'video/mp4' } }));
assert.match(lastText(calls).body.text, /🎬 Media/);
aiBehavior = () => ({ choices: [{ message: { content: '<think>hmm</think>{"category": "学习"}' } }] });
calls = await send(msg({ document: { file_id: 'd3', file_unique_id: 'u3', file_name: 'lecture3.pptx', mime_type: 'application/vnd.ms-powerpoint' } }));
assert.match(lastText(calls).body.text, /📚 Study/);
const savedAI = env.AI; env.AI = undefined;
calls = await send(msg({ document: { file_id: 'd4', file_unique_id: 'u4', file_name: 'x.bin', mime_type: 'application/octet-stream' } }));
assert.match(lastText(calls).body.text, /📦 Other/);
env.AI = savedAI;
console.log('ok 5 garbage/think-tags/no-binding handled');

// 6. Browse + change category
for (const cmd of ['/list', '/cats']) {
	calls = await send(msg({ text: cmd }));
	const catsMsg = lastText(calls);
	assert.match(catsMsg.body.text, /Categories/);
	const kbd = catsMsg.body.reply_markup.inline_keyboard.flat();
	const btn = kbd.find((b) => b.callback_data === 'page:0:财务');
	assert.equal(btn.text, `💰 Finance · ${db.prepare("SELECT COUNT(*) c FROM files WHERE category='财务'").get().c}`);
	assert.equal(btn.callback_data, 'page:0:财务');
	assert.equal(kbd.at(-1).callback_data, 'page:0', 'All files button last');
	assert.ok(!kbd.some((b) => b.text.includes('学习 · 0')), 'empty categories hidden');
}
calls = await send(cb('page:0:财务'));
let listMsg = lastText(calls);
assert.match(listMsg.body.text, /2024发票\.pdf/);
assert.doesNotMatch(listMsg.body.text, /clip\.mp4/);
assert.equal(listMsg.body.reply_markup.inline_keyboard.at(-1)[0].callback_data, 'cats', 'back button');
calls = await send(cb('cats'));
assert.equal(lastText(calls).method, 'editMessageText');
assert.match(lastText(calls).body.text, /Categories/);
calls = await send(msg({ text: '/list 学习' }));
assert.match(lastText(calls).body.text, /lecture3\.pptx/);
calls = await send(msg({ text: '/all' }));
listMsg = lastText(calls);
assert.match(listMsg.body.text, /^<b>📂 All files<\/b>\n<i>\d+ files · page 1 of \d+<\/i>\n━+\n\n/);
assert.match(listMsg.body.text, /<b>1\.<\/b> \S+ .+\n<i>[^<]+ · [^<]+<\/i>\n\n<b>2\.<\/b>/, 'entries separated by a blank line');
assert.match(listMsg.body.text, /\n\n━+\n<i>Tap a number to get that file\.<\/i>$/, 'footer');
calls = await send(msg({ text: '/list 财务' }));
assert.match(lastText(calls).body.text, /📄 2024发票\.pdf\n<i>1000 B · \d\d-\d\d<\/i>/, 'category page omits category, shows date');
calls = await send(cb('page:1'));
assert.match(lastText(calls).body.text, /🖼 Screenshots_/, 'auto-named photo on page 2 of /all');
calls = await send(msg({ text: '/all' }));
listMsg = lastText(calls);
// Preview: every previewable image on page 0 goes into the album
const prevBtn = listMsg.body.reply_markup.inline_keyboard.flat().find((b) => b.text === '🖼 Preview');
assert.equal(prevBtn.callback_data, 'prev:0');
calls = await send(cb('prev:0'));
const album = calls.find((c) => c.method === 'sendMediaGroup');
const page0 = db.prepare('SELECT file_id, file_name, mime_type FROM files ORDER BY uploaded_at DESC, id DESC LIMIT 10').all();
const expectImgs = page0.filter((f) => f.mime_type.startsWith('image/') && !/^sticker_/.test(f.file_name)).map((f) => f.file_id);
assert.ok(expectImgs.length >= 2);
assert.equal(album.body.media[0].type, 'photo');
assert.deepEqual(album.body.media.map((m) => m.media).sort(), expectImgs.sort());
assert.ok(album.body.media.every((m) => /^\d+\. /.test(m.caption)));
// No preview button when the page has no images
calls = await send(msg({ text: '/list 学习' }));
assert.ok(!lastText(calls).body.reply_markup.inline_keyboard.flat().some((b) => b.text === '🖼 Preview'));
// Help + command menu
calls = await send(msg({ text: '/help' }));
assert.match(lastText(calls).body.text, /<b>BROWSE<\/b>\n\/list \[&lt;category&gt;\]/);
assert.match(lastText(calls).body.text, /\/tag &lt;name&gt; &lt;tag&gt;\.\.\./);
assert.match(lastText(calls).body.text, /NOTATION/);
const menu = calls.find((c) => c.method === 'setMyCommands');
assert.ok(menu.body.commands.some((c) => c.command === 'all'));

calls = await send(cb('catmenu:1'));
const kb = lastText(calls).body.reply_markup.inline_keyboard.flat();
assert.equal(kb.length, 12); // 11 categories + cancel
for (const b of kb) assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
calls = await send(cb('setcat:1:工作'));
assert.match(lastText(calls).body.text, /💼 Work/);
assert.equal(db.prepare('SELECT category FROM files WHERE id=1').get().category, '工作');
calls = await send(cb('setcat:1:bogus'));
assert.equal(db.prepare('SELECT category FROM files WHERE id=1').get().category, '工作');
calls = await send(msg({ text: '/cat lecture' }));
assert.match(lastText(calls).body.text, /Pick a category for <b>lecture3\.pptx/);
console.log('ok 6 /cats, /list category, catmenu, setcat, /cat');

// 7. Backfill old files with /classify
const ins = db.prepare("INSERT INTO files (file_name,file_id,file_unique_id,file_size,mime_type,message_id,category) VALUES (?,?,?,?,?,?, '')");
for (let i = 0; i < 10; i++) ins.run(`old_${i}.docx`, `o${i}`, `ou${i}`, 10, 'application/msword', 1);
ins.run('photo_1700000000.jpg', 'oph', 'ouph', 5000, 'image/jpeg', 1);
db.prepare("UPDATE files SET uploaded_at = '2020-01-01' WHERE category = ''").run();
aiBehavior = () => ({ choices: [{ message: { content: '{"category":"工作"}' } }] });
calls = await send(msg({ text: '/classify' }));
let out = lastText(calls);
assert.match(out.body.text, /Processed 8 files/);
assert.match(out.body.text, /3 left/);
assert.equal(out.body.reply_markup.inline_keyboard[0][0].callback_data, 'classify_more');
const firstBatch = out.body.text;
calls = await send(cb('classify_more'));
out = lastText(calls);
assert.match(out.body.text, /Processed 3 files/);
assert.match(firstBatch + out.body.text, /Work_2020-01-01\.jpg\n<i>💼 Work<\/i>\n<i>was photo_1700000000\.jpg<\/i>/);
assert.match(out.body.text, /All done/);
assert.equal(db.prepare("SELECT COUNT(*) c FROM files WHERE category=''").get().c, 0);
// A categorized file with a generic name: category kept, name fixed
db.prepare("INSERT INTO files (file_name,file_id,file_unique_id,file_size,mime_type,message_id,category,uploaded_at) VALUES ('IMG_7777.jpg','g7','g7u',10,'image/jpeg',1,'证件','2021-05-06 10:00:00')").run();
aiBehavior = () => ({ choices: [{ message: { content: '{"category":"照片","name":"护照首页"}' } }] });
calls = await send(msg({ text: '/classify' }));
assert.match(lastText(calls).body.text, /护照首页\.jpg\n<i>🪪 IDs<\/i>/);
calls = await send(msg({ text: '/classify' }));
assert.match(lastText(calls).body.text, /Every file has a category and a real name/, 'no endless re-processing');
const photoCall = aiCalls.find((c) => c.input.messages[1].content[0].text.includes('photo_1700000000'));
assert.equal(photoCall.input.messages[1].content[1].type, 'image_url', 'old small image sent to model');
calls = await send(msg({ text: '/stats' }));
assert.match(lastText(calls).body.text, /By category/);
console.log('ok 7 /classify backfill in batches, /stats');

// 7b. /get: exact → contains → all words → AI
const sent = (calls) => calls.filter((c) => c.method === 'copyMessage');
n = aiCalls.length;
calls = await send(msg({ text: '/get LECTURE3.PPTX' }));
assert.equal(sent(calls).length, 1, 'case-insensitive exact');
calls = await send(msg({ text: '/get 发票' }));
assert.equal(sent(calls).length, 1, 'substring');
calls = await send(msg({ text: '/get 2024 pdf' }));
assert.equal(sent(calls).length, 1, 'all words in any order');
calls = await send(msg({ text: '/get old_' }));
assert.match(lastText(calls).body.text, /🔍 10 files match “old_”/);
assert.equal(aiCalls.length, n, 'no AI call when a name matches');

aiBehavior = (input) => {
	assert.match(input.messages[0].content, /找文件/);
	assert.match(input.messages[1].content, /要找：报销的单子/);
	assert.match(input.messages[1].content, /\n1 \| 2024发票\.pdf \| 工作\/Work/, 'both category names in search list');
	return { choices: [{ message: { content: '{"ids":[1, 999, 1]}' } }] };
};
calls = await send(msg({ text: '/get 报销的单子' }));
assert.equal(aiCalls.length, n + 1);
assert.equal(sent(calls).length, 0, 'AI results are confirmed, not auto-sent');
out = lastText(calls);
assert.match(out.body.text, /🤖 AI suggestions/);
assert.match(out.body.text, /1\.<\/b> 📄 2024发票\.pdf/);
assert.doesNotMatch(out.body.text, /2\.<\/b>/, 'unknown and duplicate ids dropped');
assert.equal(out.body.reply_markup.inline_keyboard[0][0].callback_data, 'get:1');

aiBehavior = () => ({ choices: [{ message: { content: '{"ids":[]}' } }] });
calls = await send(msg({ text: '/get 完全不存在的东西' }));
assert.match(lastText(calls).body.text, /AI search found nothing/);
aiBehavior = () => { throw new Error('boom'); };
calls = await send(msg({ text: '/get 完全不存在的东西' }));
assert.match(lastText(calls).body.text, /AI search found nothing/);
console.log('ok 7b /get name matching then AI fallback');

// 7c. Rename: button → force-reply prompt → reply
calls = await send(cb('ren:1'));
let promptMsg = lastText(calls);
assert.deepEqual(promptMsg.body.reply_markup.force_reply, true);
assert.match(promptMsg.body.text, /#1$/);
const plain = promptMsg.body.text.replace(/<[^>]+>/g, ''); // Telegram sends back plain text
const reply = (text) => msg({ text, reply_to_message: { message_id: 99, from: { id: 1, is_bot: true }, text: plain } });
calls = await send(reply('报销发票 2024'));
assert.match(lastText(calls).body.text, /2024发票\.pdf<\/b> → <b>报销发票 2024\.pdf/, 'extension kept');
assert.equal(db.prepare('SELECT file_name FROM files WHERE id=1').get().file_name, '报销发票 2024.pdf');
calls = await send(reply('lecture3.pptx'));
assert.match(lastText(calls).body.text, /already exists/);
calls = await send(reply('/help'));
assert.match(lastText(calls).body.text, /BROWSE/, 'commands are not taken as names');
const notPrompt = msg({ text: 'hello', reply_to_message: { from: { is_bot: true }, text: 'something else #1' } });
calls = await send(notPrompt);
assert.equal(calls.filter((c) => c.method === 'sendMessage').length, 1);
assert.match(lastText(calls).body.text, /Send me a file to save it/, 'replies to other bot messages are not renames; they get the hint');
assert.equal(db.prepare('SELECT file_name FROM files WHERE id=1').get().file_name, '报销发票 2024.pdf', 'name untouched');
// /rename <name> opens the prompt (spaces allowed); /rename <old> <new> renames directly
calls = await send(msg({ text: '/rename 报销发票' }));
assert.match(lastText(calls).body.text, /Reply with a new name for <b>报销发票 2024\.pdf/);
calls = await send(msg({ text: '/rename lecture3.pptx 第三讲.pptx' }));
assert.match(lastText(calls).body.text, /→ <b>第三讲\.pptx/);
console.log('ok 7c rename via button, reply, and /rename');

// 7d. Albums: concurrent items → one summary; stragglers edit it; duplicates counted
env.ALBUM_SETTLE_MS = 150;
async function sendConcurrent(updates) {
	tgCalls.length = 0;
	const pending = [];
	const ctx = { waitUntil: (p) => pending.push(p) };
	await Promise.all(
		updates.map((u) => worker.fetch(new Request('https://x/webhook/S', { method: 'POST', body: JSON.stringify(u) }), env, ctx)),
	);
	await Promise.all(pending);
	return tgCalls;
}
const albumItem = (gid, id, caption) =>
	msg({ media_group_id: gid, ...(caption ? { caption } : {}), photo: [{ file_id: id, file_unique_id: id + 'u', width: 800, height: 600 }] });
aiBehavior = (input) => ({ choices: [{ message: { content: JSON.stringify({ category: '财务', name: '小票_' + input.messages[1].content[0].text.length }) } }] });
n = aiCalls.length;
calls = await sendConcurrent([albumItem('g1', 'a1', '上周买菜'), albumItem('g1', 'a2'), albumItem('g1', 'a3')]);
const sends = calls.filter((c) => c.method === 'sendMessage');
assert.equal(sends.length, 1, 'exactly one message for the album');
assert.match(sends[0].body.text, /Saved 3 files from an album/);
assert.match(sends[0].body.text, /💰 Finance ×3/);
assert.match(sends[0].body.text, /^<b>📦 Saved 3 files from an album<\/b>\n<i>💰 Finance ×3\n💬 上周买菜<\/i>\n━+\n\n<b>1\.<\/b> 🖼 /);
assert.equal(sends[0].body.reply_markup.inline_keyboard[0].length, 3);
assert.ok(aiCalls.slice(n).every((c) => c.input.messages[1].content[0].text.includes('Caption: 上周买菜')), 'caption shared with all items');
assert.equal(db.prepare("SELECT COUNT(*) c FROM files WHERE media_group_id='g1'").get().c, 3);

// Straggler arrives after the summary → summary edited, no new message
calls = await sendConcurrent([albumItem('g1', 'a4')]);
assert.equal(calls.filter((c) => c.method === 'sendMessage').length, 0);
const edit = calls.find((c) => c.method === 'editMessageText');
assert.match(edit.body.text, /Saved 4 files from an album/);

// Re-sending the same album: all duplicates
calls = await sendConcurrent([albumItem('g2', 'a1'), albumItem('g2', 'a2')]);
assert.equal(calls.filter((c) => c.method === 'sendMessage').length, 1);
assert.match(lastText(calls).body.text, /All 2 files in this album were already saved/);
// Mixed new + duplicate
calls = await sendConcurrent([albumItem('g3', 'a1'), albumItem('g3', 'b9')]);
assert.match(lastText(calls).body.text, /Saved 1 file from an album[\s\S]*1 already saved, skipped/);

// Number button → file card with Get / Rename / Category
const firstId = db.prepare("SELECT id FROM files WHERE media_group_id='g1' ORDER BY id").get().id;
calls = await send(cb(`file:${firstId}`));
assert.deepEqual(lastText(calls).body.reply_markup.inline_keyboard[0].map((b) => b.callback_data), [`get:${firstId}`, `ren:${firstId}`, `catmenu:${firstId}`]);
// Single (non-album) uploads still get their own confirmation
calls = await send(msg({ photo: [{ file_id: 'solo', file_unique_id: 'solou', width: 800, height: 600 }] }));
assert.match(lastText(calls).body.text, /Saved as/);
console.log('ok 7d albums: one summary, straggler edit, duplicates, file card');

// 7e. Languages: BOT_LANG default, /lang override, same stored keys, names untouched
const nameOf = (id) => db.prepare('SELECT file_name FROM files WHERE id=?').get(id).file_name;
const namesBefore = db.prepare('SELECT id, file_name, category FROM files ORDER BY id').all();
env.BOT_LANG = 'zh';
calls = await send(msg({ text: '/help' }));
assert.match(lastText(calls).body.text, /<b>浏览<\/b>\n\/list \[&lt;分类&gt;\]/, 'BOT_LANG=zh → Chinese help');
assert.equal(calls.find((c) => c.method === 'setMyCommands').body.commands[0].description, '按分类浏览');
calls = await send(msg({ text: '/list' }));
const zhKbd = lastText(calls).body.reply_markup.inline_keyboard.flat();
const zhFin = zhKbd.find((b) => b.callback_data === 'page:0:财务');
assert.match(zhFin.text, /^💰 财务 · \d+$/, 'Chinese label, same stored key in callback');
assert.match(zhKbd.at(-1).text, /^📂 全部文件 · \d+$/);
for (const q of ['Finance', 'finance', '财务']) {
	calls = await send(msg({ text: `/list ${q}` }));
	assert.match(lastText(calls).body.text, /^<b>💰 财务<\/b>\n<i>\d+ 个文件/, `"/list ${q}" resolves to the same category`);
}
// Chinese prompt and naming
aiBehavior = () => ({ choices: [{ message: { content: '{"category":"照片","name":"IMG_9"}' } }] });
calls = await send(msg({ date: 1794614400, photo: [{ file_id: 'zh1', file_unique_id: 'zh1u', width: 800, height: 600 }] }));
assert.match(aiCalls.at(-1).input.messages[0].content, /一、category/);
assert.deepEqual(aiCalls.at(-1).input.response_format.json_schema.schema.properties.category.enum, ['学习', '工作', '财务', '证件', '书籍', '照片', '截图', '影音', '软件', '表情包', '其他']);
assert.match(aiCalls.at(-1).input.messages[1].content[0].text, /^文件名：photo_/);
assert.match(lastText(calls).body.text, /^✅ 已保存为 <b>照片_2026-11-14\.jpg<\/b> <i>（自动命名）<\/i>\n🗂 📷 照片/, 'Chinese fallback name and labels');
// English model answer (ASCII id) maps to the same stored key
env.BOT_LANG = 'en';
aiBehavior = () => ({ choices: [{ message: { content: '{"category":"photos","name":"Sunset at the beach"}' } }] });
calls = await send(msg({ photo: [{ file_id: 'en1', file_unique_id: 'en1u', width: 800, height: 600 }] }));
assert.match(lastText(calls).body.text, /^✅ Saved as <b>Sunset at the beach\.jpg<\/b> <i>\(auto-named\)<\/i>\n🗂 📷 Photos/);
assert.equal(db.prepare("SELECT category FROM files WHERE file_unique_id='en1u'").get().category, '照片', 'stored key stays Chinese');
// /lang overrides BOT_LANG and persists; callbacks switch too
calls = await send(msg({ text: '/lang' }));
assert.deepEqual(lastText(calls).body.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['lang:en', 'lang:zh']);
assert.match(lastText(calls).body.reply_markup.inline_keyboard[0][0].text, /^✓ English/);
calls = await send(msg({ text: '/lang 中文' }));
assert.match(lastText(calls).body.text, /语言已切换为 <b>中文<\/b>/);
assert.equal(calls.find((c) => c.method === 'setMyCommands').body.commands[0].description, '按分类浏览');
calls = await send(msg({ text: '/stats' }));
assert.match(lastText(calls).body.text, /存储统计[\s\S]*按分类/, 'settings row beats BOT_LANG=en');
calls = await send(cb('lang:en'));
assert.equal(lastText(calls).method, 'editMessageText');
assert.match(lastText(calls).body.text, /Language set to <b>English<\/b>/);
assert.equal(db.prepare("SELECT value FROM settings WHERE key='lang'").get().value, 'en');
// Rename prompt is recognised in either language
await send(msg({ text: '/lang zh' }));
calls = await send(cb('ren:1'));
const zhPrompt = lastText(calls).body.text.replace(/<[^>]+>/g, '');
assert.match(zhPrompt, /^✏️ 回复新名字：/);
await send(msg({ text: '/lang en' }));
calls = await send(msg({ text: '新名字', reply_to_message: { from: { is_bot: true }, text: zhPrompt } }));
assert.match(lastText(calls).body.text, /Renamed[\s\S]*新名字\.pdf/, 'zh prompt still works after switching to en');
// Existing names and categories never changed by switching (except the one we just renamed)
const namesAfter = db.prepare('SELECT id, file_name, category FROM files ORDER BY id').all();
for (const before of namesBefore) {
	const after = namesAfter.find((r) => r.id === before.id);
	assert.equal(after.category, before.category);
	if (before.id !== 1) assert.equal(after.file_name, before.file_name);
}
// Old DB without the settings table → falls back to BOT_LANG instead of failing
db.exec('ALTER TABLE settings RENAME TO settings_off');
env.BOT_LANG = 'zh';
calls = await send(msg({ text: '/help' }));
assert.match(lastText(calls).body.text, /<b>浏览<\/b>/);
db.exec('ALTER TABLE settings_off RENAME TO settings');
db.exec("DELETE FROM settings");
delete env.BOT_LANG;
console.log('ok 7e languages: BOT_LANG, /lang, shared keys, names untouched');

// 9. Edge cases and robustness
const tgError = (status, description, extra = {}) => new Response(JSON.stringify({ ok: false, error_code: status, description, ...extra }), { status });
const sentTexts = (calls) => calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText');

// 9a. i18n: both languages define the same strings
const { STRINGS } = workerModule;
assert.deepEqual(Object.keys(STRINGS.zh).sort(), Object.keys(STRINGS.en).sort(), 'en and zh have the same keys');

// 9b. Telegram rejects the HTML → resent as plain text
tgHook = ({ method, body }) => (method === 'sendMessage' && body.parse_mode === 'HTML' ? tgError(400, "Bad Request: can't parse entities: unclosed tag") : null);
calls = await send(msg({ text: '/stats' }));
tgHook = null;
const statsSends = calls.filter((c) => c.method === 'sendMessage');
assert.equal(statsSends.length, 2);
assert.equal(statsSends[1].body.parse_mode, undefined);
assert.doesNotMatch(statsSends[1].body.text, /<b>/, 'plain-text fallback has no tags');

// 9c. Rate limit → waits retry_after and retries once
let hits = 0;
tgHook = ({ method }) => (method === 'sendMessage' && hits++ === 0 ? tgError(429, 'Too Many Requests: retry after 1', { parameters: { retry_after: 0.05 } }) : null);
calls = await send(msg({ text: '/help' }));
tgHook = null;
assert.equal(calls.filter((c) => c.method === 'sendMessage').length, 2, 'retried after 429');

// 9d. Editing to identical content / expired button answers are not errors
tgHook = ({ method }) =>
	method === 'editMessageText' ? tgError(400, 'Bad Request: message is not modified') : method === 'answerCallbackQuery' ? tgError(400, 'Bad Request: query is too old') : null;
calls = await send(cb('cats'));
tgHook = null;
assert.ok(!sentTexts(calls).some((c) => c.method === 'sendMessage'), 'no error message sent');

// 9e. Long names with HTML-special characters stay under 4096 chars per message
for (let i = 0; i < 12; i++) {
	db.prepare("INSERT INTO files (file_name,file_id,file_unique_id,file_size,mime_type,message_id,category,uploaded_at) VALUES (?,?,?,1,'text/plain',1,'其他','2099-01-01')")
		.run(`${'&<>'.repeat(66)}_${i}.txt`, `long${i}`, `longu${i}`);
}
calls = await send(msg({ text: '/all' }));
const allText = lastText(calls).body.text;
assert.ok(allText.length <= 4096, `list is ${allText.length} chars`);
assert.equal(lastText(calls).body.parse_mode, 'HTML', 'still HTML, names were shortened instead');
assert.match(allText, /&amp;&lt;&gt;/, 'escaped');
db.exec("DELETE FROM files WHERE file_id LIKE 'long%'");

// 9f. Oversized button data never sinks a message (long tag filter)
const longTag = 'x'.repeat(80);
db.prepare("UPDATE files SET tags = ? WHERE id = 2").run(longTag);
calls = await send(msg({ text: `/list #${longTag}` }));
const kbButtons = lastText(calls).body.reply_markup.inline_keyboard.flat();
assert.ok(kbButtons.every((b) => Buffer.byteLength(b.callback_data ?? '') <= 64), 'all buttons within 64 bytes');
assert.match(lastText(calls).body.text, /1 file/);
db.prepare("UPDATE files SET tags = '' WHERE id = 2").run();

// 9g. LIKE wildcards in input are literal
for (const [n, u] of [['a_b.txt', 'lk1'], ['axb.txt', 'lk2'], ['100%.txt', 'lk3'], ['1000.txt', 'lk4']]) {
	db.prepare("INSERT INTO files (file_name,file_id,file_unique_id,file_size,mime_type,message_id,category) VALUES (?,?,?,1,'text/plain',77,'其他')").run(n, u, u);
}
calls = await send(msg({ text: '/get a_b' }));
assert.equal(calls.filter((c) => c.method === 'copyMessage').length, 1, '"a_b" matches only a_b.txt');
calls = await send(msg({ text: '/get 100%' }));
assert.equal(calls.filter((c) => c.method === 'copyMessage').length, 1, '"100%" matches only 100%.txt');

// 9h. Tags: whole-tag matching, #tag beats category names, Unicode, validation, quoted names
calls = await send(msg({ text: '/tag "axb.txt" doc 报销 #Work' }));
assert.match(lastText(calls).body.text, /#doc #报销 #Work/);
calls = await send(msg({ text: '/tag a_b.txt docs' }));
calls = await send(msg({ text: '/list #doc' }));
assert.match(lastText(calls).body.text, /axb\.txt/);
assert.doesNotMatch(lastText(calls).body.text, /a_b\.txt/, '"doc" does not match "docs"');
calls = await send(msg({ text: '/list #work' }));
assert.match(lastText(calls).body.text, /^<b>🏷 work<\/b>[\s\S]*axb\.txt/, '#work is the tag, not the Work category');
calls = await send(msg({ text: '/list 报销' }));
assert.match(lastText(calls).body.text, /axb\.txt/, 'Unicode tag');
calls = await send(msg({ text: '/tag axb.txt !!! ???' }));
assert.match(lastText(calls).body.text, /Tags can contain/);
const tagsBefore = db.prepare("SELECT tags FROM files WHERE file_name='axb.txt'").get().tags;
assert.equal(tagsBefore, 'doc,报销,Work');

// 9i. Quoted names with spaces for /rename
db.prepare("INSERT INTO files (file_name,file_id,file_unique_id,file_size,mime_type,message_id,category) VALUES ('my notes v2.txt','sp1','sp1u',1,'text/plain',1,'学习')").run();
calls = await send(msg({ text: '/rename "my notes v2.txt" "final notes"' }));
assert.match(lastText(calls).body.text, /→ <b>final notes\.txt<\/b>/);

// 9j. Out-of-range and malformed pages
calls = await send(cb('page:999'));
assert.match(lastText(calls).body.text, /page (\d+) of \1<\/i>/, 'lands on the last page');
calls = await send(cb('page:abc'));
assert.match(lastText(calls).body.text, /page 1 of/);
calls = await send(cb('page:-3:其他'));
assert.match(lastText(calls).body.text, /📦 Other/);
calls = await send(cb('prev:999'));
assert.ok(!calls.some((c) => /Something went wrong/.test(c.body?.text ?? '')));

// 9k. Animated and video stickers are saved too
calls = await send(msg({ sticker: { file_id: 'as1', file_unique_id: 'as1u', is_animated: true } }));
assert.match(lastText(calls).body.text, /sticker_\d+\.tgs/);
calls = await send(msg({ sticker: { file_id: 'vs1', file_unique_id: 'vs1u', is_video: true } }));
assert.match(lastText(calls).body.text, /sticker_\d+\.webm/);
assert.equal(db.prepare("SELECT mime_type FROM files WHERE file_unique_id='vs1u'").get().mime_type, 'video/webm');

// 9l. Plain text and unknown commands get an answer
calls = await send(msg({ text: 'hello there' }));
assert.match(lastText(calls).body.text, /Send me a file/);
calls = await send(msg({ text: '/frobnicate now' }));
assert.match(lastText(calls).body.text, /Unknown command \/frobnicate/);

// 9m. The same file delivered twice at once → one row, the extra channel copy is removed
const dupUpdate = msg({ document: { file_id: 'dup', file_unique_id: 'dupu', file_name: 'report.pdf', mime_type: 'application/pdf' } });
aiBehavior = async () => { await new Promise((r) => setTimeout(r, 30)); return { choices: [{ message: { content: '{"category":"work","name":"x"}' } }] }; };
tgCalls.length = 0;
await Promise.all([1, 2].map(() => worker.fetch(new Request('https://x/webhook/S', { method: 'POST', body: JSON.stringify(dupUpdate) }), env)));
assert.equal(db.prepare("SELECT COUNT(*) c FROM files WHERE file_unique_id='dupu'").get().c, 1);
assert.equal(tgCalls.filter((c) => c.method === 'deleteMessage').length, 1, 'orphan channel copy deleted');
assert.equal(tgCalls.filter((c) => /already exists/.test(c.body?.text ?? '')).length, 1);

// 9n. Concurrent uploads that resolve to the same name end up with distinct names
aiBehavior = async () => { await new Promise((r) => setTimeout(r, 20)); return { choices: [{ message: { content: '{"category":"photos","name":"Same scene"}' } }] }; };
const pendingN = [];
const ctxN = { waitUntil: (p) => pendingN.push(p) };
await Promise.all(
	['n1', 'n2', 'n3'].map((id) =>
		worker.fetch(new Request('https://x/webhook/S', { method: 'POST', body: JSON.stringify(msg({ media_group_id: 'gN', photo: [{ file_id: id, file_unique_id: id + 'uq', width: 900, height: 900 }] })) }), env, ctxN),
	),
);
await Promise.all(pendingN);
const sameNames = db.prepare("SELECT file_name FROM files WHERE media_group_id='gN' ORDER BY id").all().map((r) => r.file_name);
assert.equal(new Set(sameNames).size, 3, `distinct names: ${sameNames.join(', ')}`);
assert.equal(sameNames[0], 'Same scene.jpg');

// 9o. A hung AI call times out and the upload still succeeds with a fallback
env.AI_TIMEOUT_MS = 80;
aiBehavior = () => new Promise(() => {});
calls = await send(msg({ photo: [{ file_id: 'hang', file_unique_id: 'hangu', width: 900, height: 900 }] }));
assert.match(lastText(calls).body.text, /Saved as <b>Photos_\d{4}-\d\d-\d\d(_\d+)?\.jpg/);
delete env.AI_TIMEOUT_MS;
aiBehavior = () => ({ choices: [{ message: { content: '{"category":"other"}' } }] });

// 9p. A failing handler tells the admin instead of going quiet
dbFailOnce = (sql) => sql.includes('SUM(file_size)');
calls = await send(msg({ text: '/stats' }));
assert.match(lastText(calls).body.text, /Something went wrong/);

// 9q. /lang without the settings table explains the fix
db.exec('ALTER TABLE settings RENAME TO settings_off');
calls = await send(msg({ text: '/lang zh' }));
assert.match(lastText(calls).body.text, /settings table is missing/);
db.exec('ALTER TABLE settings_off RENAME TO settings');

// 9r. Public endpoints
const http = (path) => worker.fetch(new Request(`https://x${path}`, { method: path.startsWith('/webhook') ? 'POST' : 'GET', body: path.startsWith('/webhook') ? '{}' : undefined }), env);
assert.equal((await http('/registerWebhook')).status, 403, 'register needs the secret');
assert.equal((await http('/unregisterWebhook?secret=wrong')).status, 403);
tgCalls.length = 0;
assert.equal((await http('/registerWebhook?secret=S')).status, 200);
assert.ok(tgCalls.some((c) => c.method === 'setWebhook' && c.body.url === 'https://x/webhook/S'));
assert.equal((await http('/webhook/wrong')).status, 404);
assert.equal((await http('/webhook/S')).status, 200);
const savedSecret = env.BOT_SECRET;
delete env.BOT_SECRET;
assert.equal((await http('/webhook/undefined')).status, 503, 'no secret → refuse, never "/webhook/undefined"');
env.BOT_SECRET = savedSecret;
assert.equal((await http('/health')).status, 200);

console.log('ok 9 edge cases: Telegram errors, limits, input, races, timeouts, endpoints');

// 10. Fixes from the independent review
// 10a. /stats "By type" groups by type, not by category
calls = await send(msg({ text: '/stats' }));
const typeLines = lastText(calls).body.text.split('<b>By type</b>')[1].split('<b>By category</b>')[0].match(/• (\w+):/g);
assert.equal(new Set(typeLines).size, typeLines.length, `no repeated type lines: ${typeLines}`);

// 10b. GIFs arrive with both animation and document set → treated as animation (Stickers, no AI)
n = aiCalls.length;
calls = await send(msg({ animation: { file_id: 'gif1', file_unique_id: 'gif1u', mime_type: 'video/mp4' }, document: { file_id: 'gif1', file_unique_id: 'gif1u', mime_type: 'video/mp4' } }));
assert.equal(aiCalls.length, n, 'no AI call for GIFs');
assert.match(lastText(calls).body.text, /animation_\d+\.mp4[\s\S]*😀 Stickers/);

// 10c. Album summary: a failed first send is retried by a later item instead of never appearing
let failSummary = true;
tgHook = ({ method, body }) => (method === 'sendMessage' && failSummary && /from an album/.test(body.text) ? ((failSummary = false), tgError(400, 'Bad Request: chat not found')) : null);
const pend = [];
const c2 = { waitUntil: (pr) => pend.push(pr) };
tgCalls.length = 0;
await worker.fetch(new Request('https://x/webhook/S', { method: 'POST', body: JSON.stringify(msg({ media_group_id: 'gF', photo: [{ file_id: 'f1', file_unique_id: 'f1u', width: 800, height: 800 }] })) }), env, c2);
await Promise.all(pend);
await worker.fetch(new Request('https://x/webhook/S', { method: 'POST', body: JSON.stringify(msg({ media_group_id: 'gF', photo: [{ file_id: 'f2', file_unique_id: 'f2u', width: 800, height: 800 }] })) }), env, c2);
await Promise.all(pend);
tgHook = null;
const okSummaries = tgCalls.filter((c) => c.method === 'sendMessage' && /Saved 2 files from an album/.test(c.body.text));
assert.equal(okSummaries.length, 1, 'summary delivered after the first attempt failed');

// 10d. Cancel in the category menu goes back to the file, keeping its buttons
calls = await send(cb('catmenu:2'));
const cancelBtn = lastText(calls).body.reply_markup.inline_keyboard.at(-1)[0];
assert.equal(cancelBtn.callback_data, 'card:2');
calls = await send(cb(cancelBtn.callback_data));
assert.equal(lastText(calls).method, 'editMessageText');
assert.deepEqual(lastText(calls).body.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['get:2', 'ren:2', 'catmenu:2']);

// 10e. /classify: a second run while one is in progress is refused, not doubled
db.prepare("INSERT INTO files (file_name,file_id,file_unique_id,file_size,mime_type,message_id,category) VALUES ('photo_1111.jpg','lk','lku',10,'image/jpeg',1,'')").run();
aiBehavior = async () => { await new Promise((r) => setTimeout(r, 50)); return { choices: [{ message: { content: '{"category":"photos","name":"Lock test"}' } }] }; };
tgCalls.length = 0;
await Promise.all([1, 2].map(() => worker.fetch(new Request('https://x/webhook/S', { method: 'POST', body: JSON.stringify(msg({ text: '/classify' })) }), env)));
assert.equal(tgCalls.filter((c) => /Already working on a batch/.test(c.body?.text ?? '')).length, 1);
assert.equal(tgCalls.filter((c) => /Processed \d+ files?/.test(c.body?.text ?? '')).length, 1, 'exactly one batch ran');
assert.equal(db.prepare("SELECT COUNT(*) c FROM settings WHERE key='lock:classify'").get().c, 0, 'lock released');

// 10f. Rename keeps the extension unless the new name ends with a real one
db.prepare("INSERT INTO files (file_name,file_id,file_unique_id,file_size,mime_type,message_id,category) VALUES ('scan.pdf','ex','exu',10,'application/pdf',1,'工作')").run();
const exId = db.prepare("SELECT id FROM files WHERE file_unique_id='exu'").get().id;
calls = await send(msg({ text: `/rename scan.pdf "Invoice No.12345"` }));
assert.match(lastText(calls).body.text, /→ <b>Invoice No\.12345\.pdf<\/b>/);
calls = await send(msg({ text: `/rename "Invoice No.12345.pdf" "Meeting 3.5"` }));
assert.match(lastText(calls).body.text, /→ <b>Meeting 3\.5\.pdf<\/b>/);
calls = await send(msg({ text: `/rename "Meeting 3.5.pdf" notes.docx` }));
assert.match(lastText(calls).body.text, /→ <b>notes\.docx<\/b>/, 'a real extension is respected');
calls = await send(msg({ text: `/rename notes.docx "${'x'.repeat(300)}"` }));
assert.ok(nameOf(exId).length <= 200 && nameOf(exId).endsWith('.docx'), 'long names capped, extension kept');

// 10g. Secrets with URL-special characters still work
env.BOT_SECRET = 'a b#c?d';
tgCalls.length = 0;
assert.equal((await http(`/registerWebhook?secret=${encodeURIComponent('a b#c?d')}`)).status, 200);
const hookUrl = tgCalls.find((c) => c.method === 'setWebhook').body.url;
assert.equal(hookUrl, 'https://x/webhook/a%20b%23c%3Fd');
assert.equal((await worker.fetch(new Request(hookUrl, { method: 'POST', body: '{}' }), env)).status, 200);
env.BOT_SECRET = 'S';

// 10h. Telegram errors on the admin URLs come back as JSON, not a crash
tgHook = ({ method }) => (method === 'setWebhook' ? tgError(401, 'Unauthorized') : null);
const regRes = await http('/registerWebhook?secret=S');
tgHook = null;
assert.equal(regRes.status, 502);
assert.equal((await regRes.json()).error, 'Unauthorized');

// 10i. A database missing a migration gets a clear message
const oldDb = new DatabaseSync(':memory:');
oldDb.exec(readFileSync(oldSchemaPath, 'utf8'));
oldDb.exec(readFileSync(migrationPath, 'utf8')); // 0001 only: no media_group_id, no settings
const savedDB = env.DB;
env.DB = d1(oldDb);
calls = await send(msg({ document: { file_id: 'om', file_unique_id: 'omu', file_name: 'x.pdf', mime_type: 'application/pdf' } }));
assert.match(lastText(calls).body.text, /missing a migration/);
env.DB = savedDB;

console.log('ok 10 review fixes: stats grouping, GIFs, album retry, cancel, lock, extensions, secrets, migrations');

// 8. Migration on a pre-category database
const old = new DatabaseSync(':memory:');
old.exec(readFileSync(oldSchemaPath, 'utf8'));
old.prepare("INSERT INTO files (file_name,file_id,file_unique_id,message_id) VALUES ('a','b','c',1)").run();
old.exec(readFileSync(migrationPath, 'utf8'));
assert.equal(old.prepare('SELECT category FROM files').get().category, '');
console.log('ok 8 migration adds category to old DB');

console.log('ALL PASSED');
