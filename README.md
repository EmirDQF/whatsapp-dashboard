# WhatsApp dashboard

## Render / Meta configuration

Set these Render environment variables:

- `META_ACCESS_TOKEN`: permanent/system-user token with WhatsApp permissions. Required to send messages and retrieve media.
- `WHATSAPP_PHONE_NUMBER_ID`: phone number ID used by the Cloud API.
- `META_VERIFY_TOKEN`: private string entered identically in Meta Developers webhook settings.
- `META_APP_SECRET`: Meta app secret. Enables `X-Hub-Signature-256` validation; keep it configured in production.
- `GRAPH_API_VERSION`: optional Graph version, defaults to `v18.0`.
- `DATA_FILE`: optional persistent JSON path, defaults to `data/conversations.json`. Attach a Render persistent disk and set this path on it for durable storage.
- `SUPABASE_URL`: Supabase project URL, for example `https://xxxxx.supabase.co`.
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase server-only service-role key. Never expose it in the browser.
- `PORT`: supplied by Render automatically; the server listens on it.

`WHATSAPP_BUSINESS_ACCOUNT_ID` is not required by this dashboard at runtime. `WEBHOOK_URL` is documentation/configuration only, not read by the server. When both Supabase variables exist, Supabase is used instead of the local JSON file.

Before deploying, run [supabase.sql](C:/Users/Usuario/Desktop/DASHBOARD/supabase.sql) once in Supabase SQL Editor. Use the service-role key only in Render environment variables; do not put it in the HTML or bot frontend.

Configure Meta Developers with:

`https://<your-render-service>.onrender.com/webhook`

Use the exact `META_VERIFY_TOKEN` as Verify Token and subscribe the WhatsApp `messages` field. Meta sends inbound messages and outbound delivery/read/failed statuses to this endpoint.

## Endpoints

- `GET /api/health`
- `GET /api/conversations`
- `GET /api/conversations/:phone/messages`
- `POST /api/conversations/:phone/send`
- `GET /webhook` and `POST /webhook`

The dashboard uses Socket.IO (with automatic reconnection), so it does not poll. Messages are de-duplicated by `wamid`, persisted, sorted by timestamp, and broadcast as `new_message`, `message_sent`, `message_delivered`, `message_read`, `message_failed`, and `conversation_updated`.

The bot should call `POST /api/bot-reply` after its Graph API `/messages` request, passing the returned `wamid`; this records the already-sent message without sending it twice. For media, send `type`, `media_id` or `mediaUrl`, and optional `text`. Manual dashboard messages call Graph API directly through the backend. Do not call `/api/bot-reply` before Meta confirms the send, otherwise failed sends could appear as delivered.
