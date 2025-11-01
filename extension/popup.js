const form = document.getElementById('connection-form');
const serverUrlInput = document.getElementById('server-url');
const roomIdInput = document.getElementById('room-id');
const statusText = document.getElementById('status-text');
const disconnectButton = document.getElementById('disconnect-button');
const connectButton = document.getElementById('connect-button');
const tabSelect = document.getElementById('tab-select');
const refreshTabsButton = document.getElementById('refresh-tabs');
const roleInputs = Array.from(document.querySelectorAll('input[name="user-role"]'));
const hostToolsSection = document.getElementById('host-tools');
const hostAddressText = document.getElementById('host-address');
const hostStatusText = document.getElementById('host-status');
const hostRefreshButton = document.getElementById('host-refresh');
const hostCopyButton = document.getElementById('host-copy');

const statusLabels = {
  disconnected: 'Not connected',
  connecting: 'Connecting',
  connected: 'Connected',
  error: 'Error'
};

const HOST_PORT = 8080;
const DEFAULT_HOST_SERVER_URL = `ws://localhost:${HOST_PORT}`;

let selectedTabId = null;
let latestSyncTarget = null;
let isRefreshingTabs = false;
let currentRole = 'guest';
let hostAddress = null;
let currentConnectionStatus = 'disconnected';

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(error);
        } else {
          resolve(response);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

function getStoredState() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(['connection', 'syncTarget', 'userRole', 'hostAccess'], (stored) => {
        resolve(stored);
      });
    } catch (error) {
      resolve({});
    }
  });
}

function updateStatus(status) {
  currentConnectionStatus = status || 'disconnected';
  statusText.textContent = statusLabels[status] || status || 'Status unknown';
  if (connectButton) {
    connectButton.disabled = currentConnectionStatus === 'connected' || currentConnectionStatus === 'connecting';
  }
}

function applySyncTarget(target) {
  if (target && typeof target.tabId === 'number') {
    latestSyncTarget = target;
    selectedTabId = target.tabId;
  } else {
    latestSyncTarget = null;
    selectedTabId = null;
  }
  void refreshTabs();
}

function applyHostAccess(access) {
  if (!access || !access.publicUrl) {
    hostAddress = null;
    if (hostAddressText) {
      hostAddressText.textContent = 'Resolve the external address to share with guests.';
    }
    if (hostStatusText && currentRole === 'host') {
      hostStatusText.textContent = 'Click refresh to fetch the latest address.';
    }
    return;
  }
  hostAddress = access.publicUrl;
  if (hostAddressText) {
    hostAddressText.textContent = hostAddress;
  }
  if (hostStatusText) {
    hostStatusText.textContent = 'Share this address (IP:8080) with guests.';
  }
}

function updateRoleUI(role) {
  currentRole = role;
  roleInputs.forEach((input) => {
    input.checked = input.value === role;
  });
  const isHost = role === 'host';
  serverUrlInput.disabled = isHost;
  if (isHost) {
    if (!serverUrlInput.value) {
      serverUrlInput.value = DEFAULT_HOST_SERVER_URL;
    }
    hostToolsSection.hidden = false;
    if (hostStatusText) {
      hostStatusText.textContent = hostAddress
        ? 'Share this address (IP:8080) with guests.'
        : currentConnectionStatus === 'connected'
          ? 'Click refresh to fetch the latest address.'
          : 'Connect to the server before refreshing.';
    }
    if (!hostAddress) {
      void refreshHostAddress(false);
    }
  } else {
    serverUrlInput.disabled = false;
    if (serverUrlInput.value === DEFAULT_HOST_SERVER_URL) {
      serverUrlInput.value = '';
    }
    hostToolsSection.hidden = true;
    hostAddress = null;
    if (hostAddressText) {
      hostAddressText.textContent = 'Resolve the external address to share with guests.';
    }
    if (hostStatusText) {
      hostStatusText.textContent = '';
    }
  }
}

