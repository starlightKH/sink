const clientId = crypto.randomUUID();
let socket = null;
let connectionState = 'disconnected';
let connectionInfo = {
  serverUrl: null,
  roomId: null
};
let reconnectTimer = null;

const pendingMessages = [];
const DEFAULT_SYNC_TARGET = { tabId: null, title: null, url: null };
let syncTarget = { ...DEFAULT_SYNC_TARGET };

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

function persistState() {
  chrome.storage.local.set({
    connection: { ...connectionInfo, status: connectionState },
    syncTarget
  }).catch(() => {});
}

function broadcastSyncTarget(reason) {
  safeRuntimeMessage({ type: 'syncTarget', target: syncTarget, reason });
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

function updateStatus(status, details = {}) {
  connectionState = status;
  persistState();
  safeRuntimeMessage({ type: 'connectionStatus', status, details, syncTarget });
}

function getOriginPattern(url) {
  try {
    const { origin } = new URL(url);
    if (!origin || origin === 'null' || origin.startsWith('chrome')) {
      return null;
    }
    return `${origin}/*`;
  } catch (error) {
    console.warn('Failed to parse origin from url', url, error);
    return null;
  }
}

async function ensurePermissionsForOrigin(url, requestIfMissing = true) {
  const originPattern = getOriginPattern(url);
  if (!originPattern) {
    return false;
  }
  const hasPermission = await chrome.permissions.contains({ origins: [originPattern] });
  if (hasPermission) {
    return true;
  }
  if (!requestIfMissing) {
    return false;
  }
  try {
    return await chrome.permissions.request({ origins: [originPattern] });
  } catch (error) {
    console.warn('Permission request failed', error);
    return false;
  }
}

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    return true;
  } catch (error) {
    console.error('Failed to inject content script', error);
    return false;
  }
}

function refreshSyncTargetFromTab(tab) {
  if (!tab) {
    return;
  }
  syncTarget = {
    tabId: tab.id ?? null,
    title: tab.title || tab.url || null,
    url: tab.url || null
  };
  persistState();
  broadcastSyncTarget('updated');
}

function clearSyncTarget(reason) {
  syncTarget = { ...DEFAULT_SYNC_TARGET };
  persistState();
  broadcastSyncTarget(reason);
}

async function setSyncedTab(tabId) {
  if (tabId === null || tabId === undefined) {
    clearSyncTarget('cleared');
    return { ok: true };
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !tab.url) {
    return { ok: false, error: 'tab-not-found' };
  }

  const granted = await ensurePermissionsForOrigin(tab.url, true);
  if (!granted) {
    return { ok: false, error: 'permission-denied' };
  }

  const injected = await injectContentScript(tab.id);
  if (!injected) {
    return { ok: false, error: 'inject-failed' };
  }

  refreshSyncTargetFromTab(tab);
  return { ok: true };
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
      if (!syncTarget.tabId) {
        console.warn('Received action but no sync target is set.');
        break;
      }
      const tab = await chrome.tabs.get(syncTarget.tabId).catch(() => null);
      if (!tab) {
        clearSyncTarget('tab-missing');
        break;
      }
      try {
        await chrome.tabs.sendMessage(syncTarget.tabId, { type: 'syncAction', action: message.action });
      } catch (error) {
        console.warn('Failed to forward action to tab', error);
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
  (async () => {
    switch (message.type) {
      case 'connect':
        connect(message.serverUrl, message.roomId);
        return { ok: true };
      case 'disconnect':
        disconnect();
        return { ok: true };
      case 'getStatus':
        return {
          status: connectionState,
          connection: connectionInfo,
          syncTarget
        };
      case 'setSyncedTab':
        return setSyncedTab(message.tabId);
      case 'videoEvent':
        if (!syncTarget.tabId || !sender.tab || sender.tab.id !== syncTarget.tabId) {
          return { ok: false, error: 'tab-not-selected' };
        }
        if (connectionState === 'connected' || connectionState === 'connecting') {
          enqueueMessage({
            type: 'action',
            roomId: connectionInfo.roomId,
            clientId,
            action: message.action
          });
          flushQueue();
          return { ok: true };
        }
        return { ok: false, error: 'not-connected' };
      default:
        return { ok: false, error: 'unknown-message' };
    }
  })().then((response) => {
    if (response !== undefined) {
      sendResponse(response);
    }
  }).catch((error) => {
    console.error('Failed to handle message', error);
    sendResponse({ ok: false, error: 'internal-error' });
  });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (syncTarget.tabId && tabId === syncTarget.tabId) {
    clearSyncTarget('tab-closed');
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!syncTarget.tabId || tabId !== syncTarget.tabId) {
    return;
  }

  if (changeInfo.status === 'complete') {
    const granted = await ensurePermissionsForOrigin(tab.url || syncTarget.url, false);
    if (!granted) {
      clearSyncTarget('permission-missing');
      return;
    }
    await injectContentScript(tabId);
  }

  if (changeInfo.url || changeInfo.title) {
    const latest = await chrome.tabs.get(tabId).catch(() => null);
    if (latest) {
      refreshSyncTargetFromTab(latest);
    }
  }
});

async function bootstrap() {
  try {
    const stored = await chrome.storage.local.get(['connection', 'syncTarget']);
    if (stored.connection) {
      connectionInfo = {
        serverUrl: stored.connection.serverUrl || null,
        roomId: stored.connection.roomId || null
      };
      connectionState = stored.connection.status || 'disconnected';
    }
    if (stored.syncTarget) {
      syncTarget = {
        tabId: stored.syncTarget.tabId ?? null,
        title: stored.syncTarget.title || null,
        url: stored.syncTarget.url || null
      };
    }
    persistState();

    if (connectionInfo.serverUrl && connectionInfo.roomId) {
      connect(connectionInfo.serverUrl, connectionInfo.roomId);
    }

    if (syncTarget.tabId) {
      const tab = await chrome.tabs.get(syncTarget.tabId).catch(() => null);
      if (!tab || !tab.url) {
        clearSyncTarget('tab-missing');
      } else {
        const hasPermission = await ensurePermissionsForOrigin(tab.url, false);
        if (!hasPermission) {
          clearSyncTarget('permission-missing');
        } else {
          await injectContentScript(tab.id);
          refreshSyncTargetFromTab(tab);
        }
      }
    }
  } catch (error) {
    console.error('Failed to restore state', error);
  }
}

bootstrap();

