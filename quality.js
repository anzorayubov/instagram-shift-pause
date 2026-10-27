(() => {
  'use strict';

  const MAX_MANIFESTS = 60;
  const MAX_MANIFEST_BYTES = 512_000;
  const MAX_JSON_BYTES = 8_000_000;
  const API_URL_PATTERN = /\/graphql|\/api\/v1\//;
  const nativeJsonParse = JSON.parse;
  const nativeResponseJson = Response.prototype.json;
  const nativeXhrOpen = XMLHttpRequest.prototype.open;
  const nativeXhrResponse = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response');
  const manifests = new Map();
  const processedPayloads = new WeakSet();
  const apiRequests = new WeakSet();

  function rememberManifest(original, selected) {
    manifests.set(original, selected);
    while (manifests.size > MAX_MANIFESTS) {
      manifests.delete(manifests.keys().next().value);
    }
    return selected;
  }

  function selectManifest(xml) {
    if (manifests.has(xml)) {
      return manifests.get(xml);
    }
    if (!xml || xml.length > MAX_MANIFEST_BYTES) {
      return xml;
    }

    const documentNode = new DOMParser().parseFromString(xml, 'text/xml');
    const root = documentNode.documentElement;
    if (root?.localName !== 'MPD' || documentNode.getElementsByTagName('parsererror').length) {
      return xml;
    }

    let changed = false;
    for (const period of root.getElementsByTagNameNS('*', 'Period')) {
      const candidates = [];
      const adaptations = [];
      const videoRepresentations = new Set();
      for (const adaptation of period.getElementsByTagNameNS('*', 'AdaptationSet')) {
        const representations = [...adaptation.getElementsByTagNameNS('*', 'Representation')];
        for (const representation of representations) {
          const mime = representation.getAttribute('mimeType') || adaptation.getAttribute('mimeType') || '';
          const contentType = representation.getAttribute('contentType') || adaptation.getAttribute('contentType');
          if (!mime.startsWith('video/') && contentType !== 'video') {
            continue;
          }
          videoRepresentations.add(representation);
          if (!adaptations.includes(adaptation)) {
            adaptations.push(adaptation);
          }
          const codecs = representation.getAttribute('codecs') || adaptation.getAttribute('codecs') || '';
          const type = codecs ? `${mime}; codecs="${codecs}"` : mime;
          if (!type || typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(type)) {
            continue;
          }
          candidates.push({
            representation,
            height: Number.parseInt(representation.getAttribute('FBQualityLabel'), 10) ||
              Number(representation.getAttribute('height') || adaptation.getAttribute('height')) || 0,
            bandwidth: Number(representation.getAttribute('bandwidth')) || 0
          });
        }
      }

      candidates.sort((first, second) => second.height - first.height || second.bandwidth - first.bandwidth);
      const best = candidates[0]?.representation;
      if (!best) {
        continue;
      }
      for (const adaptation of adaptations) {
        for (const representation of [...adaptation.getElementsByTagNameNS('*', 'Representation')]) {
          if (videoRepresentations.has(representation) && representation !== best) {
            representation.remove();
            changed = true;
          }
        }
        if (!adaptation.getElementsByTagNameNS('*', 'Representation').length) {
          adaptation.remove();
        }
      }
    }

    return rememberManifest(xml, changed ? new XMLSerializer().serializeToString(documentNode) : xml);
  }

  function improvePayload(value) {
    const stack = [{ value, depth: 0 }];
    let visited = 0;
    try {
      while (stack.length && visited < 50000) {
        const entry = stack.pop();
        const item = entry.value;
        if (!item || typeof item !== 'object' || entry.depth > 30 || processedPayloads.has(item)) {
          continue;
        }
        processedPayloads.add(item);
        visited += 1;
        if (typeof item.video_dash_manifest === 'string') {
          item.video_dash_manifest = selectManifest(item.video_dash_manifest);
        }
        for (const child of Object.values(item)) {
          if (child && typeof child === 'object') {
            stack.push({ value: child, depth: entry.depth + 1 });
          }
        }
      }
    } catch {
      // Preserve the page's parsed data if an unfamiliar payload cannot be edited.
    }
    return value;
  }

  // Embedded bootstrap data and API responses parsed from text must be changed
  // before Instagram constructs its native DASH player.
  JSON.parse = function patchedJsonParse(text, reviver) {
    const value = nativeJsonParse.apply(this, arguments);
    return typeof text === 'string' && text.length <= MAX_JSON_BYTES && text.includes('video_dash_manifest')
      ? improvePayload(value)
      : value;
  };

  // Response.json() uses the browser's internal JSON parser, not JSON.parse().
  Response.prototype.json = function patchedResponseJson() {
    const promise = nativeResponseJson.apply(this, arguments);
    return API_URL_PATTERN.test(this.url)
      ? promise.then(improvePayload)
      : promise;
  };

  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    const result = nativeXhrOpen.apply(this, arguments);
    if (API_URL_PATTERN.test(String(url))) {
      apiRequests.add(this);
    } else {
      apiRequests.delete(this);
    }
    return result;
  };

  // XHR responseType=json also bypasses JSON.parse. Intercept the getter so
  // listeners see the selected manifest even if registered before open().
  if (nativeXhrResponse?.get && nativeXhrResponse.configurable) {
    Object.defineProperty(XMLHttpRequest.prototype, 'response', {
      ...nativeXhrResponse,
      get() {
        const value = nativeXhrResponse.get.call(this);
        return apiRequests.has(this) && this.responseType === 'json'
          ? improvePayload(value)
          : value;
      }
    });
  }

  // Playback, audio, buffering, seeking and recovery stay with Instagram. Never
  // replace its MediaSource: it continues to maintain the original SourceBuffers.
  window.addEventListener('pagehide', () => manifests.clear());
})();
