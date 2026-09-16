(() => {
  'use strict';

  const PLAY_OVERLAY_SELECTOR =
    'div[aria-label="Play"].x1yomw13.x1dhbnvk.x4iexvp.xfem2s5.xv2xd2s.xg79w0';
  const REWIND_SECONDS = 3;
  const FRAME_CAPTURE_INTERVAL_MS = 1500;
  const videoFrameStates = new WeakMap();
  let lastCapturedFrame = null;
  let spedUpVideo = null;

  function isEditable(element) {
    return element instanceof Element && Boolean(
      element.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')
    );
  }

  function visibleArea(video) {
    const rect = video.getBoundingClientRect();
    const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
    return width * height;
  }

  function findActiveVideo() {
    const videos = [...document.querySelectorAll('video')]
      .filter((video) => !video.ended)
      .map((video) => ({ area: visibleArea(video), video }))
      .filter(({ area }) => area > 0);

    if (!videos.length) {
      return null;
    }

    return videos.reduce((best, candidate) =>
      candidate.area > best.area ? candidate : best
    ).video;
  }

  function findCurrentPost() {
    const posts = [...document.querySelectorAll('article')]
      .filter((post) => visibleArea(post) > 0);

    if (!posts.length) {
      return null;
    }

    return posts.reduce((best, post) =>
      visibleArea(post) > visibleArea(best) ? post : best
    );
  }

  function findNextPost() {
    const currentPost = findCurrentPost();
    const currentRect = currentPost?.getBoundingClientRect();
    const currentCenter = currentRect
      ? currentRect.top + currentRect.height / 2
      : innerHeight / 2;

    return [...document.querySelectorAll('article')]
      .filter((post) => post !== currentPost)
      .map((post) => {
        const rect = post.getBoundingClientRect();
        return {
          post,
          center: rect.top + rect.height / 2,
          hasSize: rect.width > 0 && rect.height > 0
        };
      })
      .filter(({ center, hasSize }) => hasSize && center > currentCenter + 1)
      .sort((first, second) => first.center - second.center)[0]?.post ?? null;
  }

  function findNextVideo() {
    const currentVideo = findActiveVideo();
    if (!currentVideo) {
      return null;
    }

    const currentRect = currentVideo.getBoundingClientRect();
    const currentCenter = currentRect.top + currentRect.height / 2;

    return [...document.querySelectorAll('video')]
      .filter((video) => video !== currentVideo)
      .map((video) => {
        const rect = video.getBoundingClientRect();
        return {
          video,
          center: rect.top + rect.height / 2,
          hasSize: rect.width > 0 && rect.height > 0
        };
      })
      .filter(({ center, hasSize }) => hasSize && center > currentCenter + 1)
      .sort((first, second) => first.center - second.center)[0]?.video ?? null;
  }

  function scrollToNextItem() {
    const isReelsMode = /^\/reels?(\/|$)/.test(location.pathname);
    const nextItem = isReelsMode
      ? findNextVideo()
      : findNextPost() ?? findNextVideo();
    const scrollTarget = nextItem instanceof HTMLVideoElement
      ? nextItem
      : nextItem?.querySelector('video') ?? nextItem;

    scrollTarget?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest'
    });
  }

  function isPreviousSlideKey(event) {
    return event.code === 'BracketLeft' || event.key === '[' || event.key.toLowerCase() === 'х';
  }

  function isNextSlideKey(event) {
    return event.code === 'BracketRight' || event.key === ']' || event.key.toLowerCase() === 'ъ';
  }

  function switchActivePostSlide(direction) {
    const post = findCurrentPost();
    if (!post) {
      return;
    }

    const labels = direction === 'previous'
      ? ['Previous', 'Go back', 'Назад']
      : ['Next', 'Далее'];

    const control = [...post.querySelectorAll('[aria-label]')]
      .find((element) => labels.includes(element.getAttribute('aria-label')));
    const button = control?.closest('button') ?? control;

    if (button instanceof HTMLElement) {
      button.click();
    }
  }

  function toggleActiveVideo() {
    const video = findActiveVideo();
    if (!video) {
      return;
    }

    if (video.paused) {
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  }

  function isSpeedKey(event) {
    return event.code === 'Period' || event.key === '.' || event.key.toLowerCase() === 'ю';
  }

  function isRewindKey(event) {
    return event.code === 'Comma' || event.key === ',' || event.key.toLowerCase() === 'б';
  }

  function rewindActiveVideo() {
    const video = findActiveVideo();
    if (!video) {
      return;
    }

    video.currentTime = Math.max(0, video.currentTime - REWIND_SECONDS);
  }

  function speedUpActiveVideo() {
    const video = findActiveVideo();
    if (!video) {
      return;
    }

    if (spedUpVideo && spedUpVideo !== video) {
      spedUpVideo.playbackRate = 1;
    }

    spedUpVideo = video;
    spedUpVideo.playbackRate = 1.75;
  }

  function restoreNormalSpeed() {
    if (!spedUpVideo) {
      return;
    }

    spedUpVideo.playbackRate = 1;
    spedUpVideo = null;
  }

  function syncFrameOverlay(video, state) {
    const videoRect = video.getBoundingClientRect();
    const hostRect = state.host.getBoundingClientRect();

    state.overlay.style.left = `${videoRect.left - hostRect.left}px`;
    state.overlay.style.top = `${videoRect.top - hostRect.top}px`;
    state.overlay.style.width = `${videoRect.width}px`;
    state.overlay.style.height = `${videoRect.height}px`;
    state.overlay.style.borderRadius = getComputedStyle(video).borderRadius;
  }

  function captureVideoFrame(video) {
    const state = videoFrameStates.get(video);
    if (
      !state ||
      state.visible ||
      document.hidden ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      visibleArea(video) <= 0
    ) {
      return;
    }

    const now = performance.now();
    if (state.lastCapturedAt && now - state.lastCapturedAt < FRAME_CAPTURE_INTERVAL_MS) {
      return;
    }

    const rect = video.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }

    const scale = Math.min(devicePixelRatio || 1, 1280 / Math.max(rect.width, rect.height));
    const width = Math.max(1, Math.round(rect.width * scale));
    const height = Math.max(1, Math.round(rect.height * scale));

    if (state.canvas.width !== width || state.canvas.height !== height) {
      state.canvas.width = width;
      state.canvas.height = height;
    }

    try {
      const context = state.canvas.getContext('2d', { alpha: false });
      context.drawImage(video, 0, 0, state.canvas.width, state.canvas.height);
      state.hasFrame = true;
      state.lastCapturedAt = now;

      const previousFrame = lastCapturedFrame;
      lastCapturedFrame = {
        canvas: state.canvas,
        capturedAt: now,
        rect,
        state
      };

      if (
        previousFrame &&
        previousFrame.state !== state &&
        !previousFrame.state.visible
      ) {
        previousFrame.state.canvas.width = 1;
        previousFrame.state.canvas.height = 1;
        previousFrame.state.hasFrame = false;
      }
    } catch {
      state.hasFrame = false;
    }
  }

  function restoreLastFrame(video, state) {
    if (!lastCapturedFrame || performance.now() - lastCapturedFrame.capturedAt > 1500) {
      return false;
    }

    const rect = video.getBoundingClientRect();
    const previousRect = lastCapturedFrame.rect;
    if (!rect.width || !rect.height) {
      return false;
    }

    const centerDistanceX = Math.abs(
      rect.left + rect.width / 2 - previousRect.left - previousRect.width / 2
    );
    const centerDistanceY = Math.abs(
      rect.top + rect.height / 2 - previousRect.top - previousRect.height / 2
    );
    if (centerDistanceX > rect.width / 2 || centerDistanceY > rect.height / 2) {
      return false;
    }

    if (
      state.canvas.width !== lastCapturedFrame.canvas.width ||
      state.canvas.height !== lastCapturedFrame.canvas.height
    ) {
      state.canvas.width = lastCapturedFrame.canvas.width;
      state.canvas.height = lastCapturedFrame.canvas.height;
    }

    try {
      const context = state.canvas.getContext('2d', { alpha: false });
      context.drawImage(lastCapturedFrame.canvas, 0, 0);
      state.hasFrame = true;
      return true;
    } catch {
      return false;
    }
  }

  function showFrameOverlay(video) {
    const state = videoFrameStates.get(video);
    if (!state || state.visible) {
      return;
    }

    syncFrameOverlay(video, state);
    state.version += 1;
    state.visible = true;
    state.canvas.hidden = !state.hasFrame;
    state.poster.hidden = state.hasFrame || !video.poster;

    if (!state.hasFrame && video.poster) {
      state.poster.src = video.poster;
    }

    state.overlay.hidden = state.canvas.hidden && state.poster.hidden;
  }

  function hideFrameOverlayAfterPaint(video) {
    const state = videoFrameStates.get(video);
    if (!state?.visible || state.frameCallbackPending) {
      return;
    }

    const version = state.version;
    const hide = () => {
      state.frameCallbackPending = false;

      if (state.version !== version) {
        return;
      }

      state.overlay.hidden = true;
      state.visible = false;
      captureVideoFrame(video);
    };

    state.frameCallbackPending = true;
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(hide);
    } else {
      requestAnimationFrame(() => requestAnimationFrame(hide));
    }
  }

  function protectVideoFrame(video) {
    if (!(video instanceof HTMLVideoElement) || videoFrameStates.has(video)) {
      return;
    }

    const host = video.parentElement;
    if (!host) {
      return;
    }

    const overlay = document.createElement('div');
    const canvas = document.createElement('canvas');
    const poster = document.createElement('img');
    const listenerController = new AbortController();
    const listenerOptions = { signal: listenerController.signal };

    overlay.className = 'isp-frame-overlay';
    canvas.className = 'isp-frame-overlay__image';
    poster.className = 'isp-frame-overlay__image';
    poster.alt = '';
    canvas.hidden = true;
    poster.hidden = true;
    overlay.hidden = true;
    overlay.append(canvas, poster);
    host.classList.add('isp-frame-overlay-host');
    host.append(overlay);

    videoFrameStates.set(video, {
      canvas,
      frameCallbackPending: false,
      hasFrame: false,
      host,
      lastCapturedAt: 0,
      listenerController,
      overlay,
      poster,
      version: 0,
      visible: false
    });

    restoreLastFrame(video, videoFrameStates.get(video));

    video.addEventListener('loadstart', () => showFrameOverlay(video), listenerOptions);
    video.addEventListener('emptied', () => showFrameOverlay(video), listenerOptions);
    video.addEventListener('loadeddata', () => {
      if (videoFrameStates.get(video)?.visible) {
        hideFrameOverlayAfterPaint(video);
      } else {
        captureVideoFrame(video);
      }
    }, listenerOptions);
    video.addEventListener('playing', () => {
      const state = videoFrameStates.get(video);
      if (state?.visible) {
        hideFrameOverlayAfterPaint(video);
      } else if (typeof video.requestVideoFrameCallback === 'function') {
        video.requestVideoFrameCallback(() => captureVideoFrame(video));
      } else {
        captureVideoFrame(video);
      }
    }, listenerOptions);
    video.addEventListener('pause', () => captureVideoFrame(video), listenerOptions);
    video.addEventListener('timeupdate', () => captureVideoFrame(video), listenerOptions);
    captureVideoFrame(video);

    requestAnimationFrame(() => {
      const state = videoFrameStates.get(video);
      if (!state) {
        return;
      }
      if (!state.hasFrame) {
        restoreLastFrame(video, state);
      }

      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        showFrameOverlay(video);
      }
    });
  }

  function protectVideos(root) {
    if (!(root instanceof Element)) {
      return;
    }

    if (root instanceof HTMLVideoElement) {
      protectVideoFrame(root);
    }

    root.querySelectorAll('video').forEach(protectVideoFrame);
  }

  function cleanupVideoFrame(video) {
    const state = videoFrameStates.get(video);
    if (!state) {
      return;
    }

    if (lastCapturedFrame?.state === state) {
      lastCapturedFrame = null;
    }
    if (spedUpVideo === video) {
      video.playbackRate = 1;
      spedUpVideo = null;
    }

    state.listenerController.abort();
    videoFrameStates.delete(video);
    state.overlay.remove();
    if (!state.host.querySelector('.isp-frame-overlay')) {
      state.host.classList.remove('isp-frame-overlay-host');
    }
  }

  function cleanupVideos(root) {
    if (!(root instanceof Element)) {
      return;
    }

    const cleanupOrRehost = (video) => {
      if (!video.isConnected) {
        cleanupVideoFrame(video);
      } else if (videoFrameStates.get(video)?.host !== video.parentElement) {
        cleanupVideoFrame(video);
        protectVideoFrame(video);
      }
    };

    if (root instanceof HTMLVideoElement) {
      cleanupOrRehost(root);
    }
    root.querySelectorAll('video').forEach(cleanupOrRehost);
  }

  function removePlayOverlays(root) {
    if (!(root instanceof Element)) {
      return;
    }

    if (root.matches(PLAY_OVERLAY_SELECTOR)) {
      root.remove();
      return;
    }

    root.querySelectorAll(PLAY_OVERLAY_SELECTOR).forEach((overlay) => overlay.remove());
  }

  document.addEventListener('keydown', (event) => {
    if (isEditable(event.target)) {
      return;
    }

    if (event.key === 'Shift' && !event.repeat) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleActiveVideo();
      return;
    }

    if (event.code === 'Space') {
      event.preventDefault();
      event.stopImmediatePropagation();

      if (!event.repeat) {
        scrollToNextItem();
      }

      return;
    }

    if (isPreviousSlideKey(event) || isNextSlideKey(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();

      if (!event.repeat) {
        switchActivePostSlide(isPreviousSlideKey(event) ? 'previous' : 'next');
      }

      return;
    }

    if (isRewindKey(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      rewindActiveVideo();
      return;
    }

    if (isSpeedKey(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      speedUpActiveVideo();
    }
  }, true);

  document.addEventListener('keyup', (event) => {
    if (event.code === 'Space' && !isEditable(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    if (!isSpeedKey(event)) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    restoreNormalSpeed();
  }, true);

  window.addEventListener('blur', restoreNormalSpeed);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      restoreNormalSpeed();
    }
  });

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && mutation.target instanceof HTMLVideoElement) {
        protectVideoFrame(mutation.target);
        showFrameOverlay(mutation.target);
        continue;
      }

      mutation.removedNodes.forEach(cleanupVideos);
      mutation.addedNodes.forEach((node) => {
        removePlayOverlays(node);
        protectVideos(node);
      });
    }
  });

  function startOverlayRemoval() {
    removePlayOverlays(document.documentElement);
    protectVideos(document.documentElement);
    observer.observe(document.documentElement, {
      attributeFilter: ['src'],
      attributes: true,
      childList: true,
      subtree: true
    });
  }

  if (document.documentElement) {
    startOverlayRemoval();
  } else {
    document.addEventListener('readystatechange', startOverlayRemoval, { once: true });
  }
})();
