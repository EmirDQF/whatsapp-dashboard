import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const io = new SocketServer(server, { cors: { origin: '*' } });
const PORT = Number(process.env.PORT || 10000);
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
const GRAPH_VERSION = process.env.GRAPH_API_VERSION || 'v18.0';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'conversations.json');
const conversations = new Map();
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const useSupabase = Boolean(SUPABASE_URL && SUPABASE_KEY);

fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
if (fs.existsSync(DATA_FILE)) {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  for (const conversation of saved) conversations.set(conversation.phone, conversation);
}

async function supabaseRequest(table, options = {}) {
  if (!useSupabase) return null;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}${options.url || ''}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`Supabase ${table}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

app.use(cors({ origin: '*' }));
app.use(express.json({
  limit: '50mb',
  verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); }
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function cleanPhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

async function loadFromSupabase() {
  if (!useSupabase) return;
  const rows = await supabaseRequest('conversations', { method: 'GET', headers: { Prefer: 'return=representation' } });
  for (const row of rows || []) {
    const phone = cleanPhone(row.phone_number || row.phone);
    conversations.set(phone, {
      phone, name: row.name || null, unreadCount: row.unread_count || 0,
      status: row.status || 'active', lastMessage: row.last_message || '',
      updatedAt: row.last_message_at || null, messages: []
    });
  }
  const messages = await supabaseRequest('messages', { method: 'GET', headers: { Prefer: 'return=representation' } });
  for (const row of messages || []) {
    const phone = cleanPhone(row.phone_number);
    const conversation = conversations.get(phone) || { phone, name: null, unreadCount: 0, status: 'active', messages: [] };
    conversation.messages.push({
      id: row.id || row.wamid, wamid: row.wamid || row.id, from: phone,
      fromMe: row.direction === 'outbound', direction: row.direction, sender: row.sender,
      type: row.message_type || 'text', text: row.content || '', mediaId: row.media_id || null,
      mediaUrl: row.media_url || null,
      timestamp: Math.floor(new Date(row.timestamp || row.created_at).getTime() / 1000), status: row.status || 'received'
    });
    conversation.messages.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
    conversations.set(phone, conversation);
  }
}

function persistLocal() {
  const temporary = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify([...conversations.values()], null, 2));
  fs.renameSync(temporary, DATA_FILE);
}

async function persistMessage(phone, message, conversation) {
  if (!useSupabase) {
    persistLocal();
    return;
  }
  await supabaseRequest('conversations', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      phone_number: phone, name: conversation.name, last_message: conversation.lastMessage,
      last_message_at: new Date(Number(message.timestamp) * 1000).toISOString(),
      unread_count: conversation.unreadCount, status: conversation.status
    })
  });
  await supabaseRequest('messages', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      id: message.id, conversation_id: phone, phone_number: phone, wamid: message.wamid || message.id,
      direction: message.direction, sender: message.sender, message_type: message.type,
      content: message.text || '', media_id: message.mediaId, media_url: message.mediaUrl || null,
      timestamp: new Date(Number(message.timestamp) * 1000).toISOString(),
      status: message.status
    })
  });
}

function emitMessage(phone, message, event = 'new_message') {
  io.emit(event, { phone, conversation: phone, message });
  io.emit('conversation_updated', conversations.get(phone));
  io.emit('update_conversations', [...conversations.values()]);
}

async function saveMessage(phone, message, name) {
  const conversation = conversations.get(phone) || {
    phone, name: name || null, messages: [], unreadCount: 0, status: 'active'
  };
  if (name) conversation.name = name;
  if (conversation.messages.some(item => item.id === message.id)) return false;
  conversation.messages.push(message);
  conversation.messages.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  conversation.lastMessage = message.text || message.type;
  conversation.updatedAt = message.timestamp;
  if (message.direction === 'inbound') conversation.unreadCount += 1;
  conversations.set(phone, conversation);
  await persistMessage(phone, message, conversation);
  emitMessage(phone, message);
  if (message.direction === 'outbound') io.emit('message_sent', { phone, conversation: phone, message });
  return true;
}

function verifyMetaSignature(req) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return true;
  const signature = req.get('x-hub-signature-256') || '';
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex')}`;
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function normalizeInbound(msg) {
  const payload = msg[msg.type] || {};
  return {
    id: msg.id,
    wamid: msg.id,
    from: msg.from,
    fromMe: false,
    direction: 'inbound',
    sender: 'client',
    type: msg.type,
    text: payload.body || msg.text?.body || payload.caption || msg.button?.text || '',
    mediaId: payload.id || null,
    timestamp: Number(msg.timestamp) || Math.floor(Date.now() / 1000),
    status: 'received'
  };
}

async function handleWebhook(body) {
  for (const entry of body.entry || []) for (const change of entry.changes || []) {
    const value = change.value || {};
    for (const msg of value.messages || []) {
      const phone = cleanPhone(msg.from);
      await saveMessage(phone, normalizeInbound(msg), value.contacts?.[0]?.profile?.name);
    }
    for (const status of value.statuses || []) {
      for (const conversation of conversations.values()) {
        const message = conversation.messages.find(item => item.id === status.id || item.wamid === status.id);
        if (message) {
          message.status = status.status.toLowerCase();
          await persistMessage(conversation.phone, message, conversation);
          if (useSupabase) {
            await supabaseRequest('message_status', {
              method: 'POST',
              body: JSON.stringify({ wamid: status.id, status: message.status, timestamp: new Date(Number(status.timestamp) * 1000).toISOString() })
            });
          }
          emitMessage(conversation.phone, message, `message_${message.status}`);
        }
      }
    }
  }
}

