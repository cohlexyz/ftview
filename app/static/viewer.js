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

  // ---------------------------------------------------------------- Clip state

  const clipRecordBtn = document.getElementById('clip-record-btn');
  const clipBufferIndicator = document.getElementById('clip-buffer-indicator');
  const clipTrimBtn = document.getElementById('clip-trim-btn');
  const clipDurationSelect = document.getElementById('clip-duration-select');

  const pipClipRecordBtn = document.getElementById('pip-clip-record-btn');
  const pipClipIndicator = document.getElementById('pip-clip-buffer-indicator');
  const pipClipTrimBtn = document.getElementById('pip-clip-trim-btn');

  let clipPollingTimer = null;
  let clipStatus = { main: null, pip: null };

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

    // If clip buffer is recording, switch it to the new camera
    if (clipStatus.main && clipStatus.main.recording) {
      fetch('/api/clip/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'main', stream_id: streamId }),
      }).catch(() => {});
    }

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

  function loadHls(url) {
    if (hls) {
      hls.destroy();
      hls = null;
    }

    if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 5,
        maxBufferLength: 10,
        backBufferLength: 5,
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        loadVolume();
        video.play().catch(() => {}); // autoplay may be blocked
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad();
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
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

    // If pip clip buffer is recording, switch it to the new camera
    if (clipStatus.pip && clipStatus.pip.recording) {
      fetch('/api/clip/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'pip', stream_id: streamId }),
      }).catch(() => {});
    }

    pipStreamId = streamId;
    const stream = streamById(streamId);
    pipLabel.textContent = stream ? stream.name : streamId;

    // Destroy previous PiP HLS instance
    if (pipHls) {
      pipHls.destroy();
      pipHls = null;
    }

    const url = hlsUrl(streamId, pipQuality);

    if (Hls.isSupported()) {
      pipHls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 5,
        maxBufferLength: 10,
        backBufferLength: 5,
      });
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
        }
      });
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
    // Stop pip clip buffer if recording
    if (clipStatus.pip && clipStatus.pip.recording) {
      toggleClipRecording('pip');
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
          '#pip-close, #pip-mute, #pip-resize-handle, #pip-quality-controls',
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

  // ---------------------------------------------------------------- Clip recording

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  async function toggleClipRecording(target) {
    const buf = clipStatus[target];
    const isRecording = buf && buf.recording;

    if (isRecording) {
      // Stop
      await fetch('/api/clip/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      }).catch(() => {});
    } else {
      // Start
      const streamId = target === 'pip' ? pipStreamId : currentStreamId;
      if (!streamId) return;
      const maxDuration =
        target === 'main' ? parseInt(clipDurationSelect.value, 10) : 120;
      await fetch('/api/clip/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target,
          stream_id: streamId,
          max_duration: maxDuration,
        }),
      }).catch(() => {});
    }
    // Immediately poll for updated status
    await pollClipStatus();
  }

  async function pollClipStatus() {
    const data = await fetchJson('/api/clip/status');
    if (!data) return;
    clipStatus = data;
    updateClipUI('main');
    updateClipUI('pip');
  }

  function updateClipUI(target) {
    const s = clipStatus[target];
    if (target === 'main') {
      if (s && s.recording) {
        clipRecordBtn.classList.add('recording');
        clipRecordBtn.textContent = '\u23F9'; // stop
        clipRecordBtn.title = 'Stop clip buffer';
        clipBufferIndicator.textContent =
          formatTime(s.buffered_seconds) + ' / ' + formatTime(s.max_duration);
        clipTrimBtn.disabled = s.segment_count === 0;
      } else {
        clipRecordBtn.classList.remove('recording');
        clipRecordBtn.textContent = '\u23FA'; // record
        clipRecordBtn.title = 'Start clip buffer';
        clipBufferIndicator.textContent = '';
        clipTrimBtn.disabled = true;
      }
    } else {
      if (s && s.recording) {
        pipClipRecordBtn.classList.add('recording');
        pipClipRecordBtn.textContent = '\u23F9';
        pipClipIndicator.textContent = formatTime(s.buffered_seconds);
        pipClipTrimBtn.disabled = s.segment_count === 0;
      } else {
        pipClipRecordBtn.classList.remove('recording');
        pipClipRecordBtn.textContent = '\u23FA';
        pipClipIndicator.textContent = '';
        pipClipTrimBtn.disabled = true;
      }
    }
  }

  function startClipPolling() {
    stopClipPolling();
    pollClipStatus();
    clipPollingTimer = setInterval(pollClipStatus, 2000);
  }

  function stopClipPolling() {
    if (clipPollingTimer) {
      clearInterval(clipPollingTimer);
      clipPollingTimer = null;
    }
  }

  function isAnyBufferRecording() {
    return (
      (clipStatus.main && clipStatus.main.recording) ||
      (clipStatus.pip && clipStatus.pip.recording)
    );
  }

  // Clip button event listeners
  clipRecordBtn.addEventListener('click', () => toggleClipRecording('main'));
  clipTrimBtn.addEventListener('click', () => openTrimModal('main'));

  pipClipRecordBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleClipRecording('pip');
  });
  pipClipTrimBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openTrimModal('pip');
  });

  // ---------------------------------------------------------------- Trim modal

  const trimModal = document.getElementById('trim-modal');
  const trimBackdrop = document.getElementById('trim-modal-backdrop');
  const trimCancelBtn = document.getElementById('trim-cancel-btn');
  const trimSaveBtn = document.getElementById('trim-save-btn');
  const trimStartThumb = document.getElementById('trim-start-thumb');
  const trimEndThumb = document.getElementById('trim-end-thumb');
  const trimStartTime = document.getElementById('trim-start-time');
  const trimEndTime = document.getElementById('trim-end-time');
  const trimDurationLabel = document.getElementById('trim-duration-label');
  const trimTrack = document.getElementById('trim-track');
  const trimSelection = document.getElementById('trim-selection');
  const trimHandleStart = document.getElementById('trim-handle-start');
  const trimHandleEnd = document.getElementById('trim-handle-end');
  const trimProgress = document.getElementById('trim-progress');

  let trimTarget = 'main';
  let trimTotalSeconds = 0;
  let trimStartSec = 0;
  let trimEndSec = 0;
  let thumbDebounceTimer = null;

  async function openTrimModal(target) {
    // Fetch fresh status so trimTotalSeconds reflects actual buffer content
    await pollClipStatus();
    const s = clipStatus[target];
    if (!s || s.segment_count === 0) return;

    trimTarget = target;
    trimTotalSeconds = s.buffered_seconds;
    trimStartSec = 0;
    trimEndSec = trimTotalSeconds;

    // Reset handles
    trimHandleStart.style.left = '0%';
    trimHandleEnd.style.left = '100%';
    updateTrimSelection();
    updateTrimLabels();

    // Load initial thumbnails
    loadTrimThumbnail('start', 0);
    loadTrimThumbnail('end', trimTotalSeconds);

    trimProgress.classList.add('trim-progress-hidden');
    trimSaveBtn.disabled = false;
    trimModal.classList.remove('trim-modal-hidden');
  }

  function closeTrimModal() {
    trimModal.classList.add('trim-modal-hidden');
  }

  function updateTrimSelection() {
    const startPct = (trimStartSec / trimTotalSeconds) * 100;
    const endPct = (trimEndSec / trimTotalSeconds) * 100;
    trimSelection.style.left = startPct + '%';
    trimSelection.style.width = endPct - startPct + '%';
  }

  function updateTrimLabels() {
    trimStartTime.textContent = formatTime(trimStartSec);
    trimEndTime.textContent = formatTime(trimEndSec);
    const dur = Math.max(0, trimEndSec - trimStartSec);
    trimDurationLabel.textContent = 'Duration: ' + formatTime(dur);
  }

  function loadTrimThumbnail(which, timeSec) {
    const img = which === 'start' ? trimStartThumb : trimEndThumb;
    const url =
      '/api/clip/thumbnail?target=' +
      encodeURIComponent(trimTarget) +
      '&time=' +
      timeSec.toFixed(2);
    img.src = url;
  }

  function scheduleThumbLoad(which, timeSec) {
    clearTimeout(thumbDebounceTimer);
    thumbDebounceTimer = setTimeout(() => {
      loadTrimThumbnail(which, timeSec);
    }, 300);
  }

  // ---- Handle dragging
  (function initTrimHandles() {
    let activeHandle = null;

    function onPointerDown(e) {
      activeHandle = e.currentTarget.dataset.handle;
      e.currentTarget.classList.add('dragging');
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
    }

    function onPointerMove(e) {
      if (!activeHandle) return;
      const rect = trimTrack.getBoundingClientRect();
      let pct = (e.clientX - rect.left) / rect.width;
      pct = Math.max(0, Math.min(1, pct));
      const timeSec = pct * trimTotalSeconds;

      if (activeHandle === 'start') {
        trimStartSec = Math.min(timeSec, trimEndSec - 0.5);
        trimStartSec = Math.max(0, trimStartSec);
        trimHandleStart.style.left =
          (trimStartSec / trimTotalSeconds) * 100 + '%';
        scheduleThumbLoad('start', trimStartSec);
      } else {
        trimEndSec = Math.max(timeSec, trimStartSec + 0.5);
        trimEndSec = Math.min(trimTotalSeconds, trimEndSec);
        trimHandleEnd.style.left = (trimEndSec / trimTotalSeconds) * 100 + '%';
        scheduleThumbLoad('end', trimEndSec);
      }
      updateTrimSelection();
      updateTrimLabels();
    }

    function onPointerUp(e) {
      if (!activeHandle) return;
      const handle = activeHandle === 'start' ? trimHandleStart : trimHandleEnd;
      handle.classList.remove('dragging');
      // Final thumbnail load (immediate)
      if (activeHandle === 'start') {
        loadTrimThumbnail('start', trimStartSec);
      } else {
        loadTrimThumbnail('end', trimEndSec);
      }
      activeHandle = null;
    }

    trimHandleStart.addEventListener('pointerdown', onPointerDown);
    trimHandleEnd.addEventListener('pointerdown', onPointerDown);
    trimHandleStart.addEventListener('pointermove', onPointerMove);
    trimHandleEnd.addEventListener('pointermove', onPointerMove);
    trimHandleStart.addEventListener('pointerup', onPointerUp);
    trimHandleEnd.addEventListener('pointerup', onPointerUp);
  })();

  // ---- Save clip
  async function saveClip() {
    trimSaveBtn.disabled = true;
    trimProgress.classList.remove('trim-progress-hidden');

    try {
      const resp = await fetch('/api/clip/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: trimTarget,
          start_time: trimStartSec,
          end_time: trimEndSec,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => null);
        alert('Export failed: ' + (err ? err.detail : resp.statusText));
        return;
      }

      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'clip_' + trimTarget + '.mp4';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      closeTrimModal();
    } catch (err) {
      alert('Export error: ' + err.message);
    } finally {
      trimSaveBtn.disabled = false;
      trimProgress.classList.add('trim-progress-hidden');
    }
  }

  trimSaveBtn.addEventListener('click', saveClip);
  trimCancelBtn.addEventListener('click', closeTrimModal);
  trimBackdrop.addEventListener('click', closeTrimModal);

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
    startClipPolling();
    init();
  });
})();
