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

  const THUMBNAIL_REFRESH_MS = 30_000;

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
      card.addEventListener('click', () => switchStream(stream.id));

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

    // Fetch HLS URL
    const data = await fetchJson(
      '/api/stream-url/' + encodeURIComponent(streamId),
    );
    if (!data || !data.url) return;

    loadHls(data.url);

    // Load clickable zones if the stream is interactive
    if (stream && stream.interactive) {
      const zones = await fetchJson(
        '/api/zones/' + encodeURIComponent(streamId),
      );
      renderZones(zones);
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

  // ---------------------------------------------------------------- Boot

  document.addEventListener('DOMContentLoaded', init);
})();
