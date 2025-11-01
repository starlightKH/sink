const clientId = crypto.randomUUID();
let socket = null;
let connectionState = 'disconnected';
let connectionInfo = {
  serverUrl: null,
  roomId: null
};
let reconnectTimer = null;

const pendingMessages = [];

function safeRuntimeMessage(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      if (chrome.runtime.lastError) {
        // no-op: receiver might not exist
      }
    });
  } catch (error) {
    // ignore
  }
}

function updateStatus(status, details = {}) {
  connectionState = status;
  chrome.storage.local.set({ connection: { ...connectionInfo, status } }).catch(() => {});
  safeRuntimeMessage({ type: 'connectionStatus', status, details });
}

function enqueueMessage(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  } else {
    pendingMessages.push(message);
  }
}

function flushQueue() {
  while (pendingMessages.length > 0 && socket && socket.readyState === WebSocket.OPEN) {
    const message = pendingMessages.shift();
    socket.send(JSON.stringify(message));
  }
}

function connect(serverUrl, roomId) {
  if (!serverUrl || !roomId) {
    updateStatus('disconnected', { reason: 'missing-fields' });
    return;
  }

  if (socket) {
    socket.close();
    socket = null;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  connectionInfo = { serverUrl, roomId };
  updateStatus('connecting');

  try {
    socket = new WebSocket(serverUrl);
  } catch (error) {
    updateStatus('error', { message: error.message });
    return;
  }

  socket.addEventListener('open', () => {
    updateStatus('connected');
    enqueueMessage({
      type: 'join',
      roomId,
      clientId
    });
    flushQueue();
  });

  socket.addEventListener('message', async (event) => {
    try {
      const data = JSON.parse(event.data);
      handleServerMessage(data);
    } catch (error) {
      console.warn('Failed to parse server message', error);
    }
  });

  socket.addEventListener('close', () => {
    const shouldReconnect = connectionInfo.serverUrl && connectionInfo.roomId;
    updateStatus('disconnected');
    if (shouldReconnect) {
      reconnectTimer = setTimeout(() => {
        connect(connectionInfo.serverUrl, connectionInfo.roomId);
      }, 3000);
    }
  });

  socket.addEventListener('error', (event) => {
    console.error('WebSocket error', event);
    updateStatus('error', { message: 'WebSocket error' });
  });
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    try {
      socket.send(JSON.stringify({ type: 'leave', roomId: connectionInfo.roomId, clientId }));
    } catch (error) {
      // ignore
    }
    socket.close();
    socket = null;
  }
  connectionInfo = { serverUrl: null, roomId: null };
  updateStatus('disconnected');
}

async function handleServerMessage(message) {
  if (!message || message.clientId === clientId) {
    return;
  }

  switch (message.type) {
    case 'action': {
      const tabs = await chrome.tabs.query({ url: ['https://laftel.net/*', 'https://*.laftel.net/*'] });
      for (const tab of tabs) {
        try {
          chrome.tabs.sendMessage(tab.id, { type: 'syncAction', action: message.action }, () => {
            void chrome.runtime.lastError;
          });
        } catch (error) {
          // ignore per-tab errors
        }
      }
      break;
    }
    case 'joined':
    case 'left':
    case 'info':
      updateStatus(connectionState, { notice: message });
      break;
    case 'error':
      updateStatus('error', { message: message.message });
      break;
    default:
      console.debug('Unhandled server message', message);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'connect':
      connect(message.serverUrl, message.roomId);
      sendResponse({ ok: true });
      break;
    case 'disconnect':
      disconnect();
      sendResponse({ ok: true });
      break;
    case 'getStatus':
      sendResponse({
        status: connectionState,
        connection: connectionInfo
      });
      break;
    case 'videoEvent':
      if (connectionState === 'connected' || connectionState === 'connecting') {
        enqueueMessage({
          type: 'action',
          roomId: connectionInfo.roomId,
          clientId,
          action: message.action
        });
        flushQueue();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'not-connected' });
      }
      break;
    default:
      sendResponse({ ok: false, error: 'unknown-message' });
  }
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('connection').then((stored) => {
    if (stored && stored.connection && stored.connection.serverUrl && stored.connection.roomId) {
      const { serverUrl, roomId } = stored.connection;
      connect(serverUrl, roomId);
    }
  }).catch(() => {});
});

