(() => {
  'use strict';

  const BUFFER_AHEAD_SECONDS = 20;
  const BUFFER_BEHIND_SECONDS = 12;
  const MAX_MANIFESTS = 60;
  const MAX_MEDIA_PATHS = 600;
  const MAX_BLOB_ENTRIES = 120;
  const MAX_JSON_BYTES = 8_000_000;
  const API_URL_PATTERN = /\/graphql|\/api\/v1\//;
  const MEDIA_URL_PATTERN = /fbcdn\.net\/.*\.mp4|\/o1\/v\//;

  const nativeFetch = window.fetch;
  const nativeXhrOpen = XMLHttpRequest.prototype.open;
  const nativeCreateObjectURL = URL.createObjectURL;
  const nativeRevokeObjectURL = URL.revokeObjectURL;
  const nativeAppendBuffer = SourceBuffer.prototype.appendBuffer;
  const nativeSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  const nativeSetAttribute = Element.prototype.setAttribute;

  const manifests = new Map();
  const manifestsByPath = new Map();
  const pendingSourcesByPath = new Map();
  const requestUrlByBuffer = new WeakMap();
  const requestPathByMediaSource = new WeakMap();
  const mediaSourceByBuffer = new WeakMap();
  const blobUrlByMediaSource = new WeakMap();
  const representationsByMediaSource = new WeakMap();
  const manifestByBlobUrl = new Map();
  const ownedMediaSources = new WeakSet();
  const controllers = new WeakMap();
  const activeControllers = new Set();
  const failedUntil = new WeakMap();
  const processedScripts = new WeakMap();
  const pendingJsonTexts = [];
  let jsonParseScheduled = false;

  function setBounded(map, key, value, limit) {
    map.delete(key);
    map.set(key, value);

    while (map.size > limit) {
      map.delete(map.keys().next().value);
    }
  }

  function normalizeMediaUrl(value) {
    try {
      const url = new URL(value, location.href);
      return `${url.host}${url.pathname}`;
    } catch {
      return String(value || '');
    }
  }

  function parseDuration(value) {
    const match = /PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?/.exec(value || '');
    return match
      ? Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)
      : 0;
  }

  function parseRange(value) {
    const [start, end] = String(value || '').split('-').map(Number);
    return Number.isFinite(start) && Number.isFinite(end) ? [start, end] : null;
  }

  function parseManifest(xml, key) {
    let documentNode;
    try {
      documentNode = new DOMParser().parseFromString(xml, 'text/xml');
    } catch {
      return null;
    }

    const root = documentNode.documentElement;
    if (!root || root.tagName !== 'MPD') {
      return null;
    }

    const video = [];
    const audio = [];

    for (const adaptation of root.getElementsByTagName('AdaptationSet')) {
      for (const representation of adaptation.getElementsByTagName('Representation')) {
        const baseUrl = representation.getElementsByTagName('BaseURL')[0]?.textContent?.trim();
        const segmentBase = representation.getElementsByTagName('SegmentBase')[0];
        const indexRange = parseRange(segmentBase?.getAttribute('indexRange'));
        if (!baseUrl || !indexRange) {
          continue;
        }

        const initialization = parseRange(
          segmentBase.getElementsByTagName('Initialization')[0]?.getAttribute('range')
        ) ?? [0, indexRange[0] - 1];
        const mime = representation.getAttribute('mimeType') || adaptation.getAttribute('mimeType') || '';
        const codecs = representation.getAttribute('codecs') || adaptation.getAttribute('codecs') || '';
        const label = representation.getAttribute('FBQualityLabel') || '';
        const height = Number.parseInt(label, 10) || Number(representation.getAttribute('height')) || 0;
        const item = {
          bandwidth: Number(representation.getAttribute('bandwidth')) || 0,
          codecs,
          height,
          indexRange,
          initialization,
          mime,
          path: normalizeMediaUrl(baseUrl),
          url: baseUrl
        };

        (mime.startsWith('audio/') || adaptation.getAttribute('contentType') === 'audio'
          ? audio
          : video).push(item);
      }
    }

    if (!video.length) {
      return null;
    }

    video.sort((first, second) => second.height - first.height || second.bandwidth - first.bandwidth);
    audio.sort((first, second) => second.bandwidth - first.bandwidth);

    return {
      audio,
      duration: parseDuration(root.getAttribute('mediaPresentationDuration')),
      key,
      video
    };
  }

  function rememberManifest(manifest) {
    const previousManifest = manifests.get(manifest.key);
    if (previousManifest && previousManifest !== manifest) {
      for (const representation of [...previousManifest.video, ...previousManifest.audio]) {
        if (manifestsByPath.get(representation.path) === previousManifest) {
          manifestsByPath.delete(representation.path);
        }
      }
    }

    setBounded(manifests, manifest.key, manifest, MAX_MANIFESTS);
    for (const representation of [...manifest.video, ...manifest.audio]) {
      setBounded(manifestsByPath, representation.path, manifest, MAX_MEDIA_PATHS);

      const pendingSources = pendingSourcesByPath.get(representation.path);
      if (pendingSources) {
        pendingSourcesByPath.delete(representation.path);
        for (const reference of pendingSources) {
          const mediaSource = reference.deref();
          if (mediaSource) {
            connectManifestToMediaSource(mediaSource, representation.path);
          }
        }
      }
    }
  }

  function scanJson(value) {
    const stack = [{ value, depth: 0 }];
    let visited = 0;

    while (stack.length && visited < 50000) {
      const entry = stack.pop();
      visited += 1;

      if (!entry.value || typeof entry.value !== 'object' || entry.depth > 30) {
        continue;
      }

      const xml = entry.value.video_dash_manifest;
      if (typeof xml === 'string' && xml.length) {
        const key = String(entry.value.pk ?? entry.value.id ?? entry.value.code ?? xml.slice(0, 120));
        const manifest = parseManifest(xml, key);
        if (manifest) {
          rememberManifest(manifest);
        }
      }

      for (const [key, child] of Object.entries(entry.value)) {
        if (key !== 'video_dash_manifest' && child && typeof child === 'object') {
          stack.push({ value: child, depth: entry.depth + 1 });
        }
      }
    }
  }

  function parseJsonText(text) {
    if (!text.includes('video_dash_manifest') || text.length > MAX_JSON_BYTES) {
      return;
    }

    try {
      scanJson(JSON.parse(text));
    } catch {
      // Instagram occasionally embeds non-JSON data in script nodes.
    }
  }

  function scheduleJsonParse(text) {
    if (typeof text !== 'string' || !text.includes('video_dash_manifest')) {
      return;
    }

    pendingJsonTexts.push(text);
    if (pendingJsonTexts.length > 4) {
      pendingJsonTexts.shift();
    }
    if (jsonParseScheduled) {
      return;
    }

    jsonParseScheduled = true;
    const drain = () => {
      jsonParseScheduled = false;
      const nextText = pendingJsonTexts.shift();
      if (nextText) {
        parseJsonText(nextText);
      }
      if (pendingJsonTexts.length) {
        scheduleJsonParse(pendingJsonTexts.shift());
      }
    };

    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(drain, { timeout: 1000 });
    } else {
      setTimeout(drain, 0);
    }
  }

  function trackBuffer(buffer, url) {
    const arrayBuffer = ArrayBuffer.isView(buffer) ? buffer.buffer : buffer;
    if (arrayBuffer instanceof ArrayBuffer) {
      requestUrlByBuffer.set(arrayBuffer, normalizeMediaUrl(url));
    }
  }

  function instrumentMediaResponse(response, url) {
    try {
      const originalArrayBuffer = response.arrayBuffer.bind(response);
      response.arrayBuffer = () => originalArrayBuffer().then((buffer) => {
        trackBuffer(buffer, url);
        return buffer;
      });

      const stream = response.body;
      if (stream && !stream.__ispTracked) {
        const originalGetReader = stream.getReader.bind(stream);
        Object.defineProperty(stream, '__ispTracked', { value: true });
        stream.getReader = (...args) => {
          const reader = originalGetReader(...args);
          if (args[0]?.mode === 'byob') {
            return reader;
          }

          const originalRead = reader.read.bind(reader);
          reader.read = () => originalRead().then((result) => {
            if (result.value) {
              trackBuffer(result.value, url);
            }
            return result;
          });
          return reader;
        };
      }
    } catch {
      // A frozen Response/ReadableStream is safe to leave uninstrumented.
    }

    return response;
  }

  function selectVideoRepresentation(manifest) {
    return manifest.video.find(isRepresentationSupported) ?? null;
  }

  function representationType(representation) {
    return representation.codecs
      ? `${representation.mime}; codecs="${representation.codecs}"`
      : representation.mime;
  }

  function isRepresentationSupported(representation) {
    const type = representationType(representation);
    if (!type) {
      return false;
    }

    try {
      return typeof MediaSource.isTypeSupported !== 'function' || MediaSource.isTypeSupported(type);
    } catch {
      return false;
    }
  }

  async function readResponseTextWithinLimit(response) {
    const length = Number(response.headers.get('content-length')) || 0;
    if (length > MAX_JSON_BYTES) {
      return null;
    }

    if (!response.body) {
      const text = await response.text();
      return text.length <= MAX_JSON_BYTES ? text : null;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let received = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          chunks.push(decoder.decode());
          return chunks.join('');
        }

        received += value.byteLength;
        if (received > MAX_JSON_BYTES) {
          await reader.cancel();
          return null;
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.releaseLock();
    }
  }

  function withByteRange(url, start, end) {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}bytestart=${start}&byteend=${end}`;
  }

  function parseSidx(buffer, absoluteOffset) {
    const view = new DataView(buffer);
    let offset = 0;

    while (offset + 8 <= view.byteLength) {
      let size = view.getUint32(offset);
      const type = String.fromCharCode(
        view.getUint8(offset + 4),
        view.getUint8(offset + 5),
        view.getUint8(offset + 6),
        view.getUint8(offset + 7)
      );
      let headerSize = 8;

      if (size === 1 && offset + 16 <= view.byteLength) {
        size = Number(view.getBigUint64(offset + 8));
        headerSize = 16;
      } else if (size === 0) {
        size = view.byteLength - offset;
      }

      if (type === 'sidx') {
        const version = view.getUint8(offset + headerSize);
        let cursor = offset + headerSize + 8;
        const timescale = view.getUint32(cursor);
        cursor += 4;
        let earliestTime;
        let firstOffset;

        if (version === 0) {
          earliestTime = view.getUint32(cursor);
          firstOffset = view.getUint32(cursor + 4);
          cursor += 8;
        } else {
          earliestTime = Number(view.getBigUint64(cursor));
          firstOffset = Number(view.getBigUint64(cursor + 8));
          cursor += 16;
        }

        cursor += 2;
        const count = view.getUint16(cursor);
        cursor += 2;
        const segments = [];
        let time = earliestTime;
        let byteStart = absoluteOffset + offset + size + firstOffset;

        for (let index = 0; index < count && cursor + 12 <= view.byteLength; index += 1) {
          const segmentSize = view.getUint32(cursor) & 0x7fffffff;
          const duration = view.getUint32(cursor + 4);
          cursor += 12;
          segments.push({
            byteEnd: byteStart + segmentSize - 1,
            byteStart,
            end: (time + duration) / timescale,
            start: time / timescale
          });
          time += duration;
          byteStart += segmentSize;
        }

        return segments;
      }

      if (!size || offset + size > view.byteLength) {
        break;
      }
      offset += size;
    }

    return [];
  }

  class QualityController {
    constructor(video, manifest, { representations, recoveryRepresentations = null } = {}) {
      this.video = video;
      this.manifest = manifest;
      this.videoRepresentation = representations?.video ?? selectVideoRepresentation(manifest);
      this.audioRepresentation = representations
        ? representations.audio
        : manifest.audio.find(isRepresentationSupported) ?? null;
      this.recoveryRepresentations = recoveryRepresentations;
      this.abortController = new AbortController();
      this.tracks = [];
      this.mediaSource = null;
      this.blobUrl = '';
      this.destroyed = false;
      this.resumeTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      this.resumePlaying = !video.paused && !video.ended;
      this.playbackRestored = false;
    }

    listen(target, type, listener, options = {}) {
      target.addEventListener(type, listener, {
        ...options,
        signal: this.abortController.signal
      });
    }

    start() {
      if (!this.videoRepresentation || !nativeSrcDescriptor?.set) {
        return;
      }

      this.mediaSource = new MediaSource();
      ownedMediaSources.add(this.mediaSource);
      this.blobUrl = nativeCreateObjectURL.call(URL, this.mediaSource);
      blobUrlByMediaSource.set(this.mediaSource, this.blobUrl);
      this.listen(this.mediaSource, 'sourceopen', () => this.open(), { once: true });
      this.listen(this.mediaSource, 'sourceclose', () => this.destroy(), { once: true });
      this.listen(this.video, 'loadedmetadata', () => this.restorePlayback());
      this.listen(this.video, 'error', () => this.fail());
      this.listen(this.video, 'timeupdate', () => this.tick());
      this.listen(this.video, 'seeking', () => this.tick());
      activeControllers.add(this);
      nativeSrcDescriptor.set.call(this.video, this.blobUrl);
    }

    async open() {
      if (this.destroyed || !this.mediaSource || this.mediaSource.readyState !== 'open') {
        return;
      }

      if (this.manifest.duration > 0) {
        try {
          this.mediaSource.duration = this.manifest.duration;
        } catch {
          // Duration can remain unknown until metadata arrives.
        }
      }

      const representations = [this.videoRepresentation, this.audioRepresentation].filter(Boolean);
      try {
        this.tracks = representations.map((representation) => {
          const sourceBuffer = this.mediaSource.addSourceBuffer(
            representationType(representation)
          );
          const track = {
            fetchController: null,
            loading: false,
            lastSegmentAppended: false,
            ready: false,
            representation,
            segments: [],
            sourceBuffer
          };
          this.listen(sourceBuffer, 'updateend', () => this.tick());
          this.listen(sourceBuffer, 'error', () => this.fail());
          return track;
        });
      } catch {
        this.fail();
        return;
      }

      await Promise.all(this.tracks.map((track) => this.loadIndex(track)));
    }

    async loadIndex(track) {
      const representation = track.representation;
      const end = Math.max(representation.indexRange[1], representation.initialization[1]);
      const controller = new AbortController();
      track.fetchController = controller;

      try {
        const response = await nativeFetch.call(window, withByteRange(representation.url, 0, end), {
          credentials: 'omit',
          signal: controller.signal
        });
        if (!response.ok) {
          throw new Error(String(response.status));
        }

        const buffer = await response.arrayBuffer();
        if (this.destroyed) {
          return;
        }

        const [initStart, initEnd] = representation.initialization;
        const [indexStart, indexEnd] = representation.indexRange;
        track.segments = parseSidx(buffer.slice(indexStart, indexEnd + 1), indexStart);
        if (!track.segments.length) {
          throw new Error('Missing sidx segments');
        }

        track.fetchController = null;
        track.ready = true;
        track.sourceBuffer.appendBuffer(buffer.slice(initStart, initEnd + 1));
      } catch (error) {
        if (error.name !== 'AbortError') {
          this.fail();
        }
      }
    }

    restorePlayback() {
      if (this.destroyed) {
        return;
      }

      if (this.resumeTime > 0.2) {
        try {
          this.video.currentTime = this.resumeTime;
        } catch {
          // The seek will be retried naturally after buffering.
        }
      }

      if (this.resumePlaying) {
        void this.video.play().catch(() => {});
      }
      this.playbackRestored = true;
      this.tick();
    }

    bufferedEnd(track, currentTime) {
      const ranges = track.sourceBuffer.buffered;
      for (let index = 0; index < ranges.length; index += 1) {
        if (ranges.start(index) <= currentTime + 0.25 && ranges.end(index) >= currentTime - 0.1) {
          return ranges.end(index);
        }
      }
      return currentTime;
    }

    tick() {
      if (this.destroyed) {
        return;
      }
      if (!this.video.isConnected) {
        this.destroy();
        return;
      }

      const currentTime = Number.isFinite(this.video.currentTime) ? this.video.currentTime : 0;
      for (const track of this.tracks) {
        if (!track.ready || track.loading || track.sourceBuffer.updating) {
          continue;
        }

        const ranges = track.sourceBuffer.buffered;
        if (ranges.length && ranges.start(0) < currentTime - BUFFER_BEHIND_SECONDS - 5) {
          try {
            track.sourceBuffer.remove(0, currentTime - BUFFER_BEHIND_SECONDS);
            continue;
          } catch {
            // Continue with bounded forward buffering.
          }
        }

        const end = this.bufferedEnd(track, currentTime);
        if (end - currentTime >= BUFFER_AHEAD_SECONDS) {
          continue;
        }

        const segment = track.segments.find((item) => item.end > Math.max(end, currentTime) + 0.05);
        if (segment) {
          void this.fetchSegment(track, segment);
        }
      }

      // Older segments may have been evicted; only the remaining playback needs
      // to be buffered. appendBuffer reopens an ended source after a seek/loop.
      if (
        this.mediaSource?.readyState === 'open' &&
        this.tracks.length &&
        this.tracks.every((track) =>
          track.ready && !track.loading && !track.sourceBuffer.updating &&
          track.lastSegmentAppended && track.sourceBuffer.buffered.length &&
          this.bufferedEnd(track, currentTime) >= track.segments.at(-1).end - 0.05
        )
      ) {
        try {
          this.mediaSource.endOfStream();
        } catch {
          this.fail();
        }
      }
    }

    async fetchSegment(track, segment) {
      const controller = new AbortController();
      track.fetchController = controller;
      track.loading = true;

      try {
        const response = await nativeFetch.call(
          window,
          withByteRange(track.representation.url, segment.byteStart, segment.byteEnd),
          { credentials: 'omit', signal: controller.signal }
        );
        if (!response.ok) {
          throw new Error(String(response.status));
        }

        const buffer = await response.arrayBuffer();
        if (!this.destroyed && track.fetchController === controller) {
          track.fetchController = null;
          track.loading = false;
          track.sourceBuffer.appendBuffer(buffer);
          if (segment === track.segments.at(-1)) {
            track.lastSegmentAppended = true;
          }
        }
      } catch (error) {
        if (error.name !== 'AbortError') {
          this.fail();
        }
      }
    }

    fail() {
      if (this.destroyed) {
        return;
      }

      const video = this.video;
      const manifest = this.manifest;
      const representations = this.recoveryRepresentations;
      const resumeTime = this.playbackRestored ? video.currentTime : this.resumeTime;
      const resumePlaying = this.playbackRestored ? !video.paused && !video.ended : this.resumePlaying;
      failedUntil.set(this.video, performance.now() + 30000);
      this.destroy();

      if (!video.isConnected || !representations?.video) {
        return;
      }

      // A detached MediaSource loses its SourceBuffers. Rebuild the original
      // representation once instead of reassigning its stale blob URL.
      const recovery = new QualityController(video, manifest, { representations });
      recovery.resumeTime = Number.isFinite(resumeTime) ? resumeTime : 0;
      recovery.resumePlaying = resumePlaying;
      controllers.set(video, recovery);
      try {
        recovery.start();
      } catch {
        recovery.destroy();
      }
    }

    destroy() {
      if (this.destroyed) {
        return;
      }

      this.destroyed = true;
      this.abortController.abort();
      for (const track of this.tracks) {
        track.fetchController?.abort();
        if (!track.sourceBuffer.updating) {
          try {
            track.sourceBuffer.remove(0, Number.POSITIVE_INFINITY);
          } catch {
            // Revoking the MediaSource below releases the backing buffers.
          }
        }
      }
      if (controllers.get(this.video) === this) {
        controllers.delete(this.video);
      }
      activeControllers.delete(this);
      if (this.blobUrl) {
        manifestByBlobUrl.delete(this.blobUrl);
        nativeRevokeObjectURL.call(URL, this.blobUrl);
      }

      this.tracks = [];
      this.mediaSource = null;
      this.manifest = null;
      this.recoveryRepresentations = null;
    }
  }

  function upgradeVideo(video, manifest, recoveryRepresentations) {
    if (!(video instanceof HTMLVideoElement) || controllers.has(video)) {
      return;
    }
    if ((failedUntil.get(video) ?? 0) > performance.now()) {
      return;
    }

    const controller = new QualityController(video, manifest, { recoveryRepresentations });
    if (!controller.videoRepresentation) {
      return;
    }
    controllers.set(video, controller);
    try {
      controller.start();
    } catch {
      controller.fail();
    }
  }

  function connectManifestToMediaSource(mediaSource, requestPath) {
    const manifest = manifestsByPath.get(requestPath);
    const blobUrl = blobUrlByMediaSource.get(mediaSource);
    if (!manifest || !blobUrl) {
      return;
    }

    const representations = representationsByMediaSource.get(mediaSource) ?? {
      video: null,
      audio: manifest.audio.find(isRepresentationSupported) ?? null
    };
    const originalVideo = manifest.video.find((item) => item.path === requestPath);
    const originalAudio = manifest.audio.find((item) => item.path === requestPath);
    if (originalVideo) {
      representations.video = originalVideo;
    }
    if (originalAudio) {
      representations.audio = originalAudio;
    }
    representationsByMediaSource.set(mediaSource, representations);

    setBounded(manifestByBlobUrl, blobUrl, manifest, MAX_BLOB_ENTRIES);
    queueMicrotask(() => {
      if (!representations.video) {
        return;
      }
      for (const video of document.querySelectorAll('video')) {
        if (video.src === blobUrl || video.currentSrc === blobUrl) {
          upgradeVideo(video, manifest, { ...representations });
        }
      }
    });
  }

  function rememberMediaSourcePath(mediaSource, requestPath) {
    if (requestPathByMediaSource.get(mediaSource) === requestPath) {
      return;
    }
    requestPathByMediaSource.set(mediaSource, requestPath);

    if (manifestsByPath.has(requestPath)) {
      connectManifestToMediaSource(mediaSource, requestPath);
      return;
    }

    const references = pendingSourcesByPath.get(requestPath) ?? new Set();
    references.add(new WeakRef(mediaSource));
    setBounded(pendingSourcesByPath, requestPath, references, MAX_MEDIA_PATHS);
  }

  window.fetch = function patchedFetch(input, init) {
    let url = '';
    try {
      url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    } catch {
      // Preserve the native fetch error behavior.
    }

    const promise = nativeFetch.call(this, input, init);
    if (url && API_URL_PATTERN.test(url)) {
      void promise.then((response) => {
        void readResponseTextWithinLimit(response.clone()).then((text) => {
          if (text !== null) {
            scheduleJsonParse(text);
          }
        }).catch(() => {});
      }).catch(() => {});
    }

    if (url && MEDIA_URL_PATTERN.test(url)) {
      return promise.then((response) => instrumentMediaResponse(response, url));
    }
    return promise;
  };

  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    const requestUrl = String(url);

    if (API_URL_PATTERN.test(requestUrl)) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === 'json' && this.response) {
            scanJson(this.response);
          } else if (this.responseType === '' || this.responseType === 'text') {
            scheduleJsonParse(this.responseText);
          }
        } catch {
          // Preserve the page request even if its response is unreadable here.
        }
      }, { once: true });
    } else if (MEDIA_URL_PATTERN.test(requestUrl)) {
      this.addEventListener('load', () => {
        if (this.response instanceof ArrayBuffer) {
          trackBuffer(this.response, requestUrl);
        }
      }, { once: true });
    }

    return nativeXhrOpen.call(this, method, url, ...rest);
  };

  URL.createObjectURL = function patchedCreateObjectURL(object) {
    const url = nativeCreateObjectURL.call(this, object);
    if (object instanceof MediaSource) {
      blobUrlByMediaSource.set(object, url);
    }
    return url;
  };

  URL.revokeObjectURL = function patchedRevokeObjectURL(url) {
    manifestByBlobUrl.delete(String(url));
    return nativeRevokeObjectURL.call(this, url);
  };

  const nativeAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function patchedAddSourceBuffer(type) {
    const sourceBuffer = nativeAddSourceBuffer.call(this, type);
    mediaSourceByBuffer.set(sourceBuffer, this);
    return sourceBuffer;
  };

  SourceBuffer.prototype.appendBuffer = function patchedAppendBuffer(data) {
    if (!ownedMediaSources.has(mediaSourceByBuffer.get(this))) {
      const buffer = ArrayBuffer.isView(data) ? data.buffer : data;
      const requestPath = requestUrlByBuffer.get(buffer);
      const mediaSource = mediaSourceByBuffer.get(this);
      if (requestPath && mediaSource) {
        rememberMediaSourcePath(mediaSource, requestPath);
      }
    }
    return nativeAppendBuffer.call(this, data);
  };

  if (nativeSrcDescriptor?.get && nativeSrcDescriptor.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      configurable: true,
      get: nativeSrcDescriptor.get,
      set(value) {
        controllers.get(this)?.destroy();
        nativeSrcDescriptor.set.call(this, value);
      }
    });
  }

  Element.prototype.setAttribute = function patchedSetAttribute(name, value) {
    if (name === 'src' && this instanceof HTMLMediaElement) {
      controllers.get(this)?.destroy();
    }
    return nativeSetAttribute.call(this, name, value);
  };

  function scanScript(script) {
    if (!(script instanceof HTMLScriptElement)) {
      return;
    }
    const text = script.textContent || '';
    if (
      !text.includes('video_dash_manifest') || text.length > MAX_JSON_BYTES ||
      processedScripts.get(script) === text
    ) {
      return;
    }
    processedScripts.set(script, text);
    scheduleJsonParse(text);
  }

  function cleanupRemovedNode(node) {
    if (!(node instanceof Element) || node.isConnected) {
      return;
    }
    if (node instanceof HTMLVideoElement) {
      controllers.get(node)?.destroy();
    }
    node.querySelectorAll('video').forEach((video) => {
      if (!video.isConnected) {
        controllers.get(video)?.destroy();
      }
    });
  }

  function startObserver() {
    document.querySelectorAll('script[type="application/json"]').forEach(scanScript);
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        scanScript(mutation.type === 'characterData' ? mutation.target.parentElement : mutation.target);
        mutation.removedNodes.forEach(cleanupRemovedNode);
        mutation.addedNodes.forEach((node) => {
          if (node instanceof HTMLScriptElement) {
            scanScript(node);
          } else if (node instanceof Element) {
            node.querySelectorAll('script[type="application/json"]').forEach(scanScript);
          }
        });
      }
    }).observe(document.documentElement, { childList: true, characterData: true, subtree: true });
  }

  if (document.documentElement) {
    startObserver();
  } else {
    document.addEventListener('readystatechange', startObserver, { once: true });
  }

  window.addEventListener('pagehide', () => {
    for (const controller of activeControllers) {
      controller.destroy();
    }
    activeControllers.clear();
    manifests.clear();
    manifestsByPath.clear();
    pendingSourcesByPath.clear();
    manifestByBlobUrl.clear();
    pendingJsonTexts.length = 0;
  }, { once: true });
})();
