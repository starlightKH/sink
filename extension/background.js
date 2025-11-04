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
const HEARTBEAT_INTERVAL_MS = 20000;
const HEARTBEAT_TIMEOUT_MS = 10000;
const DEFAULT_ROLE = 'guest';
const HOST_PORT = 8080;
const HOST_ADDRESS_TTL = 5 * 60 * 1000;
let heartbeatTimer = null;
let heartbeatTimeout = null;
let userRole = DEFAULT_ROLE;
let hostAccessCache = {
  publicIp: null,
  publicUrl: null,
  fetchedAt: 0
};
let hostAddressRequest = null;

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
    syncTarget,
    userRole,
    hostAccess: hostAccessCache
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
  safeRuntimeMessage({
    type: 'connectionStatus',
    status,
    details,
    syncTarget,
    role: userRole,
    hostAccess: hostAccessCache
  });
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

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (heartbeatTimeout) {
    clearTimeout(heartbeatTimeout);
    heartbeatTimeout = null;
  }
}

function sendHeartbeat() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    socket.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    if (heartbeatTimeout) {
      clearTimeout(heartbeatTimeout);
    }
    heartbeatTimeout = setTimeout(() => {
      console.warn('Heartbeat timeout, reconnecting');
      heartbeatTimeout = null;
      try {
        socket.close(4002, 'heartbeat-timeout');
      } catch (error) {
        console.warn('Failed to close socket after heartbeat timeout', error);
      }
    }, HEARTBEAT_TIMEOUT_MS);
  } catch (error) {
    console.warn('Failed to send heartbeat', error);
  }
}

function startHeartbeat() {
  stopHeartbeat();
  sendHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}

function updateHostAccessCache(partial, reason = 'update') {
  hostAccessCache = {
    publicIp: partial.publicIp ?? hostAccessCache.publicIp,
    publicUrl: partial.publicUrl ?? hostAccessCache.publicUrl,
    fetchedAt: partial.fetchedAt ?? hostAccessCache.fetchedAt
  };
  persistState();
  safeRuntimeMessage({ type: 'hostAccessUpdate', hostAccess: hostAccessCache, reason });
}

function isHostAccessFresh(forceRefresh = false) {
  if (forceRefresh) {
    return false;
  }
  if (!hostAccessCache.publicUrl || !hostAccessCache.fetchedAt) {
    return false;
  }
  return Date.now() - hostAccessCache.fetchedAt < HOST_ADDRESS_TTL;
}

function clearHostAddressRequest(result) {
  if (!hostAddressRequest) {
    return;
  }
  clearTimeout(hostAddressRequest.timeout);
  const resolver = hostAddressRequest.resolve;
  hostAddressRequest = null;
  resolver(result);
}

function requestHostAddressFromServer(forceRefresh = false) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.resolve({ ok: false, error: 'not-connected' });
  }
  if (hostAddressRequest) {
    clearHostAddressRequest({ ok: false, error: 'superseded' });
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (hostAddressRequest && hostAddressRequest.resolve === resolve) {
        hostAddressRequest = null;
        resolve({ ok: false, error: 'timeout' });
      }
    }, 5000);
    hostAddressRequest = { resolve, timeout };
    try {
      socket.send(JSON.stringify({ type: 'requestHostAddress', forceRefresh }));
    } catch (error) {
      clearTimeout(timeout);
      hostAddressRequest = null;
      resolve({ ok: false, error: 'send-failed' });
    }
  });
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

  stopHeartbeat();

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
    stopHeartbeat();
    updateStatus('error', { message: error.message });
    return;
  }

  socket.addEventListener('open', () => {
    updateStatus('connected');
    startHeartbeat();
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
      if (data.type === 'pong') {
        if (heartbeatTimeout) {
          clearTimeout(heartbeatTimeout);
          heartbeatTimeout = null;
        }
        return;
      }
      handleServerMessage(data);
    } catch (error) {
      console.warn('Failed to parse server message', error);
    }
  });

  socket.addEventListener('close', () => {
    const shouldReconnect = connectionInfo.serverUrl && connectionInfo.roomId;
    updateStatus('disconnected');
    stopHeartbeat();
    if (hostAddressRequest) {
      clearHostAddressRequest({ ok: false, error: 'connection-closed' });
    }
    if (shouldReconnect) {
      reconnectTimer = setTimeout(() => {
        connect(connectionInfo.serverUrl, connectionInfo.roomId);
      }, 3000);
    }
  });

  socket.addEventListener('error', (event) => {
    console.error('WebSocket error', event);
    updateStatus('error', { message: 'WebSocket error' });
    stopHeartbeat();
    if (hostAddressRequest) {
      clearHostAddressRequest({ ok: false, error: 'connection-error' });
    }
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      try {
        socket.close(4001, 'error');
      } catch (error) {
        console.warn('Failed to close socket after error', error);
      }
    }
  });
}

function disconnect() {
  stopHeartbeat();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (hostAddressRequest) {
    clearHostAddressRequest({ ok: false, error: 'disconnected' });
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
    case 'hostAddress': {
      const now = Date.now();
      updateHostAccessCache({
        publicIp: message.publicIp || null,
        publicUrl: message.publicUrl || null,
        fetchedAt: now
      }, 'server');
      if (hostAddressRequest) {
        if (message.publicUrl) {
          clearHostAddressRequest({ ok: true, publicUrl: message.publicUrl, publicIp: message.publicIp || null });
        } else {
          clearHostAddressRequest({ ok: false, error: message.error || 'public-ip-failed' });
        }
      }
      break;
    }
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
          syncTarget,
          role: userRole,
          hostAccess: hostAccessCache
        };
      case 'setSyncedTab':
        return setSyncedTab(message.tabId);
      case 'setRole': {
        const { role } = message;
        if (!role || (role !== 'host' && role !== 'guest')) {
          return { ok: false, error: 'invalid-role' };
        }
        userRole = role;
        persistState();
        safeRuntimeMessage({ type: 'roleChanged', role });
        return { ok: true };
      }
      case 'getHostAddress': {
        if (userRole !== 'host') {
          return { ok: false, error: 'not-host' };
        }
        const forceRefresh = Boolean(message.forceRefresh);
        if (isHostAccessFresh(forceRefresh)) {
          return {
            ok: true,
            publicUrl: hostAccessCache.publicUrl,
            publicIp: hostAccessCache.publicIp
          };
        }
        const result = await requestHostAddressFromServer(forceRefresh);
        if (result.ok && hostAccessCache.publicUrl) {
          return {
            ok: true,
            publicUrl: hostAccessCache.publicUrl,
            publicIp: hostAccessCache.publicIp
          };
        }
        return { ok: false, error: result.error || 'public-ip-failed' };
      }
      case 'videoEvent':
        if (!syncTarget.tabId || !sender.tab || sender.tab.id !== syncTarget.tabId) {
          return { ok: false, error: 'tab-not-selected' };
        }
        if (connectionState === 'connected' || connectionState === 'connecting') {
          const outgoingAction = {
            ...message.action,
            sentAt: Date.now()
          };
          enqueueMessage({
            type: 'action',
            roomId: connectionInfo.roomId,
            clientId,
            action: outgoingAction
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
    const stored = await chrome.storage.local.get(['connection', 'syncTarget', 'userRole', 'hostAccess']);
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
    if (stored.userRole) {
      userRole = stored.userRole;
    }
    if (stored.hostAccess) {
      hostAccessCache = {
        publicIp: stored.hostAccess.publicIp || null,
        publicUrl: stored.hostAccess.publicUrl || null,
        fetchedAt: stored.hostAccess.fetchedAt || 0
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

