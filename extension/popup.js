const form = document.getElementById('connection-form');
const serverUrlInput = document.getElementById('server-url');
const roomIdInput = document.getElementById('room-id');
const statusText = document.getElementById('status-text');
const disconnectButton = document.getElementById('disconnect-button');

const statusLabels = {
  disconnected: '연결되지 않음',
  connecting: '연결 중…',
  connected: '연결됨',
  error: '오류 발생'
};

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

function getStoredConnection() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get('connection', (stored) => {
        resolve(stored);
      });
    } catch (error) {
      resolve({});
    }
  });
}

async function loadSettings() {
  const stored = await getStoredConnection();
  if (stored && stored.connection) {
    const { serverUrl, roomId, status } = stored.connection;
    if (serverUrl) {
      serverUrlInput.value = serverUrl;
    }
    if (roomId) {
      roomIdInput.value = roomId;
    }
    updateStatus(status || 'disconnected');
  }
}

function updateStatus(status) {
  statusText.textContent = statusLabels[status] || status || '알 수 없음';
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

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'connectionStatus') {
    updateStatus(message.status);
  }
});

sendMessage({ type: 'getStatus' }).then((response) => {
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
  }
}).catch(() => {
  updateStatus('error');
});

loadSettings();