async function sendToMeta(phone, payload) {
  if (!process.env.META_ACCESS_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error('META_ACCESS_TOKEN y WHATSAPP_PHONE_NUMBER_ID son obligatorios para enviar mensajes');
  }
  const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, ...payload })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || 'Meta rechazó el mensaje');
  return result.messages?.[0]?.id;
}

function outboundMessage(phone, id, type, text, sender = 'bot', mediaId = null, mediaUrl = null) {
  return { id, wamid: id, from: phone, from_phone: phone, fromMe: true, from_me: true,
    direction: 'outbound', sender, type, text: text || '', mediaId, media_id: mediaId,
    mediaUrl, media_url: mediaUrl, timestamp: Math.floor(Date.now() / 1000), status: 'sent' };
}

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && VERIFY_TOKEN && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  if (!verifyMetaSignature(req)) return res.sendStatus(403);
  handleWebhook(req.body).then(() => res.sendStatus(200)).catch(error => res.status(500).json({ error: error.message }));
});
app.get('/api/webhook', (req, res) => res.redirect(307, `/webhook?${new URLSearchParams(req.query)}`));
app.post('/api/webhook', (req, res) => {
  handleWebhook(req.body).then(() => res.sendStatus(200)).catch(error => res.status(500).json({ error: error.message }));
});

app.get('/api/conversations', (_req, res) => res.json([...conversations.values()]));
app.get('/api/conversations/:phone/messages', (req, res) => {
  const conversation = conversations.get(cleanPhone(req.params.phone));
  if (!conversation) return res.json([]);
  conversation.unreadCount = 0;
  if (useSupabase) {
    supabaseRequest('conversations', {
      method: 'PATCH',
      url: `?phone_number=eq.${encodeURIComponent(conversation.phone)}`,
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ unread_count: 0 })
    }).catch(error => console.error('Supabase unread update error:', error.message));
  } else {
    persistLocal();
  }
  res.json(conversation.messages);
});
app.post('/api/conversations/:phone/send', async (req, res) => {
  const phone = cleanPhone(req.params.phone);
  const { text, type = 'text', image, audio, video, document } = req.body;
  if (!phone || (!text && !image && !audio && !video && !document)) return res.status(400).json({ error: 'phone y contenido son obligatorios' });
  const payload = { type };
  if (type === 'text') payload.text = { body: text };
  else payload[type] = req.body[type] || { link: req.body.mediaUrl };
  try {
    const wamid = await sendToMeta(phone, payload);
    const message = outboundMessage(phone, wamid, type, text, 'agent');
    await saveMessage(phone, message);
    res.status(201).json(message);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});
app.post('/api/manual-reply', (req, res) => {
  req.url = `/api/conversations/${cleanPhone(req.body.phone)}/send`;
  app.handle(req, res);
});
app.post('/api/bot-reply', async (req, res) => {
  try {
    const phone = cleanPhone(req.body.phone);
    const mediaUrl = req.body.mediaUrl || req.body.media_url || null;
    const mediaId = req.body.media_id || req.body.mediaId || null;
    if (!phone || (!req.body.text && !mediaUrl && !mediaId)) {
      return res.status(400).json({ ok: false, error: 'phone y contenido son obligatorios' });
    }
    const id = req.body.wamid || req.body.message_id || `local_${crypto.randomUUID()}`;
    const type = req.body.type || (mediaUrl || mediaId ? 'image' : 'text');
    const message = outboundMessage(phone, id, type, req.body.text, 'bot', mediaId, mediaUrl);
    await saveMessage(phone, message);
    return res.status(201).json({ ok: true, success: true, message });
  } catch (error) {
    console.error('Bot reply persistence error:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo registrar la respuesta del bot' });
  }
});
app.get('/api/media/:id', async (req, res) => {
  if (!process.env.META_ACCESS_TOKEN) return res.sendStatus(503);
  const meta = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${req.params.id}`, { headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` } });
  if (!meta.ok) return res.sendStatus(meta.status);
  const { url, mime_type: mimeType } = await meta.json();
  const media = await fetch(url, { headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` } });
  res.set('Content-Type', mimeType || 'application/octet-stream');
  res.send(Buffer.from(await media.arrayBuffer()));
});
app.get('/api/health', (_req, res) => res.json({ ok: true, realtime: io.engine.clientsCount, conversations: conversations.size }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
io.on('connection', socket => {
  socket.emit('init', [...conversations.values()]);
  socket.emit('connection_status', { status: 'connected' });
});

server.listen(PORT, () => {
  loadFromSupabase()
    .then(() => console.log(`Dashboard escuchando en ${PORT} (${useSupabase ? 'Supabase' : 'archivo local'})`))
    .catch(error => {
      console.error('No se pudo cargar Supabase:', error.message);
      process.exitCode = 1;
    });
});
