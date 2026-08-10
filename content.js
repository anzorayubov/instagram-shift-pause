(() => {
  'use strict';

  const PLAY_OVERLAY_SELECTOR =
    'div[aria-label="Play"].x1yomw13.x1dhbnvk.x4iexvp.xfem2s5.xv2xd2s.xg79w0';
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
      .filter((video) => !video.ended && visibleArea(video) > 0);

    if (!videos.length) {
      return null;
    }

    const playingVideos = videos.filter((video) => !video.paused);
    const candidates = playingVideos.length ? playingVideos : videos;

    return candidates.reduce((best, video) =>
      visibleArea(video) > visibleArea(best) ? video : best
    );
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

  function scrollToNextPost() {
    findNextPost()?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest'
    });
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

  function speedUpActiveVideo() {
    const video = findActiveVideo();
    if (!video) {
      return;
    }

    if (spedUpVideo && spedUpVideo !== video) {
      spedUpVideo.playbackRate = 1;
    }

    spedUpVideo = video;
    spedUpVideo.playbackRate = 2;
  }

  function restoreNormalSpeed() {
    if (!spedUpVideo) {
      return;
    }

    spedUpVideo.playbackRate = 1;
    spedUpVideo = null;
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
        scrollToNextPost();
      }

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
      mutation.addedNodes.forEach((node) => removePlayOverlays(node));
    }
  });

  function startOverlayRemoval() {
    removePlayOverlays(document.documentElement);
    observer.observe(document.documentElement, {
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