async function refreshHostAddress(forceRefresh = false) {
  if (currentRole !== 'host') {
    return;
  }
  if (currentConnectionStatus !== 'connected') {
    if (!hostAddress && hostAddressText) {
      hostAddressText.textContent = 'Resolve the external address to share with guests.';
    }
    if (hostStatusText) {
      hostStatusText.textContent = 'Connect to the server before refreshing.';
    }
    return;
  }
  if (hostAddressText) {
    hostAddressText.textContent = 'Resolving external address...';
  }
  if (hostStatusText) {
    hostStatusText.textContent = 'Resolving external address...';
  }
  try {
    const response = await sendMessage({
      type: 'getHostAddress',
      forceRefresh
    });
    if (response?.ok) {
      const resolvedUrl = response.publicUrl || hostAddress;
      hostAddress = resolvedUrl || hostAddress;
      if (resolvedUrl && hostAddressText) {
        hostAddressText.textContent = resolvedUrl;
      }
      if (hostStatusText) {
        hostStatusText.textContent = 'Share this address (IP:8080) with guests.';
      }
    } else {
      hostAddress = null;
      if (hostAddressText) {
        hostAddressText.textContent = 'Unable to resolve external address.';
      }
      if (hostStatusText) {
        const error = response?.error;
        if (error === 'not-connected') {
          hostStatusText.textContent = 'Connect to the server before refreshing.';
        } else if (error === 'timeout') {
          hostStatusText.textContent = 'Timed out while resolving the address. Try again.';
        } else if (error === 'send-failed') {
          hostStatusText.textContent = 'Unable to send request to the server.';
        } else if (error === 'superseded') {
          hostStatusText.textContent = 'Previous request cancelled.';
        } else {
          hostStatusText.textContent = 'Check your network connection or firewall and try again.';
        }
      }
    }
  } catch (error) {
    console.warn('Failed to resolve host address', error);
    hostAddress = null;
    if (hostAddressText) {
      hostAddressText.textContent = 'Unable to resolve external address.';
    }
    if (hostStatusText) {
      hostStatusText.textContent = 'An error occurred while resolving the address.';
    }
  }
}

async function refreshTabs() {
  if (!tabSelect || isRefreshingTabs) {
    return;
  }
  isRefreshingTabs = true;
  try {
    const tabs = await chrome.tabs.query({
      windowId: chrome.windows.WINDOW_ID_CURRENT,
      url: ['http://*/*', 'https://*/*']
    });

    tabSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select a tab';
    tabSelect.appendChild(placeholder);

    let selectionFound = false;
    for (const tab of tabs) {
      const option = document.createElement('option');
      option.value = String(tab.id);
      option.textContent = tab.title || tab.url || `Tab ${tab.id}`;
      option.dataset.url = tab.url || '';
      if (selectedTabId !== null && tab.id === selectedTabId) {
        option.selected = true;
        selectionFound = true;
      }
      tabSelect.appendChild(option);
    }

    if (!selectionFound && selectedTabId !== null) {
      if (latestSyncTarget) {
        const missingOption = document.createElement('option');
        missingOption.value = String(latestSyncTarget.tabId);
        missingOption.textContent = `${latestSyncTarget.title || latestSyncTarget.url || 'Selected tab'} (unavailable)`;
        missingOption.disabled = true;
        tabSelect.appendChild(missingOption);
      }
      tabSelect.value = '';
      selectedTabId = null;
    } else if (selectedTabId === null) {
      tabSelect.value = '';
    }

    tabSelect.title =
      tabSelect.selectedOptions.length && tabSelect.selectedOptions[0].dataset.url
        ? tabSelect.selectedOptions[0].dataset.url
        : '';
  } catch (error) {
    console.warn('Unable to load tab list', error);
  } finally {
    isRefreshingTabs = false;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const serverUrl = serverUrlInput.value.trim();
  const roomId = roomIdInput.value.trim();
  if (!serverUrl || !roomId) {
    updateStatus('error');
    return;
  }
  updateStatus('connecting');
  try {
    await sendMessage({ type: 'connect', serverUrl, roomId });
  } catch (error) {
    console.warn('Failed to submit connect request', error);
    updateStatus('error');
  }
});

disconnectButton.addEventListener('click', async () => {
  try {
    await sendMessage({ type: 'disconnect' });
  } finally {
    updateStatus('disconnected');
  }
});

