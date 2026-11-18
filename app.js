/* Apex Pulse - a device pulse and a keep-alive watch list, all in the tab.
 *
 *   setTimeout drift   -> event loop lag, charted every 250 ms
 *   requestAnimationFrame -> frames per second
 *   navigator.*        -> battery, network, storage, memory, screen
 *   fetch(no-cors)     -> reached / unreachable plus round-trip time
 *
 * A page cannot keep a server alive once the tab is closed, and a browser
 * hides status codes of cross-origin replies. Both limits are shown in the UI
 * rather than papered over.
 *
 *   localStorage  apex.pulse.v1  { watches, interval, log }
 */
(function () {
  'use strict';

  var KEY = 'apex.pulse.v1';
  var LAG_MS = 250;
  var SAMPLE_COUNT = 240;        // one minute of lag, at 250 ms
  var LOG_MAX = 200;
  var PROBE_TIMEOUT = 6000;
  var SYSTEM_MS = 2000;

  var el = {
    statLine: document.getElementById('statLine'),
    netPill: document.getElementById('netPill'),
    wakeBtn: document.getElementById('wakeBtn'),
    updated: document.getElementById('updated'),
    tiles: document.getElementById('tiles'),
    lagNow: document.getElementById('lagNow'),
    chart: document.getElementById('chart'),
    interval: document.getElementById('interval'),
    watchForm: document.getElementById('watchForm'),
    watchName: document.getElementById('watchName'),
    watchUrl: document.getElementById('watchUrl'),
    watchList: document.getElementById('watchList'),
    watchEmpty: document.getElementById('watchEmpty'),
    logList: document.getElementById('logList'),
    logEmpty: document.getElementById('logEmpty'),
    exportLog: document.getElementById('exportLog'),
    clearLog: document.getElementById('clearLog'),
    toast: document.getElementById('toast')
  };

  var ctx = el.chart.getContext('2d');

  var state = {
    watches: [],
    interval: 0,
    log: []
  };

  var metrics = {
    battery: null,
    network: null,
    storage: null,
    memory: null,
    screen: null,
    nav: null,
    fps: 0,
    lag: 0,
    online: navigator.onLine
  };

  var lags = [];
  var results = {};
  var sessionStart = Date.now();
  var saveTimer = 0;
  var probeTimer = 0;
  var sysTimer = 0;
  var frameCount = 0;
  var frameWindowStart = 0;
  var lagExpected = 0;
  var wakeSentinel = null;
  var wakeWanted = false;

  /* ---------- helpers ---------- */

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { el.toast.hidden = true; }, 3400);
  }

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function clock(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  function stamp(date) {
    return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  }

  function bytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    var value = n / Math.pow(1024, i);
    return (value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)) + ' ' + units[i];
  }

  function shortUrl(url) {
    return String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  }

  /* ---------- storage ---------- */

  function normalizeWatch(raw) {
    var url = raw && typeof raw.url === 'string' ? raw.url.trim() : '';
    if (!/^https?:\/\//i.test(url)) return null;
    var name = raw && typeof raw.name === 'string' ? raw.name.trim().slice(0, 24) : '';
    return {
      id: raw && raw.id ? String(raw.id) : uid(),
      name: name || shortUrl(url).slice(0, 24),
      url: url
    };
  }

  function load() {
    var raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    } catch (err) {
      raw = null;
    }
    if (!raw || typeof raw !== 'object') raw = {};

    state.watches = (Array.isArray(raw.watches) ? raw.watches : []).map(normalizeWatch).filter(Boolean).slice(0, 24);

    var every = Number(raw.interval);
    state.interval = every === 30 || every === 60 || every === 300 ? every : 0;

    state.log = (Array.isArray(raw.log) ? raw.log : []).filter(function (entry) {
      return entry && typeof entry === 'object' && typeof entry.t === 'string';
    }).slice(0, LOG_MAX);

    for (var i = state.log.length - 1; i >= 0; i--) {
      var entry = state.log[i];
      if (entry.id && !results[entry.id]) {
        results[entry.id] = { ok: !!entry.ok, ms: Number(entry.ms) || 0, note: entry.note || '', at: entry.t };
      }
    }
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        localStorage.setItem(KEY, JSON.stringify(state));
      } catch (err) {
        toast('Could not save - device storage may be full');
      }
    }, 250);
  }

  /* ---------- system readings ---------- */

  function readBattery() {
    if (!navigator.getBattery) {
      metrics.battery = { unsupported: true };
      return;
    }
    navigator.getBattery().then(function (battery) {
      metrics.battery = {
        level: Math.round(battery.level * 100),
        charging: battery.charging
      };
      paintTiles();
      battery.addEventListener('levelchange', function () {
        metrics.battery.level = Math.round(battery.level * 100);
        paintTiles();
      });
      battery.addEventListener('chargingchange', function () {
        metrics.battery.charging = battery.charging;
        paintTiles();
      });
    }).catch(function () {
      metrics.battery = { unsupported: true };
      paintTiles();
    });
  }

  function readNetwork() {
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
    metrics.network = conn ? {
      type: conn.effectiveType || conn.type || 'unknown',
      downlink: Number(conn.downlink) || 0,
      rtt: Number(conn.rtt) || 0,
      saveData: !!conn.saveData
    } : { unsupported: true };
    metrics.online = navigator.onLine;
  }

  function readStorage() {
    if (!navigator.storage || !navigator.storage.estimate) {
      metrics.storage = { unsupported: true };
      paintTiles();
      return;
    }
    navigator.storage.estimate().then(function (est) {
      metrics.storage = { usage: est.usage || 0, quota: est.quota || 0 };
      paintTiles();
    }).catch(function () {
      metrics.storage = { unsupported: true };
      paintTiles();
    });
  }

  function readMemory() {
    var perf = window.performance && performance.memory ? performance.memory : null;
    metrics.memory = {
      device: Number(navigator.deviceMemory) || 0,
      used: perf ? perf.usedJSHeapSize : 0,
      limit: perf ? perf.jsHeapSizeLimit : 0,
      cores: Number(navigator.hardwareConcurrency) || 0
    };
  }

  function readScreen() {
    metrics.screen = {
      w: window.screen ? window.screen.width : 0,
      h: window.screen ? window.screen.height : 0,
      dpr: window.devicePixelRatio || 1
    };
  }

  function readNav() {
    var entries = performance.getEntriesByType ? performance.getEntriesByType('navigation') : [];
    var nav = entries && entries[0];
    metrics.nav = nav ? {
      dcl: Math.round(nav.domContentLoadedEventEnd || 0),
      load: Math.round(nav.loadEventEnd || nav.duration || 0)
    } : null;
  }

  function sampleSystem() {
    readNetwork();
    readMemory();
    readScreen();
    readNav();
    readBattery();
    readStorage();
    paintTiles();
    paintNet();
    el.updated.textContent = 'updated ' + stamp(new Date());
  }

  /* ---------- the tiles ---------- */

  var TILES = [
    { key: 'battery', label: 'Battery' },
    { key: 'network', label: 'Network' },
    { key: 'storage', label: 'Storage' },
    { key: 'memory', label: 'Memory' },
    { key: 'cores', label: 'Cores' },
    { key: 'screen', label: 'Screen' },
    { key: 'session', label: 'This session' },
    { key: 'load', label: 'Page load' }
  ];

  var tileNodes = {};

  function buildTiles() {
    el.tiles.textContent = '';
    TILES.forEach(function (tile) {
      var box = document.createElement('div');
      box.className = 'tile';

      var k = document.createElement('span');
      k.className = 'k';
      k.textContent = tile.label;

      var v = document.createElement('span');
      v.className = 'v';
      v.textContent = '—';

      var n = document.createElement('span');
      n.className = 'n';
      n.textContent = '';

      box.appendChild(k);
      box.appendChild(v);
      box.appendChild(n);
      el.tiles.appendChild(box);
      tileNodes[tile.key] = { box: box, v: v, n: n };
    });
  }

  function setTile(key, value, note, tone) {
    var node = tileNodes[key];
    if (!node) return;
    node.v.textContent = value;
    node.n.textContent = note || '';
    node.box.classList.toggle('is-ok', tone === 'ok');
    node.box.classList.toggle('is-warn', tone === 'warn');
    node.box.classList.toggle('is-bad', tone === 'bad');
  }

  function paintTiles() {
    var b = metrics.battery;
    if (!b) setTile('battery', '—', 'reading…');
    else if (b.unsupported) setTile('battery', 'n/a', 'not exposed by this browser');
    else setTile('battery', b.level + '%', b.charging ? 'charging' : 'on battery',
      b.level <= 15 && !b.charging ? 'bad' : b.charging ? 'ok' : '');

    var net = metrics.network;
    if (!net) setTile('network', metrics.online ? 'online' : 'offline', '');
    else if (net.unsupported) setTile('network', metrics.online ? 'online' : 'offline', 'no network info API',
      metrics.online ? 'ok' : 'bad');
    else setTile('network', net.type, net.downlink ? '~' + net.downlink + ' Mb/s · ' + net.rtt + ' ms rtt' : 'rtt ' + net.rtt + ' ms',
      metrics.online ? 'ok' : 'bad');

    var st = metrics.storage;
    if (!st) setTile('storage', '—', 'reading…');
    else if (st.unsupported) setTile('storage', 'n/a', 'not exposed by this browser');
    else if (!st.quota) setTile('storage', bytes(st.usage), 'quota hidden');
    else {
      var pct = Math.round((st.usage / st.quota) * 100);
      setTile('storage', pct + '%', bytes(st.usage) + ' of ' + bytes(st.quota), pct >= 90 ? 'warn' : '');
    }

    var mem = metrics.memory || {};
    if (!mem.cores && !mem.device) setTile('memory', '—', 'reading…');
    else setTile('memory',
      mem.device ? mem.device + ' GB' : (mem.cores ? mem.cores + ' threads' : 'n/a'),
      mem.used ? bytes(mem.used) + ' js heap' : 'device memory, if exposed');

    setTile('cores', mem.cores ? String(mem.cores) : 'n/a', 'hardware threads');

    var sc = metrics.screen;
    if (!sc || !sc.w) setTile('screen', '—', '');
    else setTile('screen', sc.w + '×' + sc.h, '@' + sc.dpr + 'x · ' + window.innerWidth + ' css px');

    setTile('session', clock(Date.now() - sessionStart), document.hidden ? 'tab hidden' : 'tab visible');

    var navEntry = metrics.nav;
    setTile('load', navEntry && navEntry.load ? navEntry.load + ' ms' : '—',
      navEntry && navEntry.dcl ? 'interactive at ' + navEntry.dcl + ' ms' : 'no timing entry');
  }

  function paintNet() {
    el.netPill.textContent = metrics.online ? 'online' : 'offline';
    el.netPill.className = 'pill ' + (metrics.online ? 'ok' : 'bad');
  }

  /* ---------- event loop ---------- */

  function sampleLag() {
    var now = performance.now();
    var drift = now - lagExpected - LAG_MS;
    lagExpected = now;
    metrics.lag = Math.max(0, Math.round(drift));

    lags.push(metrics.lag);
    if (lags.length > SAMPLE_COUNT) lags.shift();

    var worst = lags.reduce(function (max, value) { return Math.max(max, value); }, 0);
    el.lagNow.textContent = metrics.lag + ' ms now · ' + worst + ' ms peak';
    el.lagNow.className = 'stamp';
    drawChart();
    setTimeout(sampleLag, LAG_MS);
  }

  function drawChart() {
    var w = el.chart.width;
    var h = el.chart.height;
    var top = Math.max(60, lags.reduce(function (max, v) { return Math.max(max, v); }, 0));

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0b0f1b';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(139, 149, 179, 0.16)';
    ctx.lineWidth = 1;
    for (var row = 1; row < 4; row++) {
      var y = Math.round((h / 4) * row) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    if (lags.length < 2) return;

    var stepX = w / (SAMPLE_COUNT - 1);
    var offset = w - (lags.length - 1) * stepX;

    function yFor(value) {
      return h - 6 - (clamp(value, 0, top) / top) * (h - 14);
    }

    ctx.beginPath();
    lags.forEach(function (value, i) {
      var x = offset + i * stepX;
      var y = yFor(value);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = Math.max(1.5, w / 420);
    ctx.lineJoin = 'round';
    ctx.stroke();

    var lastX = offset + (lags.length - 1) * stepX;
    var lastY = yFor(lags[lags.length - 1]);
    ctx.beginPath();
    ctx.arc(lastX, lastY, Math.max(2, w / 300), 0, Math.PI * 2);
    ctx.fillStyle = '#34d399';
    ctx.fill();

    ctx.fillStyle = 'rgba(139, 149, 179, 0.9)';
    ctx.font = '600 ' + Math.round(h / 14) + 'px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(top + ' ms', 8, 14);
    ctx.fillText('one minute', w - 78, 14);
  }

  function countFrames(now) {
    if (!frameWindowStart) frameWindowStart = now;
    frameCount++;
    if (now - frameWindowStart >= 1000) {
      metrics.fps = Math.round((frameCount * 1000) / (now - frameWindowStart));
      frameCount = 0;
      frameWindowStart = now;
    }
    requestAnimationFrame(countFrames);
  }

  /* ---------- watches ---------- */

  function probe(url) {
    var started = performance.now();
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (ctrl) ctrl.abort();
    }, PROBE_TIMEOUT);

    return fetch(url, {
      mode: 'no-cors',
      cache: 'no-store',
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function () {
      return { ok: true, ms: Math.round(performance.now() - started), note: 'reached — status hidden across origins' };
    }).catch(function (err) {
      var name = (err && err.name) || 'failed';
      return {
        ok: false,
        ms: Math.round(performance.now() - started),
        note: name === 'AbortError' ? 'timed out after ' + (PROBE_TIMEOUT / 1000) + 's' : 'unreachable or blocked (' + name + ')'
      };
    }).then(function (out) {
      clearTimeout(timer);
      return out;
    });
  }

  function record(watch, result) {
    var at = new Date();
    results[watch.id] = { ok: result.ok, ms: result.ms, note: result.note, at: at.toISOString() };
    state.log.unshift({
      t: at.toISOString(),
      id: watch.id,
      name: watch.name,
      ok: result.ok,
      ms: result.ms,
      note: result.note
    });
    state.log = state.log.slice(0, LOG_MAX);
    paintLog();
    paintWatches();
    save();
  }

  function checkWatch(watch) {
    var row = el.watchList.querySelector('[data-id="' + watch.id + '"]');
    if (row) {
      var button = row.querySelector('.check');
      if (button) button.disabled = true;
      var meta = row.querySelector('.meta');
      if (meta) meta.textContent = 'checking…';
    }
    return probe(watch.url).then(function (result) {
      record(watch, result);
      return result;
    });
  }

  function checkAll() {
    if (!state.watches.length) return Promise.resolve();
    return state.watches.reduce(function (chain, watch) {
      return chain.then(function () { return checkWatch(watch); });
    }, Promise.resolve());
  }

  function armLoop() {
    clearTimeout(probeTimer);
    probeTimer = 0;
    if (!state.interval || !state.watches.length) return;
    probeTimer = setTimeout(function () {
      checkAll().then(armLoop);
    }, state.interval * 1000);
  }

  function paintWatches() {
    el.watchList.textContent = '';
    el.watchEmpty.hidden = state.watches.length > 0;
    el.interval.disabled = state.watches.length === 0;

    state.watches.forEach(function (watch) {
      var li = document.createElement('li');
      li.className = 'watch';
      li.setAttribute('data-id', watch.id);

      var left = document.createElement('div');
      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = watch.name;
      var url = document.createElement('span');
      url.className = 'url';
      url.textContent = watch.url;
      url.title = watch.url;
      var meta = document.createElement('span');
      meta.className = 'meta';
      var last = results[watch.id];
      meta.textContent = last
        ? (last.ok ? 'reached' : 'failed') + ' in ' + last.ms + ' ms · ' + stamp(new Date(last.at))
        : 'not checked yet';
      left.appendChild(name);
      left.appendChild(url);
      left.appendChild(meta);

      var actions = document.createElement('div');
      actions.className = 'actions';

      var pill = document.createElement('span');
      pill.className = 'pill ' + (last ? (last.ok ? 'ok' : 'bad') : 'ghost');
      pill.textContent = last ? (last.ok ? 'up' : 'down') : 'idle';

      var check = document.createElement('button');
      check.type = 'button';
      check.className = 'check';
      check.textContent = 'Check';
      check.setAttribute('aria-label', 'Check ' + watch.name + ' now');
      check.addEventListener('click', function () {
        check.disabled = true;
        checkWatch(watch).then(function () { check.disabled = false; });
      });

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = '×';
      del.title = 'Remove ' + watch.name;
      del.setAttribute('aria-label', 'Remove ' + watch.name);
      del.addEventListener('click', function () { removeWatch(watch.id); });

      actions.appendChild(pill);
      actions.appendChild(check);
      actions.appendChild(del);

      li.appendChild(left);
      li.appendChild(actions);
      el.watchList.appendChild(li);
    });
  }

  function paintLog() {
    el.logList.textContent = '';
    el.logEmpty.hidden = state.log.length > 0;

    state.log.slice(0, 60).forEach(function (entry) {
      var li = document.createElement('li');

      var at = document.createElement('span');
      at.className = 't';
      var when = new Date(entry.t);
      at.textContent = isNaN(when.getTime()) ? entry.t : stamp(when);

      var pill = document.createElement('span');
      pill.className = 'pill ' + (entry.ok ? 'ok' : 'bad');
      pill.textContent = entry.ok ? 'ok' : 'fail';

      var what = document.createElement('span');
      what.className = 'what';
      what.textContent = entry.name + ' · ' + (entry.note || '');

      var ms = document.createElement('span');
      ms.className = 'ms';
      ms.textContent = entry.ms + ' ms';

      li.appendChild(at);
      li.appendChild(pill);
      li.appendChild(what);
      li.appendChild(ms);
      el.logList.appendChild(li);
    });
  }

  function addWatch(name, url) {
    var watch = normalizeWatch({ name: name, url: url });
    if (!watch) {
      toast('Use a full http:// or https:// address');
      return;
    }
    if (state.watches.some(function (w) { return w.url === watch.url; })) {
      toast('That URL is already on the list');
      return;
    }
    if (state.watches.length >= 24) {
      toast('That is the most watches this app keeps');
      return;
    }
    state.watches.push(watch);
    paintWatches();
    save();
    armLoop();
    checkWatch(watch);
  }

  function removeWatch(id) {
    state.watches = state.watches.filter(function (w) { return w.id !== id; });
    delete results[id];
    paintWatches();
    save();
    armLoop();
    if (!state.watches.length) toast('Watch removed — repeat checks stopped');
  }

  /* ---------- wake lock ---------- */

  function paintWake() {
    el.wakeBtn.setAttribute('aria-pressed', wakeWanted ? 'true' : 'false');
    el.wakeBtn.textContent = wakeWanted ? 'Screen staying awake' : 'Keep screen awake';
    el.wakeBtn.classList.toggle('ghost', !wakeWanted);
  }

  function requestWake() {
    if (!('wakeLock' in navigator)) {
      toast('This browser cannot keep the screen awake');
      return Promise.resolve(false);
    }
    return navigator.wakeLock.request('screen').then(function (sentinel) {
      wakeSentinel = sentinel;
      sentinel.addEventListener('release', function () {
        wakeSentinel = null;
        if (wakeWanted && !document.hidden) {
          wakeWanted = false;
          paintWake();
          toast('The screen lock was released by the device');
        }
      });
      wakeWanted = true;
      paintWake();
      return true;
    }).catch(function (err) {
      wakeWanted = false;
      paintWake();
      toast('Wake lock refused: ' + ((err && err.name) || 'unknown'));
      return false;
    });
  }

  function releaseWake() {
    wakeWanted = false;
    paintWake();
    if (wakeSentinel) {
      wakeSentinel.release().catch(function () {});
      wakeSentinel = null;
    }
  }

  /* ---------- export ---------- */

  function exportLog() {
    if (!state.log.length) {
      toast('Nothing to export yet');
      return;
    }
    var payload = {
      app: 'Apex Pulse',
      exported: new Date().toISOString(),
      interval: state.interval,
      watches: state.watches,
      entries: state.log
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var when = new Date();
    var name = 'apex-pulse-' + when.getFullYear() + pad(when.getMonth() + 1) + pad(when.getDate()) +
      '-' + pad(when.getHours()) + pad(when.getMinutes()) + pad(when.getSeconds()) + '.json';
    var link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast('Exported ' + name);
  }

  /* ---------- wiring ---------- */

  el.watchForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var url = el.watchUrl.value.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) {
      toast('Use a full http:// or https:// address');
      return;
    }
    addWatch(el.watchName.value, url);
    el.watchName.value = '';
    el.watchUrl.value = '';
  });

  el.interval.addEventListener('change', function () {
    var value = Number(el.interval.value);
    state.interval = value === 30 || value === 60 || value === 300 ? value : 0;
    save();
    armLoop();
    if (!state.interval) {
      toast('Repeat checks off');
    } else if (!state.watches.length) {
      toast('Add a URL and Pulse will check it every ' + (state.interval === 60 ? 'minute' : state.interval + 's'));
    } else {
      toast('Checking every ' + (state.interval === 60 ? 'minute' : state.interval + 's') + ' while this tab is open');
      checkAll().then(armLoop);
    }
  });

  el.exportLog.addEventListener('click', exportLog);

  el.clearLog.addEventListener('click', function () {
    if (!state.log.length) {
      toast('The log is already empty');
      return;
    }
    if (!window.confirm('Clear the ' + state.log.length + ' saved checks?')) return;
    state.log = [];
    paintLog();
    save();
    toast('Log cleared');
  });

  el.wakeBtn.addEventListener('click', function () {
    if (wakeWanted) releaseWake();
    else requestWake();
  });

  window.addEventListener('online', function () { sampleSystem(); });
  window.addEventListener('offline', function () { sampleSystem(); });

  document.addEventListener('visibilitychange', function () {
    if (wakeWanted && !document.hidden && !wakeSentinel) requestWake();
    paintTiles();
  });

  window.addEventListener('pagehide', function () {
    clearTimeout(probeTimer);
    clearTimeout(sysTimer);
    releaseWake();
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    });
  }

  /* ---------- boot ---------- */

  load();
  buildTiles();
  el.interval.value = String(state.interval);
  paintWake();
  paintWatches();
  paintLog();
  paintNet();
  sampleSystem();
  sysTimer = setInterval(sampleSystem, SYSTEM_MS);

  lagExpected = performance.now();
  setTimeout(sampleLag, LAG_MS);
  requestAnimationFrame(countFrames);
  drawChart();
  armLoop();

  if (!state.watches.length) {
    el.statLine.textContent = 'Device pulse and keep-alive, measured in this tab.';
  } else {
    el.statLine.textContent = state.watches.length + (state.watches.length === 1 ? ' watch' : ' watches') +
      (state.interval ? ', checking every ' + (state.interval === 60 ? 'minute' : state.interval + 's') : ', checked by hand');
  }
})();
