const form = document.getElementById('connection-form');
const serverUrlInput = document.getElementById('server-url');
const roomIdInput = document.getElementById('room-id');
const statusText = document.getElementById('status-text');
const disconnectButton = document.getElementById('disconnect-button');
const tabSelect = document.getElementById('tab-select');
const refreshTabsButton = document.getElementById('refresh-tabs');

const statusLabels = {
  disconnected: '연결되지 않음',
  connecting: '연결 중',
  connected: '연결됨',
  error: '오류 발생'
};

let selectedTabId = null;
let latestSyncTarget = null;
let isRefreshingTabs = false;

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
      chrome.storage.local.get(['connection', 'syncTarget'], (stored) => {
        resolve(stored);
      });
    } catch (error) {
      resolve({});
    }
  });
}

function updateStatus(status) {
  statusText.textContent = statusLabels[status] || status || '상태 알 수 없음';
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
    placeholder.textContent = '탭을 선택하세요';
    tabSelect.appendChild(placeholder);

    let selectionFound = false;
    for (const tab of tabs) {
      const option = document.createElement('option');
      option.value = String(tab.id);
      option.textContent = tab.title || tab.url || `탭 ${tab.id}`;
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
        missingOption.textContent = `${latestSyncTarget.title || latestSyncTarget.url || '선택된 탭'} (사용 불가)`;
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
    console.warn('탭 목록을 불러오지 못했습니다.', error);
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
    console.warn('연결 요청 실패', error);
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
        // 최신 syncTarget 정보는 background에서 전달됩니다.
      }
    } else {
      throw response;
    }
  } catch (error) {
    if (error && error.error === 'permission-denied') {
      statusText.textContent = '탭 권한 요청이 취소되었습니다';
    } else if (error && error.error === 'tab-not-found') {
      statusText.textContent = '선택한 탭을 찾을 수 없습니다';
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

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'connectionStatus') {
    updateStatus(message.status);
    if (message.syncTarget) {
      applySyncTarget(message.syncTarget);
    }
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
  if (stored?.syncTarget) {
    applySyncTarget(stored.syncTarget);
  } else {
    void refreshTabs();
  }
}
