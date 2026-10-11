/**
 * zhyldamGO — чат клиент ⇄ Telegram на Netlify (одна функция, маршруты /api/*).
 *   POST /api/messages  клиент -> Telegram
 *   GET  /api/sync      приложение забирает ответы персонала
 *   POST /api/telegram  webhook Telegram (ответы персонала)
 *   GET  /api/setup     одноразовая регистрация webhook (нужен ?key=WEBHOOK_SECRET)
 *   GET  /api/health
 * Данные хранятся в Netlify Blobs (store «zgo»).
 */
import { getStore } from '@netlify/blobs';

const TG_API = process.env.TG_API || 'https://api.telegram.org';
const TTL = 30 * 24 * 3600 * 1000;

function cfg() {
  const e = process.env;
  return {
    token: e.BOT_TOKEN || '',
    support: String(e.SUPPORT_CHAT_ID || ''),
    courier: String(e.COURIER_CHAT_ID || e.SUPPORT_CHAT_ID || ''),
    staff: (e.STAFF_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
    secret: e.WEBHOOK_SECRET || '',
  };
}
const staffChatFor = (c, chat) => (chat === 'help' ? c.support : c.courier);

const json = (obj, code = 200) =>
  new Response(JSON.stringify(obj), {
    status: code,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
const he = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[x]));
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

async function tg(c, method, body) {
  const r = await fetch(`${TG_API}/bot${c.token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`${method}: ${j.description || r.status}`);
  return j.result;
}

// ---------- простой лимит запросов (в пределах одного «тёплого» экземпляра) ----------
const buckets = new Map();
function limited(key, max, perMs) {
  const now = Date.now();
  const b = buckets.get(key) || { n: 0, t: now };
  if (now - b.t > perMs) { b.n = 0; b.t = now; }
  b.n++;
  buckets.set(key, b);
  if (buckets.size > 5000) buckets.clear();
  return b.n > max;
}

// ---------- обращения (tickets) ----------
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
function randCode() {
  const a = new Uint8Array(5);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => ALPHA[b % ALPHA.length]).join('');
}
async function ticketFor(s, uid, chat) {
  const k = `tk/${uid}/${chat}`;
  const have = await s.get(k);
  if (have) return have;
  for (let i = 0; i < 5; i++) {
    const code = randCode();
    if (!(await s.get('tc/' + code))) {
      await s.setJSON('tc/' + code, { uid, chat });
      await s.set(k, code);
      return code;
    }
  }
  throw new Error('ticket code');
}

async function forwardToStaff(c, s, code, chat, p) {
  const o = p.order;
  const head = chat === 'help'
    ? `💬 <b>Поддержка</b> · #${code}`
    : `📦 <b>Заказ №${he(o ? o.id : chat.slice(1))}</b> · #${code}` +
      (o ? `\n${he(o.service)} — ${he(o.what)}${o.total ? ' · ' + he(o.total) + ' ₸' : ''}` : '');
  const who = [p.name && '👤 ' + he(p.name), p.city && '🏙 ' + he(p.city), p.lang === 'kk' ? '🌐 KK' : '🌐 RU']
    .filter(Boolean).join(' · ');
  const text = `${head}\n${who}\n\n${he(p.text)}\n\n<i>↩️ Ответьте (Reply) на это сообщение</i>`;
  const chatId = staffChatFor(c, chat);
  const sent = await tg(c, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
  await s.set(`tg/${chatId}:${sent.message_id}`, code);
}

// ---------- клиент -> Telegram ----------
const UID_RE = /^[A-Za-z0-9-]{16,64}$/;
const CHAT_RE = /^(help|o\d{1,9})$/;
const CM_RE = /^[A-Za-z0-9-]{8,64}$/;

async function postMessage(req, c, s, ip) {
  if (limited('p:' + ip, 40, 60000)) return json({ error: 'rate' }, 429);
  const raw = await req.text();
  if (raw.length > 16384) return json({ error: 'too large' }, 413);
  let b;
  try { b = JSON.parse(raw || '{}'); } catch (e) { return json({ error: 'bad json' }, 400); }
  const text = clip(b.text, 1000).trim();
  if (!UID_RE.test(b.uid || '') || !CHAT_RE.test(b.chat || '') || !CM_RE.test(b.cm || '') || !text) {
    return json({ error: 'bad request' }, 400);
  }
  if (limited('u:' + b.uid, 20, 60000)) return json({ error: 'rate' }, 429);
  if (!c.token || !staffChatFor(c, b.chat)) return json({ error: 'bot not configured' }, 503);

  const seenKey = `seen/${b.uid}/${b.cm}`;
  if (await s.get(seenKey)) return json({ ok: true, dup: true });

  const o = b.order && typeof b.order === 'object' ? b.order : null;
  const p = {
    text,
    name: clip(b.name, 60),
    city: clip(b.city, 40),
    lang: b.lang === 'kk' ? 'kk' : 'ru',
    order: o ? { id: clip(o.id, 9), service: clip(o.service, 60), what: clip(o.what, 200), total: clip(o.total, 12) } : null,
  };
  try {
    const code = await ticketFor(s, b.uid, b.chat);
    await forwardToStaff(c, s, code, b.chat, p);
  } catch (e) {
    console.error('forward error:', e.message);
    return json({ error: 'telegram' }, 502);
  }
  await s.set(seenKey, '1');
  return json({ ok: true });
}

// ---------- приложение забирает ответы ----------
async function getSync(url, s) {
  const uid = url.searchParams.get('uid') || '';
  if (!UID_RE.test(uid)) return json({ error: 'bad uid' }, 400);
  if (limited('s:' + uid, 60, 60000)) return json({ error: 'rate' }, 429);
  const after = Math.max(0, parseInt(url.searchParams.get('after'), 10) || 0);
  const box = await s.get('in/' + uid, { type: 'json' });
  if (!box) return json({ messages: [], seq: 0 });
  return json({ messages: box.msgs.filter((m) => m.id > after).slice(0, 100), seq: box.n });
}

async function pushInbox(s, uid, chat, text) {
  const k = 'in/' + uid;
  const box = (await s.get(k, { type: 'json' })) || { n: 0, msgs: [] };
  box.n++;
  box.msgs.push({ id: box.n, chat, text: clip(text, 2000), ts: Date.now() });
  const lim = Date.now() - TTL;
  box.msgs = box.msgs.filter((m) => m.ts >= lim).slice(-200);
  await s.setJSON(k, box);
}

// ---------- Telegram -> клиент (webhook) ----------
async function handleUpdate(c, s, u) {
  const m = u.message;
  if (!m) return;
  const chatId = String(m.chat.id);
  const text = (m.text || m.caption || '').trim();
  const reply = (t) => tg(c, 'sendMessage', { chat_id: chatId, text: t, reply_to_message_id: m.message_id }).catch(() => {});

  if (/^\/(start|id)(@\w+)?\b/i.test(text)) {
    return reply(`chat id этого чата: ${chatId}\nВпишите его в настройки Netlify как SUPPORT_CHAT_ID или COURIER_CHAT_ID.`);
  }
  if (!chatId || (chatId !== c.support && chatId !== c.courier)) return;
  if (c.staff.length && !c.staff.includes(String(m.from && m.from.id))) return;

  let code = null;
  let body = text;
  if (m.reply_to_message) code = await s.get(`tg/${chatId}:${m.reply_to_message.message_id}`);
  if (!code) {
    const x = text.match(/^\/r(?:eply)?(?:@\w+)?\s+#?([a-z0-9]{4,8})\s+([\s\S]+)/i);
    if (x) { code = x[1].toLowerCase(); body = x[2].trim(); }
  }
  if (!code) {
    if (m.chat.type === 'private') await reply('Чтобы ответить клиенту, нажмите Reply на его сообщение или напишите: /r КОД текст (например /r k7f2x Уже еду).');
    return;
  }
  const t = await s.get('tc/' + code, { type: 'json' });
  if (!t) return reply(`Обращение #${code} не найдено.`);
  if (staffChatFor(c, t.chat) !== chatId) return reply('Это обращение обслуживается в другом чате.');
  if (!body) return reply('Пока поддерживается только текст.');

  await pushInbox(s, t.uid, t.chat, body);
  await tg(c, 'setMessageReaction', { chat_id: chatId, message_id: m.message_id, reaction: [{ type: 'emoji', emoji: '👍' }] }).catch(() => {});
}

async function webhook(req, c, s) {
  if (!c.secret || req.headers.get('x-telegram-bot-api-secret-token') !== c.secret) return json({ error: 'forbidden' }, 403);
  let u;
  try { u = await req.json(); } catch (e) { return json({ ok: true }); }
  try { await handleUpdate(c, s, u); } catch (e) { console.error('update error:', e.message); }
  return json({ ok: true }); // всегда 200, чтобы Telegram не повторял доставку
}

// ---------- регистрация webhook (один раз) ----------
async function setup(url, c) {
  if (!c.secret || url.searchParams.get('key') !== c.secret) return json({ error: 'forbidden' }, 403);
  if (!c.token) return json({ error: 'BOT_TOKEN не задан' }, 503);
  const hook = url.origin + '/api/telegram';
  try {
    await tg(c, 'setWebhook', { url: hook, secret_token: c.secret, allowed_updates: ['message'], drop_pending_updates: true });
    const info = await tg(c, 'getWebhookInfo');
    return json({
      ok: true, webhook: hook, pending: info.pending_update_count, last_error: info.last_error_message || null,
      support_chat_id_set: !!c.support, courier_chat_id_set: !!(process.env.COURIER_CHAT_ID || c.support),
    });
  } catch (e) {
    return json({ ok: false, error: e.message }, 502);
  }
}

export default async (req, context) => {
  try {
    const url = new URL(req.url);
    const route = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
    const c = cfg();
    const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || 'x';
    const s = getStore({ name: 'zgo', consistency: 'strong' });
    if (route === 'messages' && req.method === 'POST') return await postMessage(req, c, s, ip);
    if (route === 'sync' && req.method === 'GET') return await getSync(url, s);
    if (route === 'telegram' && req.method === 'POST') return await webhook(req, c, s);
    if (route === 'setup' && req.method === 'GET') return await setup(url, c);
    if (route === 'health') return json({ ok: true, bot: !!c.token, webhook_secret: !!c.secret, support_chat: !!c.support });
    return json({ error: 'not found' }, 404);
  } catch (e) {
    console.error('api error:', e && e.message);
    return json({ error: 'server' }, 500);
  }
};

export const config = { path: '/api/*' };
