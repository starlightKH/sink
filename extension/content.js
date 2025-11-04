(function () {
  if (window.__syncVideoControllerInjected) {
    return;
  }
  window.__syncVideoControllerInjected = true;

  let videoElement = null;
  let suppressEvents = false;

  function getVideoTitle() {
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle && ogTitle.content) {
      return ogTitle.content.trim();
    }

    const heading = document.querySelector('h1');
    if (heading && heading.textContent) {
      return heading.textContent.trim();
    }

    return document.title || '';
  }

  function findVideoElement() {
    if (videoElement && !videoElement.isConnected) {
      videoElement = null;
    }

    if (!videoElement) {
      videoElement = document.querySelector('video');
      if (videoElement) {
        attachListeners();
      }
    }

    if (!videoElement) {
      setTimeout(findVideoElement, 1000);
    }
  }

  function attachListeners() {
    const events = ['play', 'pause', 'seeked', 'ratechange'];
    events.forEach((eventName) => {
      videoElement.addEventListener(eventName, () => handleEvent(eventName));
    });
  }

  function handleEvent(eventName) {
    if (!videoElement || suppressEvents) {
      return;
    }

    const action = {
      event: eventName,
      currentTime: videoElement.currentTime,
      playbackRate: videoElement.playbackRate,
      paused: videoElement.paused,
      generatedAt: Date.now()
    };

    const title = getVideoTitle();
    if (title) {
      action.title = title;
    }

    try {
      chrome.runtime.sendMessage({ type: 'videoEvent', action }, () => {
        if (chrome.runtime.lastError) {
          // Background may not be ready; ignore.
        }
      });
    } catch (error) {
      // Ignore send errors.
    }

    if (eventName === 'seeked' && videoElement && !videoElement.paused) {
      suppressEvents = true;
      videoElement.pause();
      setTimeout(() => {
        suppressEvents = false;
      }, 150);
    }
  }

  function applyAction(action) {
    if (!videoElement) {
      findVideoElement();
      return;
    }

    suppressEvents = true;
    const clear = () => {
      suppressEvents = false;
    };

    const now = Date.now();
    const sentAt = typeof action.sentAt === 'number' ? action.sentAt : (typeof action.generatedAt === 'number' ? action.generatedAt : null);
    const latencySeconds = sentAt ? Math.max(0, now - sentAt) / 1000 : 0;
    const effectivePlaybackRate = typeof action.playbackRate === 'number' && !Number.isNaN(action.playbackRate)
      ? action.playbackRate
      : (videoElement.playbackRate || 1);
    const baseTime = typeof action.currentTime === 'number' ? action.currentTime : videoElement.currentTime;
    let targetTime = baseTime;

    switch (action.event) {
      case 'play':
        if (latencySeconds > 0) {
          targetTime += latencySeconds * effectivePlaybackRate;
        }
        videoElement.currentTime = targetTime;
        videoElement.playbackRate = effectivePlaybackRate;
        videoElement.play().catch((error) => {
          console.warn('Failed to play video', error);
        }).finally(clear);
        return;
      case 'pause':
        if (latencySeconds > 0) {
          targetTime += latencySeconds * effectivePlaybackRate;
        }
        videoElement.currentTime = targetTime;
        videoElement.pause();
        break;
      case 'seeked':
        videoElement.currentTime = baseTime;
        videoElement.pause();
        break;
      case 'ratechange':
        videoElement.playbackRate = effectivePlaybackRate;
        break;
      default:
        console.debug('Unknown remote action', action);
        break;
    }

    setTimeout(clear, 200);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'syncAction' && message.action) {
      applyAction(message.action);
    }
  });

  const observer = new MutationObserver(() => {
    if (!document.contains(videoElement)) {
      findVideoElement();
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  findVideoElement();
})();