tabSelect.addEventListener('change', async () => {
  const value = tabSelect.value;
  const previousSelection = selectedTabId;
  const tabId = value ? Number(value) : null;

  try {
    const response = await sendMessage({ type: 'setSyncedTab', tabId });
    if (response?.ok) {
      if (tabId === null) {
        applySyncTarget(null);
      } else {
        selectedTabId = tabId;
      }
    } else {
      throw response;
    }
  } catch (error) {
    if (error && error.error === 'permission-denied') {
      statusText.textContent = 'Tab permission request was denied';
    } else if (error && error.error === 'tab-not-found') {
      statusText.textContent = 'The selected tab could not be found';
    } else {
      updateStatus('error');
    }
    selectedTabId = previousSelection;
    await refreshTabs();
  }
});

refreshTabsButton.addEventListener('click', () => {
  void refreshTabs();
});

roleInputs.forEach((input) => {
  input.addEventListener('change', () => {
    if (input.checked) {
      void setRole(input.value);
    }
  });
});

async function setRole(role) {
  if (currentRole === role) {
    return;
  }
  updateRoleUI(role);
  try {
    await sendMessage({ type: 'setRole', role });
  } catch (error) {
    console.warn('Failed to update role', error);
  }
}

if (hostRefreshButton) {
  hostRefreshButton.addEventListener('click', () => {
    void refreshHostAddress(true);
  });
}

if (hostCopyButton) {
  hostCopyButton.addEventListener('click', async () => {
    if (currentRole !== 'host') {
      return;
    }
    if (!hostAddress) {
      if (currentConnectionStatus === 'connected') {
        await refreshHostAddress(true);
      }
      if (!hostAddress) {
        if (hostStatusText) {
          hostStatusText.textContent = 'Resolve the address before copying.';
        }
        return;
      }
    }
    try {
      await navigator.clipboard.writeText(hostAddress);
      if (hostStatusText) {
        hostStatusText.textContent = 'Address copied to the clipboard.';
      }
    } catch (error) {
      console.warn('Failed to copy host address', error);
      if (hostStatusText) {
        hostStatusText.textContent = 'Unable to copy to the clipboard.';
      }
    }
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'connectionStatus') {
    updateStatus(message.status);
    if (message.hostAccess) {
      applyHostAccess(message.hostAccess);
    }
    if (message.role) {
      updateRoleUI(message.role);
    }
    if (message.syncTarget) {
      applySyncTarget(message.syncTarget);
    }
  } else if (message.type === 'roleChanged') {
    updateRoleUI(message.role);
  } else if (message.type === 'hostAccessUpdate') {
    applyHostAccess(message.hostAccess);
  } else if (message.type === 'syncTarget') {
    applySyncTarget(message.target);
  }
});

sendMessage({ type: 'getStatus' })
  .then((response) => {
    if (response) {
      updateStatus(response.status || 'disconnected');
      if (response.connection) {
        if (response.connection.serverUrl) {
          serverUrlInput.value = response.connection.serverUrl;
        }
        if (response.connection.roomId) {
          roomIdInput.value = response.connection.roomId;
        }
      }
      if (response.syncTarget) {
        applySyncTarget(response.syncTarget);
      }
      if (response.hostAccess) {
        applyHostAccess(response.hostAccess);
      }
      if (response.role) {
        updateRoleUI(response.role);
      }
    }
  })
  .catch(() => {
    updateStatus('error');
  });

loadInitialSettings();

async function loadInitialSettings() {
  const stored = await getStoredState();
  if (stored?.connection) {
    const { serverUrl, roomId, status } = stored.connection;
    if (serverUrl) {
      serverUrlInput.value = serverUrl;
    }
    if (roomId) {
      roomIdInput.value = roomId;
    }
    if (status) {
      updateStatus(status);
    }
  }
  if (stored?.hostAccess) {
    applyHostAccess(stored.hostAccess);
  }
  if (stored?.userRole) {
    updateRoleUI(stored.userRole);
  }
  if (stored?.syncTarget) {
    applySyncTarget(stored.syncTarget);
  } else {
    void refreshTabs();
  }
  if (currentRole === 'host' && !hostAddress) {
    void refreshHostAddress(false);
  }
}
