import { WebSocketServer } from 'ws';
import { userForSession, readCookie, SESSION_COOKIE } from './auth.js';

/* One websocket room for the whole map. Two kinds of traffic:
   - durable changes (a system edited, a link deleted) broadcast after the
     database write has committed, so what arrives is always what is stored;
   - presence (cursors, who is here) which is relayed and never persisted. */

const clients = new Set();
let nextId = 1;

export function broadcast(message, exceptClient) {
  const text = JSON.stringify(message);
  for (const c of clients) {
    if (c === exceptClient) continue;
    if (c.socket.readyState === 1) {
      try { c.socket.send(text); } catch { /* dropped connection; cleaned up on close */ }
    }
  }
}

function peerList() {
  return [...clients].map((c) => ({
    peer: c.peerId,
    name: c.user.name || c.user.email,
    role: c.user.role,
    color: c.color,
    presence: c.presence,
  }));
}

function sendPeers() {
  broadcast({ type: 'peers', peers: peerList() });
}

const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#e87ba4', '#4a3aa7', '#eda100'];

export function attachRealtime(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return socket.destroy(); }
    if (url.pathname !== '/ws') return socket.destroy();

    // Same session cookie as the REST API — an unauthenticated socket never opens.
    const user = await userForSession(readCookie(req, SESSION_COOKIE)).catch(() => null);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, user));
  });

  wss.on('connection', (socket, _req, user) => {
    const client = {
      socket,
      user,
      peerId: `p${nextId++}`,
      color: COLORS[(nextId * 3) % COLORS.length],
      presence: {},
      alive: true,
    };
    clients.add(client);

    socket.send(JSON.stringify({ type: 'hello', peer: client.peerId, color: client.color }));
    sendPeers();

    socket.on('pong', () => { client.alive = true; });

    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      // Presence is the only thing a client may push. Everything durable goes
      // through the REST API so it is validated, authorised and audited.
      if (msg.type === 'presence' && msg.presence && typeof msg.presence === 'object') {
        client.presence = {
          cursor: msg.presence.cursor && {
            x: Number(msg.presence.cursor.x) || 0,
            y: Number(msg.presence.cursor.y) || 0,
          },
          selection: typeof msg.presence.selection === 'string'
            ? msg.presence.selection.slice(0, 80) : null,
        };
        sendPeers();
      }
    });

    socket.on('close', () => { clients.delete(client); sendPeers(); });
    socket.on('error', () => { clients.delete(client); });
  });

  // Drop sockets that stopped answering (Render closes idle connections).
  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { c.socket.terminate(); clients.delete(c); continue; }
      c.alive = false;
      try { c.socket.ping(); } catch { /* terminated next sweep */ }
    }
  }, 30_000);
  heartbeat.unref?.();

  return wss;
}
