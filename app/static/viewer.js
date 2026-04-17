(function () {
  'use strict';

  const video = document.getElementById('video');
  const zoneOverlay = document.getElementById('zone-overlay');
  const streamLabel = document.getElementById('stream-label');
  const cameraGrid = document.getElementById('camera-grid');
  const muteBtn = document.getElementById('mute-btn');
  const volumeSlider = document.getElementById('volume-slider');

  let hls = null;
  let streamsData = null; // full API response
  let currentStreamId = null;
  let thumbnailTimer = null;

  // PiP state
  const pipContainer = document.getElementById('pip-container');
  const pipVideo = document.getElementById('pip-video');
  const pipLabel = document.getElementById('pip-label');
  const pipCloseBtn = document.getElementById('pip-close');
  const pipMuteBtn = document.getElementById('pip-mute');
  const pipResizeHandle = document.getElementById('pip-resize-handle');
  let pipHls = null;
  let pipStreamId = null;

  const THUMBNAIL_REFRESH_MS = 30_000;

  // ---------------------------------------------------------------- Quality

  let currentQuality = localStorage.getItem('ftview-quality') || 'high';
  let pipQuality = localStorage.getItem('ftview-pip-quality') || 'high';

  function hlsUrl(streamId, quality) {
    return (
      '/hls/' +
      encodeURIComponent(streamId) +
      '/index.m3u8?quality=' +
      encodeURIComponent(quality)
    );
  }

  // ---------------------------------------------------------------- Volume (persists across switches)

  function loadVolume() {
    const saved = localStorage.getItem('ftview-volume');
    const muted = localStorage.getItem('ftview-muted');
    if (saved !== null) {
      video.volume = parseFloat(saved);
      volumeSlider.value = saved;
    }
    if (muted === 'true') {
      video.muted = true;
    }
    updateMuteIcon();
  }

  function updateMuteIcon() {
    if (video.muted || video.volume === 0) {
      muteBtn.textContent = '\u{1F507}';
    } else if (video.volume < 0.5) {
      muteBtn.textContent = '\u{1F509}';
    } else {
      muteBtn.textContent = '\u{1F50A}';
    }
  }

  volumeSlider.addEventListener('input', () => {
    video.volume = parseFloat(volumeSlider.value);
    video.muted = false;
    localStorage.setItem('ftview-volume', volumeSlider.value);
    localStorage.setItem('ftview-muted', 'false');
    updateMuteIcon();
  });

  muteBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    localStorage.setItem('ftview-muted', String(video.muted));
    updateMuteIcon();
  });

  // ---------------------------------------------------------------- Init

  async function init() {
    loadVolume();
    streamsData = await fetchJson('/api/streams');
    if (!streamsData) return;
    buildGrid();
    // auto-select first visible stream
    const first = visibleStreams()[0];
    if (first) switchStream(first.id);
  }

  // ---------------------------------------------------------------- Data helpers

  function visibleStreams() {
    return (streamsData.liveStreams || [])
      .filter((s) => !s.hidden && !s.excludeFromGrid)
      .sort((a, b) => a.order - b.order);
  }

  function streamById(id) {
    return (streamsData.liveStreams || []).find((s) => s.id === id);
  }

  function streamStatus(id) {
    return (streamsData.liveStreamStatus || {})[id] || 'offline';
  }

  function streamDomain(id) {
    return (streamsData.loadBalancer || {})[id] || 'streams-h.fishtank.live';
  }

  // ---------------------------------------------------------------- Grid

  function buildGrid() {
    cameraGrid.innerHTML = '';
    for (const stream of visibleStreams()) {
      const card = document.createElement('div');
      card.className = 'camera-card';
      card.dataset.streamId = stream.id;
      card.addEventListener('click', (e) => {
        if (e.shiftKey) {
          pinStream(stream.id);
        } else {
          switchStream(stream.id);
        }
      });

      const img = document.createElement('img');
      img.src = stream.thumbnailUrl;
      img.alt = stream.name;
      img.loading = 'lazy';
      img.dataset.baseSrc = stream.thumbnailUrl;

      const info = document.createElement('div');
      info.className = 'card-info';

      const dot = document.createElement('span');
      dot.className = 'status-dot ' + streamStatus(stream.id);

      const name = document.createElement('span');
      name.className = 'card-name';
      name.textContent = stream.name;

      info.appendChild(dot);
      info.appendChild(name);

      if (stream.access !== 'public' && stream.access !== 'normal') {
        const badge = document.createElement('span');
        badge.className = 'access-badge';
        badge.textContent = stream.access.replace(/_/g, ' ');
        info.appendChild(badge);
      }

      card.appendChild(img);
      card.appendChild(info);
      cameraGrid.appendChild(card);
    }
    startThumbnailRefresh();
  }

  // ---------------------------------------------------------------- Thumbnail refresh

  function startThumbnailRefresh() {
    if (thumbnailTimer) clearInterval(thumbnailTimer);
    thumbnailTimer = setInterval(() => {
      const images = cameraGrid.querySelectorAll('img[data-base-src]');
      const bust = Date.now();
      images.forEach((img) => {
        img.src = img.dataset.baseSrc + '?_=' + bust;
      });
    }, THUMBNAIL_REFRESH_MS);
  }

  // ---------------------------------------------------------------- Switch stream

  async function switchStream(streamId) {
    currentStreamId = streamId;
    highlightActiveCard(streamId);

    const stream = streamById(streamId);
    streamLabel.textContent = stream ? stream.name : streamId;

    // Start HLS playback directly (URL is predictable, no round-trip needed)
    loadHls(hlsUrl(streamId, currentQuality));

    // Load clickable zones in parallel with HLS startup
    if (stream && stream.interactive) {
      fetchJson('/api/zones/' + encodeURIComponent(streamId)).then((zones) => {
        if (currentStreamId === streamId) renderZones(zones);
      });
    } else {
      clearZones();
    }
  }

  function highlightActiveCard(streamId) {
    cameraGrid.querySelectorAll('.camera-card').forEach((card) => {
      card.classList.toggle('active', card.dataset.streamId === streamId);
    });
  }

  // ---------------------------------------------------------------- HLS.js

  const HLS_CONFIG = {
    enableWorker: true,
    lowLatencyMode: true,
    liveSyncDurationCount: 2,
    liveMaxLatencyDurationCount: 5,
    maxBufferLength: 10,
    backBufferLength: 5,
  };

  function loadHls(url) {
    if (Hls.isSupported()) {
      // Reuse existing instance so captureStream() survives camera switches
      if (hls) {
        hls.loadSource(url);
        return;
      }
      hls = new Hls(HLS_CONFIG);
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        loadVolume();
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad();
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          } else {
            // Unrecoverable — tear down and rebuild on next load
            hls.destroy();
            hls = null;
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      video.addEventListener(
        'loadedmetadata',
        () => {
          loadVolume();
          video.play().catch(() => {});
        },
        { once: true },
      );
    }
  }

  // ---------------------------------------------------------------- Clickable zones

  function clearZones() {
    zoneOverlay.innerHTML = '';
  }

  function renderZones(data) {
    clearZones();
    if (!data || !data.clickableZones) return;

    const now = Date.now();

    for (const zone of data.clickableZones) {
      // Skip zones outside their validity window
      if (zone.valid) {
        if (zone.valid.start && new Date(zone.valid.start).getTime() > now)
          continue;
        if (zone.valid.end && new Date(zone.valid.end).getTime() < now)
          continue;
      }

      if (!zone.points || !zone.action || !zone.action.metadata) continue;

      // points = "x1,y1 x2,y2 x3,y3 ..." with 0-1 normalized coords
      const poly = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'polygon',
      );
      poly.setAttribute('points', zone.points);
      poly.dataset.target = zone.action.metadata;
      poly.dataset.name = zone.name || '';

      poly.addEventListener('click', (e) => {
        e.stopPropagation();
        switchStream(zone.action.metadata);
      });

      // Tooltip on hover
      poly.addEventListener('mouseenter', (e) => showZoneTooltip(e, zone.name));
      poly.addEventListener('mousemove', (e) => moveZoneTooltip(e));
      poly.addEventListener('mouseleave', hideZoneTooltip);

      zoneOverlay.appendChild(poly);
    }
  }

  // ---- Zone tooltips
  let tooltip = null;

  function showZoneTooltip(e, text) {
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'zone-tooltip';
      document.getElementById('video-container').appendChild(tooltip);
    }
    tooltip.textContent = text;
    tooltip.style.opacity = '1';
    moveZoneTooltip(e);
  }

  function moveZoneTooltip(e) {
    if (!tooltip) return;
    const container = document.getElementById('video-container');
    const rect = container.getBoundingClientRect();
    tooltip.style.left = e.clientX - rect.left + 12 + 'px';
    tooltip.style.top = e.clientY - rect.top - 8 + 'px';
  }

  function hideZoneTooltip() {
    if (tooltip) tooltip.style.opacity = '0';
  }

  // ---------------------------------------------------------------- PiP (Picture-in-Picture)

  function pinStream(streamId) {
    // Toggle off if already pinned to this stream
    if (pipStreamId === streamId) {
      unpinStream();
      return;
    }

    pipStreamId = streamId;
    const stream = streamById(streamId);
    pipLabel.textContent = stream ? stream.name : streamId;

    const url = hlsUrl(streamId, pipQuality);

    if (Hls.isSupported()) {
      // Reuse existing PiP HLS instance so captureStream() survives switches
      if (pipHls) {
        pipHls.loadSource(url);
      } else {
        pipHls = new Hls(HLS_CONFIG);
        pipHls.loadSource(url);
        pipHls.attachMedia(pipVideo);
        pipHls.on(Hls.Events.MANIFEST_PARSED, () => {
          pipVideo.play().catch(() => {});
        });
        pipHls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) pipHls.startLoad();
            else if (data.type === Hls.ErrorTypes.MEDIA_ERROR)
              pipHls.recoverMediaError();
            else {
              pipHls.destroy();
              pipHls = null;
            }
          }
        });
      }
    } else if (pipVideo.canPlayType('application/vnd.apple.mpegurl')) {
      pipVideo.src = url;
      pipVideo.addEventListener(
        'loadedmetadata',
        () => {
          pipVideo.play().catch(() => {});
        },
        { once: true },
      );
    }

    pipContainer.classList.remove('pip-hidden');
    highlightPinnedCard(streamId);
    updatePipMuteIcon();
  }

  function unpinStream() {
    // Stop PiP clip recorder before tearing down
    if (pipRecorder) {
      pipRecorder.stop();
      pipRecorder = null;
      updateClipUI('pip');
    }
    if (pipHls) {
      pipHls.destroy();
      pipHls = null;
    }
    pipVideo.removeAttribute('src');
    pipStreamId = null;
    pipContainer.classList.add('pip-hidden');
    highlightPinnedCard(null);
  }

  function highlightPinnedCard(streamId) {
    cameraGrid.querySelectorAll('.camera-card').forEach((card) => {
      const isPinned = card.dataset.streamId === streamId;
      card.classList.toggle('pinned', isPinned);
      // Add/remove pin badge
      let badge = card.querySelector('.pin-badge');
      if (isPinned && !badge) {
        badge = document.createElement('span');
        badge.className = 'pin-badge';
        badge.textContent = '\u{1F4CC}';
        card.appendChild(badge);
      } else if (!isPinned && badge) {
        badge.remove();
      }
    });
  }

  // PiP mute toggle
  function updatePipMuteIcon() {
    pipMuteBtn.textContent = pipVideo.muted ? '\u{1F507}' : '\u{1F50A}';
  }

  pipMuteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    pipVideo.muted = !pipVideo.muted;
    updatePipMuteIcon();
  });

  // PiP close button
  pipCloseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    unpinStream();
  });

  // ---- PiP drag
  (function initPipDrag() {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    pipContainer.addEventListener('pointerdown', (e) => {
      // Don't drag when interacting with buttons or resize handle
      if (
        e.target.closest(
          '#pip-close, #pip-mute, #pip-resize-handle, #pip-quality-controls, #pip-clip-controls',
        )
      )
        return;
      dragging = true;
      pipContainer.classList.add('pip-dragging');
      const rect = pipContainer.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      pipContainer.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    pipContainer.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const parent = pipContainer.parentElement;
      const parentRect = parent.getBoundingClientRect();
      const pipW = pipContainer.offsetWidth;
      const pipH = pipContainer.offsetHeight;

      let newLeft = e.clientX - parentRect.left - offsetX;
      let newTop = e.clientY - parentRect.top - offsetY;

      // Constrain within parent
      newLeft = Math.max(0, Math.min(newLeft, parentRect.width - pipW));
      newTop = Math.max(0, Math.min(newTop, parentRect.height - pipH));

      pipContainer.style.left = newLeft + 'px';
      pipContainer.style.top = newTop + 'px';
      pipContainer.style.right = 'auto';
      pipContainer.style.bottom = 'auto';
    });

    pipContainer.addEventListener('pointerup', () => {
      dragging = false;
      pipContainer.classList.remove('pip-dragging');
    });
  })();

  // ---- PiP resize (bottom-left handle)
  (function initPipResize() {
    let resizing = false;
    let startX = 0;
    let startWidth = 0;

    pipResizeHandle.addEventListener('pointerdown', (e) => {
      resizing = true;
      startX = e.clientX;
      startWidth = pipContainer.offsetWidth;
      pipResizeHandle.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });

    pipResizeHandle.addEventListener('pointermove', (e) => {
      if (!resizing) return;
      const parent = pipContainer.parentElement;
      const maxW = parent.offsetWidth;
      const delta = startX - e.clientX; // dragging left = bigger
      let newWidth = Math.max(160, Math.min(startWidth + delta, maxW));
      pipContainer.style.width = newWidth + 'px';
    });

    pipResizeHandle.addEventListener('pointerup', () => {
      resizing = false;
    });
  })();

  // ---------------------------------------------------------------- Fetch helper

  async function fetchJson(url) {
    try {
      const resp = await fetch(url);
      if (resp.status === 401) {
        window.location.href = '/login';
        return null;
      }
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- Toast notifications

  function showToast(msg, duration) {
    duration = duration || 3000;
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    container.appendChild(el);
    requestAnimationFrame(() => el.classList.add('toast-visible'));
    setTimeout(() => {
      el.classList.remove('toast-visible');
      setTimeout(() => el.remove(), 300);
    }, duration);
  }

  // ---------------------------------------------------------------- Clip Recorder (WebCodecs + mp4-muxer)

  const CLIP_MAX_MEMORY = 300 * 1024 * 1024; // 300 MB hard cap
  const CLIP_CHUNK_INTERVAL = 2000; // keyframe interval ms

  // Check browser capabilities once
  const hasWebCodecs =
    typeof VideoEncoder !== 'undefined' &&
    typeof AudioEncoder !== 'undefined' &&
    typeof MediaStreamTrackProcessor !== 'undefined';
  const hasMediaRecorder =
    typeof MediaRecorder !== 'undefined' &&
    MediaRecorder.isTypeSupported &&
    MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus');
  const clipSupported = hasWebCodecs || hasMediaRecorder;

  class ClipRecorder {
    constructor(videoEl, maxSeconds) {
      this._video = videoEl;
      this._maxUs = maxSeconds * 1e6;
      this._videoChunks = [];
      this._audioChunks = [];
      this._totalBytes = 0;
      this._recording = false;
      this._videoEncoder = null;
      this._audioEncoder = null;
      this._videoProcessor = null;
      this._audioProcessor = null;
      this._stream = null;
      this._codecDesc = null;
      this._aborted = false;
      this._memoryWarned = false;
      this._recaptureTimer = null;
      this.format = 'mp4';
    }

    get recording() {
      return this._recording;
    }

    get bufferBytes() {
      return this._totalBytes;
    }

    get bufferDuration() {
      if (!this._videoChunks.length) return 0;
      const first = this._videoChunks[0].timestamp;
      const last = this._videoChunks[this._videoChunks.length - 1];
      return (last.timestamp + (last.duration || 0) - first) / 1e6;
    }

    set maxSeconds(val) {
      this._maxUs = val * 1e6;
      this._prune();
    }

    async start() {
      if (this._recording) return;
      this._aborted = false;
      this._memoryWarned = false;

      try {
        this._stream = this._video.captureStream();
      } catch {
        showToast('Clip: captureStream not supported');
        return;
      }

      const vTrack = this._stream.getVideoTracks()[0];
      const aTrack = this._stream.getAudioTracks()[0];
      if (!vTrack) {
        showToast('Clip: no video track available');
        return;
      }

      const settings = vTrack.getSettings();
      const width = settings.width || 1280;
      const height = settings.height || 720;

      // Video encoder
      this._videoEncoder = new VideoEncoder({
        output: (chunk, meta) => this._onVideoChunk(chunk, meta),
        error: (e) => this._onError(e),
      });
      this._videoEncoder.configure({
        codec: 'avc1.42001f', // H.264 Baseline L3.1
        width: width,
        height: height,
        bitrate: 2_500_000,
        framerate: 30,
        latencyMode: 'realtime',
        avc: { format: 'avc' },
      });

      // Video frame pump
      this._videoProcessor = new MediaStreamTrackProcessor({ track: vTrack });
      const videoReader = this._videoProcessor.readable.getReader();
      this._videoPump = this._pumpVideo(videoReader);

      // Audio encoder (optional — stream may not have audio)
      if (aTrack) {
        this._audioEncoder = new AudioEncoder({
          output: (chunk) => this._onAudioChunk(chunk),
          error: (e) => this._onError(e),
        });
        this._audioEncoder.configure({
          codec: 'mp4a.40.2', // AAC-LC
          numberOfChannels: 2,
          sampleRate: 48000,
          bitrate: 128_000,
        });
        this._audioProcessor = new MediaStreamTrackProcessor({ track: aTrack });
        const audioReader = this._audioProcessor.readable.getReader();
        this._audioPump = this._pumpAudio(audioReader);
      }

      this._recording = true;
    }

    stop() {
      this._recording = false;
      this._aborted = true;
      if (this._recaptureTimer) {
        clearTimeout(this._recaptureTimer);
        this._recaptureTimer = null;
      }
      try {
        this._videoEncoder && this._videoEncoder.close();
      } catch {}
      try {
        this._audioEncoder && this._audioEncoder.close();
      } catch {}
      this._videoEncoder = null;
      this._audioEncoder = null;
      this._videoProcessor = null;
      this._audioProcessor = null;
      if (this._stream) {
        this._stream.getTracks().forEach((t) => t.stop());
        this._stream = null;
      }
      this._videoChunks = [];
      this._audioChunks = [];
      this._totalBytes = 0;
      this._codecDesc = null;
    }

    getBufferedRange() {
      if (!this._videoChunks.length) return null;
      const first = this._videoChunks[0].timestamp / 1e6;
      const last = this._videoChunks[this._videoChunks.length - 1];
      return {
        start: first,
        end: (last.timestamp + (last.duration || 0)) / 1e6,
      };
    }

    async exportClip(startSec, endSec) {
      if (!this._videoChunks.length) {
        showToast('No clip data to export');
        return;
      }
      if (typeof Mp4Muxer === 'undefined') {
        showToast('mp4-muxer library not loaded');
        return;
      }

      const startUs = startSec * 1e6;
      const endUs = endSec * 1e6;

      // Find nearest keyframe at or before startUs
      let keyIdx = 0;
      for (let i = this._videoChunks.length - 1; i >= 0; i--) {
        if (
          this._videoChunks[i].isKey &&
          this._videoChunks[i].timestamp <= startUs
        ) {
          keyIdx = i;
          break;
        }
      }

      const baseTs = this._videoChunks[keyIdx].timestamp;
      const codecDesc = this._codecDesc;
      if (!codecDesc) {
        showToast('No codec description available — try recording longer');
        return;
      }

      const target = new Mp4Muxer.ArrayBufferTarget();
      const muxer = new Mp4Muxer.Muxer({
        target: target,
        video: {
          codec: 'avc',
          width: this._videoChunks[0].width || 1280,
          height: this._videoChunks[0].height || 720,
        },
        audio: this._audioChunks.length
          ? { codec: 'aac', numberOfChannels: 2, sampleRate: 48000 }
          : undefined,
        fastStart: 'in-memory',
      });

      // Add video chunks in range
      for (let i = keyIdx; i < this._videoChunks.length; i++) {
        const c = this._videoChunks[i];
        if (c.timestamp > endUs) break;
        const chunk = new EncodedVideoChunk({
          type: c.isKey ? 'key' : 'delta',
          timestamp: c.timestamp - baseTs,
          duration: c.duration,
          data: c.data,
        });
        muxer.addVideoChunk(
          chunk,
          c.isKey ? { decoderConfig: { description: codecDesc } } : undefined,
        );
      }

      // Add audio chunks in range
      if (this._audioChunks.length) {
        for (const c of this._audioChunks) {
          if (c.timestamp < this._videoChunks[keyIdx].timestamp) continue;
          if (c.timestamp > endUs) break;
          const chunk = new EncodedAudioChunk({
            type: 'key',
            timestamp: c.timestamp - baseTs,
            duration: c.duration,
            data: c.data,
          });
          muxer.addAudioChunk(chunk);
        }
      }

      muxer.finalize();
      const blob = new Blob([target.buffer], { type: 'video/mp4' });
      this._downloadBlob(blob, 'mp4');
    }

    _downloadBlob(blob, ext) {
      const name = this._clipFilename(ext);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 1000);
      showToast('Clip saved: ' + name);
    }

    _clipFilename(ext) {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const ts =
        d.getFullYear() +
        '-' +
        pad(d.getMonth() + 1) +
        '-' +
        pad(d.getDate()) +
        '_' +
        pad(d.getHours()) +
        '-' +
        pad(d.getMinutes()) +
        '-' +
        pad(d.getSeconds());
      const label = (currentStreamId || 'clip').replace(/[^a-zA-Z0-9_-]/g, '_');
      return 'ftview-' + label + '-' + ts + '.' + ext;
    }

    _onVideoChunk(chunk, meta) {
      if (this._aborted) return;
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);

      if (meta && meta.decoderConfig && meta.decoderConfig.description) {
        const desc = meta.decoderConfig.description;
        this._codecDesc = new Uint8Array(
          desc instanceof ArrayBuffer ? desc : desc.buffer || desc,
        );
        // Store dimensions from config if available
        if (meta.decoderConfig.codedWidth) {
          this._encWidth = meta.decoderConfig.codedWidth;
          this._encHeight = meta.decoderConfig.codedHeight;
        }
      }

      this._videoChunks.push({
        data: buf,
        timestamp: chunk.timestamp,
        duration: chunk.duration || 0,
        isKey: chunk.type === 'key',
        width: this._encWidth || 1280,
        height: this._encHeight || 720,
      });
      this._totalBytes += buf.byteLength;
      this._prune();
      this._checkMemory();
    }

    _onAudioChunk(chunk) {
      if (this._aborted) return;
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      this._audioChunks.push({
        data: buf,
        timestamp: chunk.timestamp,
        duration: chunk.duration || 0,
      });
      this._totalBytes += buf.byteLength;
    }

    _prune() {
      if (!this._videoChunks.length) return;
      const newest = this._videoChunks[this._videoChunks.length - 1].timestamp;
      const cutoff = newest - this._maxUs;

      // Prune video — keep from latest keyframe before cutoff
      let pruneIdx = 0;
      for (let i = 0; i < this._videoChunks.length; i++) {
        if (this._videoChunks[i].timestamp >= cutoff) break;
        if (this._videoChunks[i].isKey) pruneIdx = i;
      }
      if (pruneIdx > 0) {
        const removed = this._videoChunks.splice(0, pruneIdx);
        for (const c of removed) this._totalBytes -= c.data.byteLength;
      }

      // Prune audio before first remaining video chunk
      if (this._videoChunks.length && this._audioChunks.length) {
        const minTs = this._videoChunks[0].timestamp;
        let aPrune = 0;
        while (
          aPrune < this._audioChunks.length &&
          this._audioChunks[aPrune].timestamp < minTs
        ) {
          aPrune++;
        }
        if (aPrune > 0) {
          const removed = this._audioChunks.splice(0, aPrune);
          for (const c of removed) this._totalBytes -= c.data.byteLength;
        }
      }
    }

    _checkMemory() {
      if (this._totalBytes > CLIP_MAX_MEMORY && !this._memoryWarned) {
        this._memoryWarned = true;
        showToast(
          'Clip buffer memory limit reached — oldest data pruned',
          4000,
        );
        // Force aggressive prune
        this._maxUs = Math.max(this._maxUs * 0.7, 60e6);
        this._prune();
      }
    }

    _onError(e) {
      console.warn('ClipRecorder encoder error:', e);
      // Attempt recapture instead of stopping entirely
      if (!this._aborted && this._recording) {
        this._scheduleRecapture();
      }
    }

    async _pumpVideo(reader) {
      let frameCount = 0;
      while (true) {
        if (this._aborted) break;
        let result;
        try {
          result = await reader.read();
        } catch {
          break;
        }
        if (result.done) break;
        const frame = result.value;
        if (this._videoEncoder && this._videoEncoder.state === 'configured') {
          const isKey = frameCount % 60 === 0;
          try {
            this._videoEncoder.encode(frame, { keyFrame: isKey });
          } catch {
            frame.close();
            break;
          }
          frameCount++;
        }
        frame.close();
      }
      // Track ended (e.g., camera switch) — attempt recapture
      if (!this._aborted && this._recording) {
        this._scheduleRecapture();
      }
    }

    async _pumpAudio(reader) {
      while (true) {
        if (this._aborted) break;
        let result;
        try {
          result = await reader.read();
        } catch {
          break;
        }
        if (result.done) break;
        const data = result.value;
        if (this._audioEncoder && this._audioEncoder.state === 'configured') {
          try {
            this._audioEncoder.encode(data);
          } catch {
            data.close();
            break;
          }
        }
        data.close();
      }
      // Track ended — recapture handled by video pump
    }

    _scheduleRecapture() {
      if (this._recaptureTimer) return;
      this._recaptureTimer = setTimeout(() => {
        this._recaptureTimer = null;
        if (this._aborted || !this._recording) return;
        this._restartCapture();
      }, 500);
    }

    _restartCapture() {
      if (this._stream) {
        this._stream.getTracks().forEach((t) => t.stop());
        this._stream = null;
      }
      this._videoProcessor = null;
      this._audioProcessor = null;

      try {
        this._stream = this._video.captureStream();
      } catch {
        this._scheduleRecapture();
        return;
      }

      const vTrack = this._stream.getVideoTracks()[0];
      const aTrack = this._stream.getAudioTracks()[0];
      if (!vTrack) {
        this._scheduleRecapture();
        return;
      }

      const settings = vTrack.getSettings();
      const w = settings.width || 1280;
      const h = settings.height || 720;

      // Recreate video encoder if it errored/closed
      if (!this._videoEncoder || this._videoEncoder.state !== 'configured') {
        try {
          this._videoEncoder && this._videoEncoder.close();
        } catch {}
        this._videoEncoder = new VideoEncoder({
          output: (chunk, meta) => this._onVideoChunk(chunk, meta),
          error: (e) => this._onError(e),
        });
        this._videoEncoder.configure({
          codec: 'avc1.42001f',
          width: w,
          height: h,
          bitrate: 2_500_000,
          framerate: 30,
          latencyMode: 'realtime',
          avc: { format: 'avc' },
        });
      }

      this._videoProcessor = new MediaStreamTrackProcessor({ track: vTrack });
      const videoReader = this._videoProcessor.readable.getReader();
      this._videoPump = this._pumpVideo(videoReader);

      if (aTrack) {
        if (!this._audioEncoder || this._audioEncoder.state !== 'configured') {
          try {
            this._audioEncoder && this._audioEncoder.close();
          } catch {}
          this._audioEncoder = new AudioEncoder({
            output: (chunk) => this._onAudioChunk(chunk),
            error: (e) => this._onError(e),
          });
          this._audioEncoder.configure({
            codec: 'mp4a.40.2',
            numberOfChannels: 2,
            sampleRate: 48000,
            bitrate: 128_000,
          });
        }
        this._audioProcessor = new MediaStreamTrackProcessor({
          track: aTrack,
        });
        const audioReader = this._audioProcessor.readable.getReader();
        this._audioPump = this._pumpAudio(audioReader);
      }
    }
  }

  // Fix WebM duration metadata (MediaRecorder writes Infinity/unknown).
  // IMPORTANT: only scan within the EBML header (before the first Cluster
  // element 0x1F43B675) to avoid false-matching 0x4489 inside video data.
  async function fixWebmDuration(blob, durationMs) {
    const scanSize = Math.min(blob.size, 1024);
    const buf = await blob.slice(0, scanSize).arrayBuffer();
    const bytes = new Uint8Array(buf);

    // Find where the header ends — first Cluster element (0x1F43B675)
    let headerEnd = bytes.length;
    for (let i = 0; i < bytes.length - 3; i++) {
      if (
        bytes[i] === 0x1f &&
        bytes[i + 1] === 0x43 &&
        bytes[i + 2] === 0xb6 &&
        bytes[i + 3] === 0x75
      ) {
        headerEnd = i;
        break;
      }
    }

    // Search for Duration EBML element (ID: 0x4489) only within the header
    for (let i = 0; i < headerEnd - 2; i++) {
      if (bytes[i] === 0x44 && bytes[i + 1] === 0x89) {
        const sizeTag = bytes[i + 2];
        if (sizeTag === 0x88 && i + 11 <= blob.size) {
          // 8-byte float64 duration
          const fullBuf = await blob.arrayBuffer();
          new DataView(fullBuf).setFloat64(i + 3, durationMs);
          return new Blob([fullBuf], { type: blob.type });
        }
        if (sizeTag === 0x84 && i + 7 <= blob.size) {
          // 4-byte float32 duration
          const fullBuf = await blob.arrayBuffer();
          new DataView(fullBuf).setFloat32(i + 3, durationMs);
          return new Blob([fullBuf], { type: blob.type });
        }
      }
    }
    return blob; // Could not find Duration element — return as-is
  }

  // ---- Fallback: MediaRecorder → WebM (Firefox, older browsers)
  // Uses an offscreen canvas to capture video frames so the MediaRecorder
  // stream never breaks during HLS camera switches. Audio is routed through
  // Web Audio API for the same reason.

  // Persistent per-element audio routing (survives start/stop cycles)
  const _clipAudioNodes = new WeakMap();

  class ClipRecorderFallback {
    constructor(videoEl, maxSeconds) {
      this._video = videoEl;
      this._maxMs = maxSeconds * 1000;
      this._chunks = [];
      this._totalBytes = 0;
      this._recording = false;
      this._recorder = null;
      this._canvas = null;
      this._canvasCtx = null;
      this._drawRAF = null;
      this._audioDest = null;
      this._startTime = 0;
      this._headerBlob = null;
      this.format = 'webm';
    }

    get recording() {
      return this._recording;
    }

    get bufferBytes() {
      return this._totalBytes;
    }

    get bufferDuration() {
      if (!this._chunks.length) return 0;
      const first = this._chunks[0].time;
      const last = this._chunks[this._chunks.length - 1].time;
      return (last - first + 5000) / 1000; // each chunk is ~5s
    }

    set maxSeconds(val) {
      this._maxMs = val * 1000;
      this._prune();
    }

    async start() {
      if (this._recording) return;

      // Offscreen canvas mirrors the video element
      const w = this._video.videoWidth || 1280;
      const h = this._video.videoHeight || 720;
      this._canvas = document.createElement('canvas');
      this._canvas.width = w;
      this._canvas.height = h;
      this._canvasCtx = this._canvas.getContext('2d');

      // Begin drawing video frames to the canvas
      this._recording = true;
      this._drawFrame();

      // Canvas → MediaStream (video track is immune to HLS source changes)
      const canvasStream = this._canvas.captureStream(30);

      // Audio via Web Audio API (persists across camera switches)
      let hasAudio = false;
      try {
        let audioNode = _clipAudioNodes.get(this._video);
        if (!audioNode) {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const source = ctx.createMediaElementSource(this._video);
          source.connect(ctx.destination); // keep speakers working
          audioNode = { ctx, source };
          _clipAudioNodes.set(this._video, audioNode);
        } else if (audioNode.ctx.state === 'suspended') {
          await audioNode.ctx.resume();
        }
        this._audioDest = audioNode.ctx.createMediaStreamDestination();
        audioNode.source.connect(this._audioDest);
        const audioTrack = this._audioDest.stream.getAudioTracks()[0];
        if (audioTrack) {
          canvasStream.addTrack(audioTrack);
          hasAudio = true;
        }
      } catch (e) {
        console.warn('ClipRecorderFallback: audio capture unavailable', e);
      }

      // Pick a mimeType that matches the available tracks
      const mimeType = hasAudio
        ? 'video/webm;codecs=vp8,opus'
        : 'video/webm;codecs=vp8';

      this._startTime = Date.now();
      this._recorder = new MediaRecorder(canvasStream, {
        mimeType: mimeType,
        videoBitsPerSecond: 2_500_000,
      });

      this._recorder.ondataavailable = (e) => {
        if (!e.data || e.data.size === 0) return;
        if (!this._headerBlob) {
          this._extractHeader(e.data);
        } else {
          this._chunks.push({
            blob: e.data,
            time: Date.now(),
            size: e.data.size,
          });
          this._totalBytes += e.data.size;
          this._prune();
        }
      };
      this._recorder.onerror = (e) => {
        console.warn('ClipRecorderFallback recorder error:', e);
      };
      this._recorder.start(5000);
    }

    _drawFrame() {
      if (!this._recording) return;
      if (this._video.readyState >= 2) {
        const w = this._video.videoWidth || 1280;
        const h = this._video.videoHeight || 720;
        if (this._canvas.width !== w || this._canvas.height !== h) {
          this._canvas.width = w;
          this._canvas.height = h;
        }
        this._canvasCtx.drawImage(this._video, 0, 0, w, h);
      }
      this._drawRAF = requestAnimationFrame(() => this._drawFrame());
    }

    async _extractHeader(blob) {
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      // Search for first Cluster element (ID: 0x1F43B675)
      let clusterOffset = -1;
      for (let i = 0; i < bytes.length - 4; i++) {
        if (
          bytes[i] === 0x1f &&
          bytes[i + 1] === 0x43 &&
          bytes[i + 2] === 0xb6 &&
          bytes[i + 3] === 0x75
        ) {
          clusterOffset = i;
          break;
        }
      }
      if (clusterOffset > 0) {
        this._headerBlob = blob.slice(0, clusterOffset);
        const clusterBlob = blob.slice(clusterOffset);
        this._chunks.push({
          blob: clusterBlob,
          time: Date.now(),
          size: clusterBlob.size,
        });
        this._totalBytes += clusterBlob.size;
      } else {
        // Couldn't find Cluster boundary — use entire blob as header
        this._headerBlob = blob;
      }
    }

    stop() {
      this._recording = false;
      if (this._drawRAF) {
        cancelAnimationFrame(this._drawRAF);
        this._drawRAF = null;
      }
      if (this._recorder && this._recorder.state !== 'inactive') {
        try {
          this._recorder.stop();
        } catch {}
      }
      this._recorder = null;
      // Disconnect recording destination but keep speaker routing alive
      if (this._audioDest) {
        const audioNode = _clipAudioNodes.get(this._video);
        if (audioNode) {
          try {
            audioNode.source.disconnect(this._audioDest);
          } catch {}
        }
        this._audioDest = null;
      }
      this._canvas = null;
      this._canvasCtx = null;
      this._chunks = [];
      this._totalBytes = 0;
      this._headerBlob = null;
    }

    getBufferedRange() {
      if (!this._chunks.length) return null;
      const startSec = (this._chunks[0].time - this._startTime) / 1000;
      const lastChunk = this._chunks[this._chunks.length - 1];
      const endSec = (lastChunk.time - this._startTime + 5000) / 1000;
      return { start: startSec, end: endSec };
    }

    async exportClip() {
      if (!this._chunks.length || !this._headerBlob) {
        showToast('No clip data to export');
        return;
      }

      // Fix duration in the header blob only (safe — no video data in it)
      const durationMs = this.bufferDuration * 1000;
      const fixedHeader = await fixWebmDuration(this._headerBlob, durationMs);

      // Assemble: header + ALL data chunks in contiguous order.
      // WebM is a continuous byte stream — skipping chunks corrupts the file.
      const blob = new Blob([fixedHeader, ...this._chunks.map((c) => c.blob)], {
        type: 'video/webm',
      });

      const name = this._clipFilename();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 1000);
      showToast('Clip saved: ' + name);
    }

    _clipFilename() {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const ts =
        d.getFullYear() +
        '-' +
        pad(d.getMonth() + 1) +
        '-' +
        pad(d.getDate()) +
        '_' +
        pad(d.getHours()) +
        '-' +
        pad(d.getMinutes()) +
        '-' +
        pad(d.getSeconds());
      const label = (currentStreamId || 'clip').replace(/[^a-zA-Z0-9_-]/g, '_');
      return 'ftview-' + label + '-' + ts + '.webm';
    }

    _prune() {
      const now = Date.now();
      const cutoff = now - this._maxMs;
      while (this._chunks.length && this._chunks[0].time < cutoff) {
        const removed = this._chunks.shift();
        this._totalBytes -= removed.size;
      }
      if (this._totalBytes > CLIP_MAX_MEMORY) {
        showToast('Clip buffer memory limit — oldest data pruned', 4000);
        while (
          this._chunks.length > 1 &&
          this._totalBytes > CLIP_MAX_MEMORY * 0.7
        ) {
          const removed = this._chunks.shift();
          this._totalBytes -= removed.size;
        }
      }
    }
  }

  function createClipRecorder(videoEl, maxSeconds) {
    if (hasWebCodecs) return new ClipRecorder(videoEl, maxSeconds);
    if (hasMediaRecorder) return new ClipRecorderFallback(videoEl, maxSeconds);
    return null;
  }

  // ---------------------------------------------------------------- Clip UI state

  let mainRecorder = null;
  let pipRecorder = null;
  let clipDuration =
    parseInt(localStorage.getItem('ftview-clip-duration'), 10) || 300;
  let clipInfoTimer = null;

  function formatDuration(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(0) + ' MB';
  }

  function toggleClip(target) {
    if (target === 'pip') {
      if (pipRecorder && pipRecorder.recording) {
        pipRecorder.stop();
        pipRecorder = null;
        updateClipUI('pip');
      } else {
        pipRecorder = createClipRecorder(pipVideo, clipDuration);
        if (pipRecorder) {
          pipRecorder.start();
          updateClipUI('pip');
        }
      }
    } else {
      if (mainRecorder && mainRecorder.recording) {
        mainRecorder.stop();
        mainRecorder = null;
        updateClipUI('main');
      } else {
        mainRecorder = createClipRecorder(video, clipDuration);
        if (mainRecorder) {
          mainRecorder.start();
          updateClipUI('main');
        }
      }
    }
  }

  function updateClipUI(target) {
    const isMain = target === 'main';
    const recorder = isMain ? mainRecorder : pipRecorder;
    const toggleBtn = document.getElementById(
      isMain ? 'clip-toggle' : 'pip-clip-toggle',
    );
    const saveBtn = document.getElementById(
      isMain ? 'clip-save' : 'pip-clip-save',
    );
    const info = document.getElementById(
      isMain ? 'clip-info' : 'pip-clip-info',
    );

    if (!toggleBtn) return;

    const active = recorder && recorder.recording;
    toggleBtn.classList.toggle('clip-active', active);
    toggleBtn.title = active ? 'Stop clip buffer' : 'Start clip buffer';
    if (saveBtn) saveBtn.style.display = active ? '' : 'none';
    if (info) {
      info.style.display = active ? '' : 'none';
      if (active) updateClipInfo(target);
    }

    // Start/stop periodic info updates
    if (active && !clipInfoTimer) {
      clipInfoTimer = setInterval(() => {
        if (mainRecorder && mainRecorder.recording) updateClipInfo('main');
        if (pipRecorder && pipRecorder.recording) updateClipInfo('pip');
        if (
          (!mainRecorder || !mainRecorder.recording) &&
          (!pipRecorder || !pipRecorder.recording)
        ) {
          clearInterval(clipInfoTimer);
          clipInfoTimer = null;
        }
      }, 2000);
    }
  }

  function updateClipInfo(target) {
    const recorder = target === 'main' ? mainRecorder : pipRecorder;
    const info = document.getElementById(
      target === 'main' ? 'clip-info' : 'pip-clip-info',
    );
    if (!recorder || !info) return;
    const dur = recorder.bufferDuration;
    const bytes = recorder.bufferBytes;
    info.textContent = '~' + formatBytes(bytes) + ' | ' + formatDuration(dur);
  }

  function onClipDurationChange(value) {
    clipDuration = parseInt(value, 10);
    localStorage.setItem('ftview-clip-duration', String(clipDuration));
    if (mainRecorder) mainRecorder.maxSeconds = clipDuration;
    if (pipRecorder) pipRecorder.maxSeconds = clipDuration;
  }

  // ---------------------------------------------------------------- Clip export modal

  let clipModalTarget = null; // 'main' or 'pip'

  function openClipModal(target) {
    clipModalTarget = target;
    const recorder = target === 'main' ? mainRecorder : pipRecorder;
    if (!recorder) return;

    const range = recorder.getBufferedRange();
    if (!range) {
      showToast('No clip data buffered yet');
      return;
    }

    const modal = document.getElementById('clip-modal');
    const timeline = document.getElementById('clip-timeline');
    const startHandle = document.getElementById('clip-handle-start');
    const endHandle = document.getElementById('clip-handle-end');
    const rangeDisplay = document.getElementById('clip-range-display');
    const formatBadge = document.getElementById('clip-format-badge');

    const dur = range.end - range.start;
    formatBadge.textContent = recorder.format.toUpperCase();

    // WebM cannot be trimmed at the byte level — hide handles
    const isWebm = recorder.format === 'webm';
    startHandle.style.display = isWebm ? 'none' : '';
    endHandle.style.display = isWebm ? 'none' : '';

    // State for handles (0-1 normalized)
    let startPct = 0;
    let endPct = 1;

    function updateUI() {
      startHandle.style.left = startPct * 100 + '%';
      endHandle.style.left = endPct * 100 + '%';
      timeline.style.setProperty('--sel-start', startPct * 100 + '%');
      timeline.style.setProperty('--sel-end', endPct * 100 + '%');
      const s = range.start + startPct * dur;
      const e = range.start + endPct * dur;
      const selDur = e - s;
      if (isWebm) {
        rangeDisplay.textContent =
          'Full buffer: ' + formatDuration(dur) + ' (WebM \u2014 no trim)';
      } else {
        rangeDisplay.textContent =
          formatDuration(s) +
          ' \u2013 ' +
          formatDuration(e) +
          ' (' +
          formatDuration(selDur) +
          ')';
      }
    }

    // Drag logic for handles
    function makeDraggable(handle, getPct, setPct) {
      function onDown(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        const bar = timeline;
        const barRect = bar.getBoundingClientRect();

        function onMove(e) {
          const x =
            (e.touches ? e.touches[0].clientX : e.clientX) - barRect.left;
          let pct = Math.max(0, Math.min(1, x / barRect.width));
          setPct(pct);
          updateUI();
        }
        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          document.removeEventListener('touchmove', onMove);
          document.removeEventListener('touchend', onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
      }
      handle.addEventListener('mousedown', onDown);
      handle.addEventListener('touchstart', onDown, { passive: false });
      handle._clipCleanup = () => {
        handle.removeEventListener('mousedown', onDown);
        handle.removeEventListener('touchstart', onDown);
      };
    }

    makeDraggable(
      startHandle,
      () => startPct,
      (v) => {
        startPct = Math.min(v, endPct - 0.01);
      },
    );
    makeDraggable(
      endHandle,
      () => endPct,
      (v) => {
        endPct = Math.max(v, startPct + 0.01);
      },
    );

    updateUI();
    modal.classList.remove('clip-modal-hidden');
  }

  function closeClipModal() {
    const modal = document.getElementById('clip-modal');
    modal.classList.add('clip-modal-hidden');
    // Clean up drag handlers
    const startHandle = document.getElementById('clip-handle-start');
    const endHandle = document.getElementById('clip-handle-end');
    if (startHandle && startHandle._clipCleanup) startHandle._clipCleanup();
    if (endHandle && endHandle._clipCleanup) endHandle._clipCleanup();
    clipModalTarget = null;
  }

  function downloadClip() {
    const recorder = clipModalTarget === 'main' ? mainRecorder : pipRecorder;
    if (!recorder) return;
    const range = recorder.getBufferedRange();
    if (!range) return;

    if (recorder.format === 'webm') {
      // WebM: export full buffer (byte-level trimming corrupts the stream)
      recorder.exportClip();
    } else {
      // MP4: use selected range from timeline handles
      const timeline = document.getElementById('clip-timeline');
      const dur = range.end - range.start;
      const startPctStr = timeline.style.getPropertyValue('--sel-start');
      const endPctStr = timeline.style.getPropertyValue('--sel-end');
      const startPct = parseFloat(startPctStr) / 100 || 0;
      const endPct = parseFloat(endPctStr) / 100 || 1;

      const startSec = range.start + startPct * dur;
      const endSec = range.start + endPct * dur;

      recorder.exportClip(startSec, endSec);
    }
    closeClipModal();
  }

  // ---------------------------------------------------------------- Clip controls init

  function initClipControls() {
    if (!clipSupported) {
      // Hide all clip UI if browser doesn't support either path
      const els = document.querySelectorAll('.clip-controls');
      els.forEach((el) => (el.style.display = 'none'));
      return;
    }

    // Main clip toggle
    const mainToggle = document.getElementById('clip-toggle');
    if (mainToggle)
      mainToggle.addEventListener('click', () => toggleClip('main'));

    // Main save
    const mainSave = document.getElementById('clip-save');
    if (mainSave)
      mainSave.addEventListener('click', () => openClipModal('main'));

    // PiP clip toggle
    const pipToggle = document.getElementById('pip-clip-toggle');
    if (pipToggle) {
      pipToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleClip('pip');
      });
    }

    // PiP save
    const pipSave = document.getElementById('pip-clip-save');
    if (pipSave) {
      pipSave.addEventListener('click', (e) => {
        e.stopPropagation();
        openClipModal('pip');
      });
    }

    // Duration dropdown
    const durationSelect = document.getElementById('clip-duration');
    if (durationSelect) {
      durationSelect.value = String(clipDuration);
      durationSelect.addEventListener('change', () =>
        onClipDurationChange(durationSelect.value),
      );
    }

    // Modal controls
    const modalCancel = document.getElementById('clip-modal-cancel');
    if (modalCancel) modalCancel.addEventListener('click', closeClipModal);

    const modalDownload = document.getElementById('clip-modal-download');
    if (modalDownload) modalDownload.addEventListener('click', downloadClip);

    // Escape to close modal
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && clipModalTarget !== null) closeClipModal();
    });

    // Initialize display state
    updateClipUI('main');
    updateClipUI('pip');
  }

  // ---------------------------------------------------------------- Boot

  function setQuality(quality, target) {
    if (target === 'pip') {
      pipQuality = quality;
      localStorage.setItem('ftview-pip-quality', quality);
      updateQualityButtons('pip');
      // Reload PiP stream at new quality without toggling pin state
      if (pipStreamId && pipHls) {
        pipHls.loadSource(hlsUrl(pipStreamId, pipQuality));
      } else if (
        pipStreamId &&
        pipVideo.canPlayType('application/vnd.apple.mpegurl')
      ) {
        pipVideo.src = hlsUrl(pipStreamId, pipQuality);
      }
    } else {
      currentQuality = quality;
      localStorage.setItem('ftview-quality', quality);
      updateQualityButtons('main');
      if (currentStreamId) loadHls(hlsUrl(currentStreamId, currentQuality));
    }
  }

  function updateQualityButtons(target) {
    const containerId =
      target === 'pip' ? 'pip-quality-controls' : 'quality-controls';
    const active = target === 'pip' ? pipQuality : currentQuality;
    const container = document.getElementById(containerId);
    if (!container) return;
    container.querySelectorAll('.quality-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.quality === active);
    });
  }

  function initQualityControls() {
    document
      .querySelectorAll('#quality-controls .quality-btn')
      .forEach((btn) => {
        btn.addEventListener('click', () =>
          setQuality(btn.dataset.quality, 'main'),
        );
      });
    document
      .querySelectorAll('#pip-quality-controls .quality-btn')
      .forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          setQuality(btn.dataset.quality, 'pip');
        });
      });
    updateQualityButtons('main');
    updateQualityButtons('pip');
  }

  document.addEventListener('DOMContentLoaded', () => {
    initQualityControls();
    initClipControls();
    init();
  });
})();
