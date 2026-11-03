/*
 * Popup / player window UI. Searches the Motorpsycho collection on archive.org (advancedsearch), shows a recording's
 * tracks and controls the audio engine that lives in the offscreen document (see background.js / offscreen.js).
 */
(function () {
  'use strict';

  var BASE_QUERY = 'collection:MotorpsychoBand';
  var SEARCH_URL = 'https://archive.org/advancedsearch.php';
  var META_URL = 'https://archive.org/metadata/';
  var CACHE_MS = 12 * 60 * 60 * 1000;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var isWindow = new URLSearchParams(location.search).has('window');
  if (isWindow) {
    document.body.classList.add('is-window');
  }

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    form: $('searchForm'), q: $('q'), year: $('year'), sort: $('sort'), reset: $('reset'), count: $('count'),
    list: $('list'), listState: $('listState'),
    viewList: $('viewList'), viewDetail: $('viewDetail'), back: $('back'), rec: $('rec'), tracks: $('tracks'), detailState: $('detailState'),
    bar: $('bar'), barTitle: $('barTitle'), barRec: $('barRec'), barErr: $('barErr'),
    main: document.querySelector('.main'),
    seek: $('seek'), timeNow: $('timeNow'), timeTotal: $('timeTotal'), volume: $('volume'),
    toggle: $('toggle'), prev: $('prev'), next: $('next'), stop: $('stop'), openWindow: $('openWindow')
  };

  var ui = { q: '', year: '', sort: 'desc' };
  var player = { queue: [], index: -1, rec: null, playing: false, position: 0, duration: 0, volume: 1, error: '' };
  var currentRec = null;      // recording shown in the detail view (with tracks)
  var searchId = 0;
  var detailId = 0;
  var seeking = false;
  var draggingVolume = false;
  var timer = null;

  /* ------------------------------------------------------------------ helpers */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined && text !== null) { node.textContent = text; }
    return node;
  }

  function clock(seconds) {
    seconds = Math.max(0, Math.floor(seconds || 0));
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  function parseLength(value) {
    if (value === undefined || value === null || value === '') { return 0; }
    var text = String(value).trim();
    if (/^\d+(\.\d+)?$/.test(text)) { return Math.round(parseFloat(text)); }
    var parts = text.split(':').map(Number);
    if (parts.some(isNaN)) { return 0; }
    return parts.reduce(function (total, part) { return total * 60 + part; }, 0);
  }

  function splitVenue(venue) {
    var at = venue.indexOf(',');
    return at === -1 ? { name: venue, place: '' } : { name: venue.slice(0, at).trim(), place: venue.slice(at + 1).trim() };
  }

  function venueOf(doc) {
    var text = doc.venue || doc.title.replace(/^Motorpsycho Live at\s*/i, '').replace(/\s+on\s+\S+$/i, '');
    return text.trim();
  }

  function stampNode(date) {
    var stamp = el('span', 'stamp');
    stamp.setAttribute('aria-hidden', 'true');
    var month = parseInt(date.slice(5, 7), 10);
    stamp.appendChild(el('b', '', date.slice(8, 10) || '–'));
    stamp.appendChild(el('span', '', (MONTHS[month - 1] || '') + ' ' + date.slice(0, 4)));
    return stamp;
  }

  function send(message) {
    return chrome.runtime.sendMessage(message).catch(function () { return null; });
  }

  function command(cmd, extra) {
    return send(Object.assign({ type: 'command', cmd: cmd }, extra || {}));
  }

  function storeGet(key) {
    return chrome.storage.local.get(key).then(function (data) { return data[key]; });
  }

  function storeSet(key, value) {
    var item = {};
    item[key] = value;
    return chrome.storage.local.set(item);
  }

  function fetchJson(url) {
    var controller = new AbortController();
    var abort = window.setTimeout(function () { controller.abort(); }, 20000);

    return fetch(url, { signal: controller.signal })
      .then(function (response) {
        if (!response.ok) { throw new Error('archive.org answered ' + response.status); }
        return response.json();
      })
      .finally(function () { window.clearTimeout(abort); });
  }

  /* ------------------------------------------------------------------ archive.org */

  /**
   * User text -> a safe archive.org (Lucene) clause. Every word may be the start of a word in the title, venue or
   * description (wildcards only work on named fields) or a whole word anywhere in the item's text (song titles).
   */
  function textClause(text) {
    var words = text.toLowerCase().replace(/[+\-!(){}\[\]^"~*?:\\\/&|]/g, ' ').split(/\s+/).filter(Boolean);
    if (!words.length) { return ''; }

    return words.map(function (word) {
      return '(title:' + word + '* OR venue:' + word + '* OR description:' + word + '* OR ' + word + ')';
    }).join(' AND ');
  }

  function buildQuery(state) {
    var parts = [BASE_QUERY];
    var clause = textClause(state.q);
    if (clause) { parts.push(clause); }
    if (/^\d{4}$/.test(state.year)) { parts.push('year:' + state.year); }
    return parts.join(' AND ');
  }

  function searchRecordings(state) {
    var params = new URLSearchParams();
    params.set('q', buildQuery(state));
    ['identifier', 'title', 'date', 'venue', 'source', 'taper'].forEach(function (field) { params.append('fl[]', field); });
    params.append('sort[]', 'date ' + (state.sort === 'asc' ? 'asc' : 'desc'));
    params.set('rows', '500');
    params.set('page', '1');
    params.set('output', 'json');

    return fetchJson(SEARCH_URL + '?' + params.toString()).then(function (data) {
      return ((data.response && data.response.docs) || []).map(function (doc) {
        var rec = {
          id: doc.identifier,
          title: doc.title || doc.identifier,
          date: String(doc.date || '').slice(0, 10),
          venue: doc.venue || '',
          source: Array.isArray(doc.source) ? doc.source.join(', ') : (doc.source || ''),
          taper: Array.isArray(doc.taper) ? doc.taper.join(', ') : (doc.taper || '')
        };
        rec.venue = venueOf(rec);
        return rec;
      });
    });
  }

  /** Years with the number of recordings, from one request (cached). */
  function loadYears() {
    return storeGet('years').then(function (cached) {
      if (cached && Date.now() - cached.at < CACHE_MS) { return cached.data; }

      return searchRecordings({ q: '', year: '', sort: 'desc' }).then(function (docs) {
        var counts = {};
        docs.forEach(function (doc) {
          var year = doc.date.slice(0, 4);
          if (year) { counts[year] = (counts[year] || 0) + 1; }
        });
        var data = Object.keys(counts).sort().reverse().map(function (year) { return { year: year, count: counts[year] }; });
        storeSet('years', { at: Date.now(), data: data });
        return data;
      });
    });
  }

  /** Same rules as the MPDB site: only the VBR MP3 derivatives, in track order. */
  function getRecording(id, hint) {
    var key = 'rec:' + id;

    return storeGet(key).then(function (cached) {
      if (cached && cached.v === 2 && Date.now() - cached.at < CACHE_MS) { return cached.data; }

      return fetchJson(META_URL + encodeURIComponent(id)).then(function (data) {
        var meta = data.metadata || {};
        var files = (data.files || []).filter(function (file) { return file.name && String(file.format).toLowerCase() === 'vbr mp3'; });
        if (!files.length) {
          files = (data.files || []).filter(function (file) { return file.name && String(file.format).toLowerCase() === 'mp3'; });
        }

        var tracks = files.map(function (file, i) {
          var base = file.name.replace(/\.[^.\/]+$/, '');
          var title = file.title ? String(file.title).trim() : base.split('/').pop().replace(/^\s*\d+\s*[-._)]*\s*/, '').trim();
          var number = /^\s*(\d+)/.exec(file.track || '') || /^\s*(\d+)/.exec(file.name.split('/').pop());
          return {
            order: number ? parseInt(number[1], 10) : 0,
            name: file.name,
            title: title || 'Track ' + (i + 1),
            seconds: parseLength(file.length),
            src: 'https://archive.org/download/' + encodeURIComponent(id) + '/' + file.name.split('/').map(encodeURIComponent).join('/')
          };
        });

        tracks.sort(function (a, b) {
          if (a.order && b.order && a.order !== b.order) { return a.order - b.order; }
          return a.name.localeCompare(b.name, undefined, { numeric: true });
        });

        // The item's own servers: used as a fallback when archive.org/download redirects to a storage node that errors.
        var servers = [];
        var addServer = function (host, dir) {
          if (host && dir && !servers.some(function (item) { return item.host === host && item.dir === dir; })) {
            servers.push({ host: host, dir: dir });
          }
        };
        (data.workable_servers || []).forEach(function (host) { addServer(host, data.dir); });
        ((data.alternate_locations && data.alternate_locations.workable) || []).forEach(function (alt) { addServer(alt.server, alt.dir); });
        addServer(data.d1, data.dir);
        addServer(data.d2, data.dir);

        var first = function (value) { return Array.isArray(value) ? value.join(', ') : (value || ''); };
        var rec = {
          id: id,
          title: first(meta.title) || (hint && hint.title) || id,
          date: String(first(meta.date) || (hint && hint.date) || '').slice(0, 10),
          venue: first(meta.venue) || (hint && hint.venue) || '',
          source: first(meta.source) || (hint && hint.source) || '',
          taper: first(meta.taper) || (hint && hint.taper) || '',
          url: 'https://archive.org/details/' + encodeURIComponent(id),
          servers: servers,
          tracks: tracks.map(function (track) { return { title: track.title, seconds: track.seconds, src: track.src, name: track.name }; })
        };
        if (!rec.venue) { rec.venue = venueOf(rec); }

        storeSet(key, { v: 2, at: Date.now(), data: rec });
        return rec;
      });
    });
  }

  /* ------------------------------------------------------------------ list view */

  function showState(node, message, retry) {
    node.hidden = false;
    node.textContent = '';
    node.appendChild(el('p', '', message));
    if (retry) {
      var button = el('button', '', 'Try again');
      button.type = 'button';
      button.addEventListener('click', retry);
      node.appendChild(button);
    }
  }

  function renderRows(docs) {
    els.list.textContent = '';
    var liveId = player.rec ? player.rec.id : '';

    docs.forEach(function (doc) {
      var item = el('li');
      var row = el('button', 'row' + (doc.id === liveId ? ' is-live' : ''));
      row.type = 'button';
      row.setAttribute('data-id', doc.id);

      var where = splitVenue(doc.venue);
      var text = el('span');
      text.appendChild(el('span', 'row__t', where.name || doc.title));
      text.appendChild(el('span', 'row__m', where.place || doc.title));

      row.appendChild(stampNode(doc.date));
      row.appendChild(text);
      if (doc.source) { row.appendChild(el('span', 'tag', doc.source.split(/[,\s]/)[0].toUpperCase())); }

      row.addEventListener('click', function () { openRecording(doc); });
      item.appendChild(row);
      els.list.appendChild(item);
    });
  }

  function runSearch() {
    var id = ++searchId;
    els.reset.hidden = !(ui.q || ui.year);
    els.listState.hidden = true;
    els.list.textContent = '';
    for (var i = 0; i < 6; i++) { els.list.appendChild(el('li', 'skel')); }
    els.count.textContent = 'Searching archive.org…';

    searchRecordings(ui).then(function (docs) {
      if (id !== searchId) { return; }
      els.count.textContent = docs.length + (docs.length === 1 ? ' recording' : ' recordings');
      renderRows(docs);
      if (!docs.length) { showState(els.listState, 'No recordings match your search.'); }
    }).catch(function () {
      if (id !== searchId) { return; }
      els.list.textContent = '';
      els.count.textContent = '';
      showState(els.listState, 'Could not reach archive.org right now.', runSearch);
    });
  }

  function saveUi() {
    storeSet('ui', ui);
  }

  function showList() {
    els.viewDetail.hidden = true;
    els.viewList.hidden = false;
    currentRec = null;
  }

  /* ------------------------------------------------------------------ detail view */

  function openRecording(doc) {
    els.viewList.hidden = true;
    els.viewDetail.hidden = false;
    els.main.scrollTop = 0;
    els.rec.textContent = '';
    els.tracks.textContent = '';
    els.detailState.hidden = true;
    currentRec = null;
    var token = ++detailId;

    var where = splitVenue(doc.venue || '');
    var head = el('div');
    head.appendChild(el('h2', '', where.name || doc.title));
    head.appendChild(el('p', 'rec__m', 'Loading tracks…'));
    els.rec.appendChild(stampNode(doc.date));
    els.rec.appendChild(head);

    getRecording(doc.id, doc).then(function (rec) {
      if (token === detailId && !els.viewDetail.hidden) { renderDetail(rec); }
    }).catch(function () {
      if (token !== detailId) { return; }
      showState(els.detailState, 'Could not load this recording from archive.org.', function () { openRecording(doc); });
    });
  }

  function renderDetail(rec) {
    currentRec = rec;
    var where = splitVenue(rec.venue);
    els.rec.textContent = '';
    els.rec.appendChild(stampNode(rec.date));

    var body = el('div');
    body.appendChild(el('h2', '', where.name || rec.title));
    var meta = [where.place, rec.source ? 'Source: ' + rec.source : '', rec.taper ? 'Taper: ' + rec.taper : ''].filter(Boolean).join(' · ');
    body.appendChild(el('p', 'rec__m', meta));

    var actions = el('div', 'rec__a');
    if (rec.tracks.length) {
      var playAll = el('button', 'btn', 'Play all');
      playAll.type = 'button';
      playAll.addEventListener('click', function () { playFrom(rec, 0); });
      actions.appendChild(playAll);
    }
    var link = el('a', '', 'On archive.org');
    link.href = rec.url;
    link.target = '_blank';
    link.rel = 'noopener';
    actions.appendChild(link);
    body.appendChild(actions);
    els.rec.appendChild(body);

    els.tracks.textContent = '';
    if (!rec.tracks.length) {
      showState(els.detailState, 'This recording has no playable MP3 tracks.');
      return;
    }

    rec.tracks.forEach(function (track, i) {
      var item = el('li');
      var button = el('button', 'trk');
      button.type = 'button';
      button.setAttribute('data-index', String(i));
      button.appendChild(el('span', 'trk__n', String(i + 1)));
      var title = el('span', 'trk__t', track.title);
      var equalizer = el('span', 'eq');
      equalizer.setAttribute('aria-hidden', 'true');
      equalizer.appendChild(document.createElement('i'));
      equalizer.appendChild(document.createElement('i'));
      equalizer.appendChild(document.createElement('i'));
      button.firstChild.after(equalizer);
      // grid has 3 columns: number|bars share the first cell
      equalizer.style.gridColumn = '1';
      equalizer.style.gridRow = '1';
      button.appendChild(title);
      button.appendChild(el('span', 'trk__d', track.seconds ? clock(track.seconds) : ''));
      button.addEventListener('click', function () { playFrom(rec, i); });
      item.appendChild(button);
      els.tracks.appendChild(item);
    });

    markLiveTrack();
  }

  function markLiveTrack() {
    var liveHere = currentRec && player.rec && player.rec.id === currentRec.id;
    els.tracks.querySelectorAll('.trk').forEach(function (button) {
      var live = liveHere && Number(button.getAttribute('data-index')) === player.index;
      button.classList.toggle('is-live', !!live);
      button.classList.toggle('is-playing', !!live && player.playing);
    });
  }

  function playFrom(rec, index) {
    command('playQueue', {
      queue: rec.tracks.map(function (track) { return { title: track.title, seconds: track.seconds, src: track.src, name: track.name }; }),
      index: index,
      rec: { id: rec.id, title: rec.title, date: rec.date, venue: rec.venue, url: rec.url, servers: rec.servers || [] }
    });
  }

  /* ------------------------------------------------------------------ player bar */

  function renderPlayer() {
    var track = player.queue[player.index];
    els.bar.hidden = !track;
    document.body.classList.toggle('has-bar', !!track);
    if (!track) { return; }

    els.bar.classList.toggle('is-playing-now', player.playing);
    els.toggle.setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
    els.barTitle.textContent = track.title;
    els.barRec.textContent = player.rec ? [player.rec.date, player.rec.venue].filter(Boolean).join(' · ') : '';
    els.prev.disabled = false;
    els.next.disabled = player.index >= player.queue.length - 1;
    els.barErr.hidden = !(player.error || player.notice);
    els.barErr.textContent = player.error || player.notice || '';
    els.barErr.classList.toggle('is-notice', !player.error && !!player.notice);

    if (!seeking) { renderProgress(player.position, player.duration); }
    if (!draggingVolume) { els.volume.value = String(Math.round((player.volume === undefined ? 1 : player.volume) * 100)); }

    markLiveTrack();
    els.list.querySelectorAll('.row').forEach(function (row) {
      row.classList.toggle('is-live', !!player.rec && row.getAttribute('data-id') === player.rec.id);
    });
  }

  function renderProgress(position, duration) {
    els.timeNow.textContent = clock(position);
    els.timeTotal.textContent = clock(duration);
    els.seek.value = duration > 0 ? String(Math.round((position / duration) * 1000)) : '0';
  }

  function applyState(state) {
    if (!state) { return; }
    player = Object.assign({ queue: [], index: -1, rec: null, playing: false, position: 0, duration: 0, volume: 1, error: '', notice: '' }, state);
    renderPlayer();
  }

  /* ------------------------------------------------------------------ events */

  els.form.addEventListener('submit', function (event) {
    event.preventDefault();
    window.clearTimeout(timer);
    ui.q = els.q.value.trim();
    saveUi();
    runSearch();
  });

  els.q.addEventListener('input', function () {
    window.clearTimeout(timer);
    timer = window.setTimeout(function () {
      ui.q = els.q.value.trim();
      saveUi();
      runSearch();
    }, 350);
  });

  els.year.addEventListener('change', function () { ui.year = els.year.value; saveUi(); runSearch(); });
  els.sort.addEventListener('change', function () { ui.sort = els.sort.value; saveUi(); runSearch(); });

  els.reset.addEventListener('click', function () {
    ui.q = '';
    ui.year = '';
    els.q.value = '';
    els.year.value = '';
    saveUi();
    runSearch();
  });

  els.back.addEventListener('click', showList);

  els.barTitle.addEventListener('click', function () {
    if (!player.rec) { return; }
    openRecording({ id: player.rec.id, title: player.rec.title, date: player.rec.date, venue: player.rec.venue, source: '', taper: '' });
  });

  els.toggle.addEventListener('click', function () { command('toggle'); });
  els.prev.addEventListener('click', function () { command('prev'); });
  els.next.addEventListener('click', function () { command('next'); });
  els.stop.addEventListener('click', function () { command('stop'); });

  els.seek.addEventListener('input', function () {
    seeking = true;
    renderProgress((Number(els.seek.value) / 1000) * player.duration, player.duration);
  });
  els.seek.addEventListener('change', function () {
    command('seek', { position: (Number(els.seek.value) / 1000) * player.duration });
    seeking = false;
  });

  els.volume.addEventListener('input', function () {
    draggingVolume = true;
    command('volume', { value: Number(els.volume.value) / 100 });
  });
  els.volume.addEventListener('change', function () { draggingVolume = false; });

  els.openWindow.hidden = isWindow;
  els.openWindow.addEventListener('click', function () {
    command('maximize').then(function () { window.close(); });
  });

  chrome.runtime.onMessage.addListener(function (message) {
    if (!message) { return; }
    if (message.type === 'state') {
      applyState(message.state);
    } else if (message.type === 'progress' && !seeking && player.queue[player.index]) {
      player.position = message.position;
      player.duration = message.duration || player.duration;
      renderProgress(player.position, player.duration);
    }
  });

  /* ------------------------------------------------------------------ start */

  function fillYears(years) {
    years.forEach(function (item) {
      var option = el('option', '', item.year + ' (' + item.count + ')');
      option.value = item.year;
      els.year.appendChild(option);
    });
    els.year.value = ui.year;
  }

  Promise.all([storeGet('ui'), send({ type: 'getState' })]).then(function (results) {
    if (results[0]) { ui = Object.assign(ui, results[0]); }
    els.q.value = ui.q;
    els.sort.value = ui.sort;
    if (results[1] && results[1].state) { applyState(results[1].state); }

    loadYears().then(fillYears, function () { /* the list still works without the year menu */ });
    runSearch();
  });
}());
