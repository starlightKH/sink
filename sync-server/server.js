const http = require('http');
const https = require('https');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

const server = http.createServer();
const wss = new WebSocket.Server({ server });

const rooms = new Map();

const PUBLIC_IP_ENDPOINTS = [
  'https://api.ipify.org',
  'https://ifconfig.me/ip',
  'https://checkip.amazonaws.com',
  'https://jsgetip.appspot.com'
];
const EXTERNAL_IP_TTL = 5 * 60 * 1000;
let externalIpCache = { ip: null, fetchedAt: 0 };
let externalIpPromise = null;

function extractIpFromText(text) {
  if (!text) {
    return null;
  }
  const match = text.match(/((?:\d{1,3}\.){3}\d{1,3}|[A-Fa-f0-9:]{3,})/);
  return match ? match[0] : null;
}

function fetchExternalIp(endpoint) {
  return new Promise((resolve, reject) => {
    const handler = endpoint.startsWith('https://') ? https : http;
    const req = handler.get(endpoint, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`status ${res.statusCode}`));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve(data.trim());
      });
    });
    req.on('error', (error) => {
      reject(error);
    });
    req.setTimeout(5000, () => {
      req.destroy(new Error('timeout'));
    });
  });
}

async function resolveExternalIp(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && externalIpCache.ip && now - externalIpCache.fetchedAt < EXTERNAL_IP_TTL) {
    return externalIpCache.ip;
  }
  if (externalIpPromise && !forceRefresh) {
    return externalIpPromise;
  }
  externalIpPromise = (async () => {
    for (const endpoint of PUBLIC_IP_ENDPOINTS) {
      try {
        const text = await fetchExternalIp(endpoint);
        const ip = extractIpFromText(text);
        if (ip) {
          externalIpCache = { ip, fetchedAt: Date.now() };
          console.log(`Resolved external IP ${ip} using ${endpoint}`);
          return ip;
        }
      } catch (error) {
        console.error(`Failed to resolve external IP via ${endpoint}:`, error.message || error);
      }
    }
    return null;
  })();
  const result = await externalIpPromise;
  externalIpPromise = null;
  return result;
}

function logRoomEvent(roomId, message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [room ${roomId}] ${message}`);
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
  }
  return rooms.get(roomId);
}

function removeClient(ws) {
  const { roomId, clientId } = ws.meta || {};
  if (!roomId || !clientId) {
    return;
  }
  const room = rooms.get(roomId);
  if (!room || !room.has(clientId)) {
    return;
  }
  room.delete(clientId);
  ws.meta = { roomId: null, clientId: null };
  logRoomEvent(roomId, `${clientId} left the room`);
  if (room.size === 0) {
    rooms.delete(roomId);
  }
  broadcast(roomId, {
    type: 'left',
    clientId
  });
}

function broadcast(roomId, message, exceptId = null) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  const payload = JSON.stringify(message);
  for (const [memberId, client] of room.entries()) {
    if (exceptId && memberId === exceptId) {
      continue;
    }
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

wss.on('connection', (ws) => {
  ws.meta = { roomId: null, clientId: null };

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    if (!data.type) {
      ws.send(JSON.stringify({ type: 'error', message: 'Missing type field' }));
      return;
    }

    switch (data.type) {
      case 'join': {
        const { roomId, clientId } = data;
        if (!roomId || !clientId) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing roomId or clientId' }));
          return;
        }
        const room = getRoom(roomId);
        room.set(clientId, ws);
        ws.meta = { roomId, clientId };
        ws.send(JSON.stringify({ type: 'joined', roomId, clientId }));
        logRoomEvent(roomId, `${clientId} joined the room`);
        broadcast(roomId, { type: 'info', message: `${clientId} joined`, clientId }, clientId);
        break;
      }
      case 'leave': {
        removeClient(ws);
        ws.send(JSON.stringify({ type: 'left', clientId: data.clientId }));
        break;
      }
      case 'requestHostAddress': {
        resolveExternalIp(Boolean(data.forceRefresh))
          .then((ip) => {
            ws.send(JSON.stringify({
              type: 'hostAddress',
              publicIp: ip,
              publicUrl: ip ? `ws://${ip}:${PORT}` : null,
              error: ip ? null : 'resolve-failed'
            }));
          })
          .catch((error) => {
            console.error('Failed to resolve external IP', error);
            ws.send(JSON.stringify({
              type: 'hostAddress',
              publicIp: null,
              publicUrl: null,
              error: 'resolve-failed'
            }));
          });
        break;
      }
      case 'action': {
        const { action, roomId, clientId } = data;
        if (!roomId || !clientId || !action) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing action payload' }));
          return;
        }
        const { event, title, currentTime } = action;
        const prettyTitle = title ? `"${title}"` : 'an unknown video';
        const timeInfo = typeof currentTime === 'number' ? `${currentTime.toFixed(2)}s` : 'an unknown time';
        const actionName = event || 'action';
        logRoomEvent(roomId, `${clientId} ${actionName} ${prettyTitle} at ${timeInfo}`);
        broadcast(roomId, { type: 'action', action, clientId }, clientId);
        break;
      }
      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      }
      default:
        ws.send(JSON.stringify({ type: 'error', message: `Unknown type ${data.type}` }));
        break;
    }
  });

  ws.on('close', () => {
    removeClient(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error', error);
  });
});

server.listen(PORT, () => {
  console.log(`Laftel sync server listening on port ${PORT}`);
});

resolveExternalIp(true).catch((error) => {
  console.error('Initial external IP resolution failed', error);
});
