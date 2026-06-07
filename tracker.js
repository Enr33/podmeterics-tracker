/**
 * PodMetrics Tracker v1.0
 * Embed: <script src="tracker.js" data-show-id="YOUR_SHOW_ID"></script>
 * Then wrap any <audio> with data-pm-episode and data-pm-title attributes.
 *
 * Events fired to your /collect endpoint:
 *   play, pause, seek, complete, heartbeat (every 10s), unload
 *
 * No cookies. Visitor ID stored in localStorage.
 * GDPR-friendly: no PII collected.
 */

(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────────
  const SCRIPT_TAG   = document.currentScript;
  const SHOW_ID      = SCRIPT_TAG?.dataset?.showId || 'unknown';
  const ENDPOINT     = SCRIPT_TAG?.dataset?.endpoint || 'https://your-server.com/collect';
  const HEARTBEAT_S  = parseInt(SCRIPT_TAG?.dataset?.heartbeat || '10', 10);
  const DEBUG        = SCRIPT_TAG?.dataset?.debug === 'true';

  // ── Visitor ID (anonymous, no PII) ─────────────────────────────────────────
  function getVisitorId() {
    const KEY = '_pm_vid';
    try {
      let vid = localStorage.getItem(KEY);
      if (!vid) {
        vid = 'v_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        localStorage.setItem(KEY, vid);
      }
      return vid;
    } catch (_) {
      // Private browsing fallback — session-only ID
      return 'v_' + Math.random().toString(36).slice(2, 10);
    }
  }

  const VISITOR_ID = getVisitorId();

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function log(...args) { if (DEBUG) console.log('[PodMetrics]', ...args); }

  function fmtTime(secs) {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function getDevice() {
    const ua = navigator.userAgent;
    if (/android|iphone|ipad|mobile/i.test(ua)) return 'mobile';
    if (/macintosh|windows|linux/i.test(ua)) return 'desktop';
    return 'unknown';
  }

  // ── Send event ───────────────────────────────────────────────────────────────
  function send(eventName, episodeId, episodeTitle, payload = {}) {
    const data = {
      event:        eventName,
      show_id:      SHOW_ID,
      episode_id:   episodeId,
      episode_title: episodeTitle,
      visitor_id:   VISITOR_ID,
      url:          location.href,
      referrer:     document.referrer || '(direct)',
      device:       getDevice(),
      ua:           navigator.userAgent,
      lang:         navigator.language,
      tz:           Intl.DateTimeFormat().resolvedOptions().timeZone,
      ts:           Date.now(),
      ...payload,
    };

    log(eventName, data);

    // Use sendBeacon when available (fire-and-forget, survives page unload)
    if (navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      navigator.sendBeacon(ENDPOINT, blob);
    } else {
      // Fallback: sync XHR (needed for unload events in older browsers)
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', ENDPOINT, false); // false = synchronous
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(JSON.stringify(data));
      } catch (_) {}
    }
  }

  // ── Per-audio tracker ────────────────────────────────────────────────────────
  function attachTracker(audio) {
    const episodeId    = audio.dataset.pmEpisode || audio.src?.split('/').pop() || 'unknown';
    const episodeTitle = audio.dataset.pmTitle   || document.title;

    let sessionStart    = null;   // wall-clock time when play started
    let listenedSeconds = 0;      // total seconds listened this session
    let lastPosition    = 0;      // position before a seek
    let heartbeatTimer  = null;
    let completed       = false;

    // Retention map: array of booleans per second — was this second heard?
    const durationSecs  = () => Math.floor(audio.duration || 0);
    let retention       = [];

    function buildRetention() {
      if (!retention.length && durationSecs() > 0) {
        retention = new Array(durationSecs() + 1).fill(false);
      }
    }

    function markRetention() {
      buildRetention();
      const pos = Math.floor(audio.currentTime);
      if (retention[pos] !== undefined) retention[pos] = true;
    }

    function retentionSummary() {
      if (!retention.length) return {};
      const total   = retention.length;
      const heard   = retention.filter(Boolean).length;
      const pct     = Math.round((heard / total) * 100);
      // Build bucketed curve: % heard per 10-second bucket
      const buckets = [];
      for (let i = 0; i < total; i += 10) {
        const slice    = retention.slice(i, i + 10);
        const heardSlice = slice.filter(Boolean).length;
        buckets.push(Math.round((heardSlice / slice.length) * 100));
      }
      return { pct_heard: pct, buckets };
    }

    function startHeartbeat() {
      if (heartbeatTimer) return;
      heartbeatTimer = setInterval(() => {
        markRetention();
        listenedSeconds += HEARTBEAT_S;
        send('heartbeat', episodeId, episodeTitle, {
          position_s:      Math.floor(audio.currentTime),
          position_fmt:    fmtTime(audio.currentTime),
          listened_s:      listenedSeconds,
          duration_s:      durationSecs(),
        });
      }, HEARTBEAT_S * 1000);
    }

    function stopHeartbeat() {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    // ── Event listeners ─────────────────────────────────────────────────────────

    audio.addEventListener('play', () => {
      sessionStart = Date.now();
      buildRetention();
      startHeartbeat();
      send('play', episodeId, episodeTitle, {
        position_s:   Math.floor(audio.currentTime),
        position_fmt: fmtTime(audio.currentTime),
        duration_s:   durationSecs(),
      });
    });

    audio.addEventListener('pause', () => {
      markRetention();
      stopHeartbeat();
      if (sessionStart) {
        listenedSeconds += (Date.now() - sessionStart) / 1000;
        sessionStart = null;
      }
      send('pause', episodeId, episodeTitle, {
        position_s:   Math.floor(audio.currentTime),
        position_fmt: fmtTime(audio.currentTime),
        listened_s:   Math.round(listenedSeconds),
        duration_s:   durationSecs(),
        ...retentionSummary(),
      });
    });

    audio.addEventListener('seeked', () => {
      const newPos = Math.floor(audio.currentTime);
      send('seek', episodeId, episodeTitle, {
        from_s:   lastPosition,
        from_fmt: fmtTime(lastPosition),
        to_s:     newPos,
        to_fmt:   fmtTime(newPos),
        skipped_s: newPos - lastPosition, // negative = rewound
      });
      lastPosition = newPos;
    });

    audio.addEventListener('timeupdate', () => {
      markRetention();
      lastPosition = Math.floor(audio.currentTime);
    });

    audio.addEventListener('ended', () => {
      if (completed) return;
      completed = true;
      stopHeartbeat();
      if (sessionStart) {
        listenedSeconds += (Date.now() - sessionStart) / 1000;
        sessionStart = null;
      }
      send('complete', episodeId, episodeTitle, {
        listened_s:  Math.round(listenedSeconds),
        duration_s:  durationSecs(),
        ...retentionSummary(),
      });
    });

    // Rate change (e.g. 1.5x speed) — useful insight
    audio.addEventListener('ratechange', () => {
      send('rate_change', episodeId, episodeTitle, {
        playback_rate: audio.playbackRate,
        position_s:    Math.floor(audio.currentTime),
      });
    });

    // ── Unload: flush remaining data ────────────────────────────────────────────
    function onUnload() {
      if (audio.paused) return; // already paused, pause event already fired
      stopHeartbeat();
      if (sessionStart) listenedSeconds += (Date.now() - sessionStart) / 1000;
      send('unload', episodeId, episodeTitle, {
        position_s:  Math.floor(audio.currentTime),
        listened_s:  Math.round(listenedSeconds),
        duration_s:  durationSecs(),
        ...retentionSummary(),
      });
    }

    window.addEventListener('pagehide',        onUnload);
    window.addEventListener('beforeunload',    onUnload);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') onUnload();
    });

    log(`Attached to episode: "${episodeTitle}" (${episodeId})`);
  }

  // ── Auto-discover all audio elements on the page ─────────────────────────────
  function discover() {
    document.querySelectorAll('audio[data-pm-episode]').forEach(el => {
      if (!el.dataset.pmAttached) {
        el.dataset.pmAttached = 'true';
        attachTracker(el);
      }
    });
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', discover);
  } else {
    discover();
  }

  // Watch for dynamically added players (e.g. React-rendered)
  const observer = new MutationObserver(discover);
  observer.observe(document.body, { childList: true, subtree: true });

  // ── Expose manual API for custom players ────────────────────────────────────
  window.PodMetrics = {
    /** Manually track a custom player — call this with your own player element */
    attach: attachTracker,
    /** Send a one-off event from your own code */
    track: send,
    /** Current visitor ID */
    visitorId: VISITOR_ID,
  };

  log(`PodMetrics loaded. Show: ${SHOW_ID}, Endpoint: ${ENDPOINT}`);

})();
