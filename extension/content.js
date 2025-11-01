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
      paused: videoElement.paused
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

    switch (action.event) {
      case 'play':
        videoElement.currentTime = action.currentTime;
        videoElement.playbackRate = action.playbackRate;
        videoElement.play().catch((error) => {
          console.warn('Failed to play video', error);
        }).finally(clear);
        return;
      case 'pause':
        videoElement.currentTime = action.currentTime;
        videoElement.pause();
        break;
      case 'seeked':
        videoElement.currentTime = action.currentTime;
        break;
      case 'ratechange':
        videoElement.playbackRate = action.playbackRate;
        break;
      default:
        console.debug('Unknown remote action', action);
        break;
    }

    setTimeout(clear, 150);
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

