/*
 * Popup / player window UI. Searches the chosen archive.org collection (Motorpsycho by default, others in the settings),
 * shows a recording's tracks and controls the audio engine that lives in the offscreen document
 * (see background.js / offscreen.js). All archive.org access is in archive.js.
 */
(function () {
  'use strict';

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var isWindow = new URLSearchParams(location.search).has('window');
  if (isWindow) {
    document.body.classList.add('is-window');
  }

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    form: $('searchForm'), q: $('q'), year: $('year'), sort: $('sort'), reset: $('reset'), count: $('count'),
    list: $('list'), listState: $('listState'), more: $('more'), randomBtn: $('randomBtn'), randomMsg: $('randomMsg'),
    viewSettings: $('viewSettings'), settingsBtn: $('settingsBtn'), settingsBack: $('settingsBack'), collections: $('collections'),
    brandK: $('brandK'), shuffle: $('shuffle'),
    viewList: $('viewList'), viewDetail: $('viewDetail'), back: $('back'), rec: $('rec'), tracks: $('tracks'), detailState: $('detailState'),
    bar: $('bar'), barTitle: $('barTitle'), barRec: $('barRec'), barErr: $('barErr'),
    main: document.querySelector('.main'),
    seek: $('seek'), timeNow: $('timeNow'), timeTotal: $('timeTotal'), volume: $('volume'),
    toggle: $('toggle'), prev: $('prev'), next: $('next'), stop: $('stop'), openWindow: $('openWindow')
  };

  var A = MPArchive;
  var ui = { q: '', year: '', sort: 'desc' };
  var collection = A.collectionById('');   // the collection being browsed (saved in storage)
  var page = 1;
  var total = 0;
  var shown = 0;
  var yearsToken = 0;
  var player = { queue: [], index: -1, rec: null, playing: false, position: 0, duration: 0, volume: 1, error: '', notice: '', random: null };
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

  function splitVenue(venue) {
    var at = venue.indexOf(',');
    return at === -1 ? { name: venue, place: '' } : { name: venue.slice(0, at).trim(), place: venue.slice(at + 1).trim() };
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

  function renderRows(docs, append) {
    if (!append) { els.list.textContent = ''; }
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

  function updateCount() {
    els.count.textContent = total + (total === 1 ? ' recording' : ' recordings');
    els.more.hidden = shown >= total;
    els.more.textContent = 'Show more (' + (total - shown) + ' left)';
    els.more.disabled = false;
  }

  function runSearch() {
    var id = ++searchId;
    page = 1;
    shown = 0;
    total = 0;
    els.reset.hidden = !(ui.q || ui.year);
    els.listState.hidden = true;
    els.more.hidden = true;
    els.list.textContent = '';
    for (var i = 0; i < 6; i++) { els.list.appendChild(el('li', 'skel')); }
    els.count.textContent = 'Searching archive.org…';

    A.search(collection, ui, 1).then(function (result) {
      if (id !== searchId) { return; }
      total = result.total;
      shown = result.docs.length;
      renderRows(result.docs, false);
      updateCount();
      if (!result.docs.length) { showState(els.listState, 'No recordings match your search.'); }
    }).catch(function () {
      if (id !== searchId) { return; }
      els.list.textContent = '';
      els.count.textContent = '';
      showState(els.listState, 'Could not reach archive.org right now.', runSearch);
    });
  }

  function loadMore() {
    var id = searchId;
    els.more.disabled = true;
    els.more.textContent = 'Loading…';

    A.search(collection, ui, page + 1).then(function (result) {
      if (id !== searchId) { return; }
      page += 1;
      shown += result.docs.length;
      renderRows(result.docs, true);
      updateCount();
      if (!result.docs.length) { els.more.hidden = true; }
    }).catch(function () {
      if (id !== searchId) { return; }
      els.more.disabled = false;
      els.more.textContent = 'Could not load more. Try again';
    });
  }

  function saveUi() {
    A.storeSet('ui', ui);
  }

  function showList() {
    els.viewSettings.hidden = true;
    els.viewDetail.hidden = true;
    els.viewList.hidden = false;
    currentRec = null;
  }

  /* ------------------------------------------------------------------ detail view */

  function openRecording(doc) {
    els.viewSettings.hidden = true;
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

    A.getRecording(doc.id, doc).then(function (rec) {
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
    var playing = player.queue[player.index];
    els.tracks.querySelectorAll('.trk').forEach(function (button) {
      var track = currentRec && currentRec.tracks[Number(button.getAttribute('data-index'))];
      var live = liveHere && playing && track && track.name === playing.name;
      button.classList.toggle('is-live', !!live);
      button.classList.toggle('is-playing', !!live && player.playing);
    });
  }

  function playFrom(rec, index) {
    command('playQueue', {
      queue: rec.tracks.map(function (track) { return { title: track.title, seconds: track.seconds, src: track.src, name: track.name }; }),
      index: index,
      rec: { id: rec.id, title: rec.title, date: rec.date, venue: rec.venue, url: rec.url, servers: rec.servers || [], artist: rec.artist || '' }
    });
  }

  /* ------------------------------------------------------------------ player bar */

  function renderPlayer() {
    var track = player.queue[player.index];
    els.bar.hidden = !track;
    document.body.classList.toggle('has-bar', !!track);

    // Nothing playing yet but a random track is being looked up (or that failed): say so under the filters.
    var lookup = !track && (player.notice || player.error);
    els.randomMsg.hidden = !lookup;
    els.randomMsg.textContent = lookup ? (player.error || player.notice) : '';
    els.randomBtn.disabled = !!(!track && player.notice);
    if (!track) { return; }

    els.bar.classList.toggle('is-playing-now', player.playing);
    els.toggle.setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
    els.barTitle.textContent = track.title;
    els.barRec.textContent = (player.random ? 'Random · ' : '') + (player.rec ? [player.rec.date, player.rec.venue].filter(Boolean).join(' · ') : '');
    els.shuffle.classList.toggle('is-on', !!player.random);
    els.shuffle.setAttribute('aria-pressed', player.random ? 'true' : 'false');
    els.shuffle.title = player.random ? 'Random mode is on (click to turn off)' : 'Play random tracks from this collection';
    els.prev.disabled = false;
    els.next.disabled = !player.random && player.index >= player.queue.length - 1;
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
    player = Object.assign({ queue: [], index: -1, rec: null, playing: false, position: 0, duration: 0, volume: 1, error: '', notice: '', random: null }, state);
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
  els.more.addEventListener('click', loadMore);

  /** Random mode: random tracks from the collection, narrowed by the year / search you have set. */
  function startRandom() {
    command('random', { random: { query: A.buildQuery(collection, ui), collection: collection.id, name: collection.name } });
  }

  els.randomBtn.addEventListener('click', startRandom);
  els.shuffle.addEventListener('click', function () {
    if (player.random) { command('randomOff'); } else { startRandom(); }
  });

  /* ---- settings: which collection to browse ---- */

  function renderCollections() {
    els.collections.textContent = '';
    A.COLLECTIONS.forEach(function (item) {
      var label = el('label', 'coll' + (item.id === collection.id ? ' is-on' : ''));
      var radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'collection';
      radio.value = item.id;
      radio.checked = item.id === collection.id;
      var body = el('span', 'coll__b');
      body.appendChild(el('span', 'coll__t', item.name));
      body.appendChild(el('span', 'coll__m', 'archive.org/details/' + item.id));
      label.appendChild(radio);
      label.appendChild(body);
      radio.addEventListener('change', function () { chooseCollection(item.id); });
      els.collections.appendChild(label);
    });
  }

  function openSettings() {
    renderCollections();
    els.viewList.hidden = true;
    els.viewDetail.hidden = true;
    els.viewSettings.hidden = false;
    els.main.scrollTop = 0;
  }

  function closeSettings() {
    els.viewSettings.hidden = true;
    els.viewList.hidden = false;
  }

  function applyCollection() {
    els.brandK.textContent = collection.name;
    document.title = collection.name + ' · Archive player';
    els.year.textContent = '';
    var all = el('option', '', 'All years');
    all.value = '';
    els.year.appendChild(all);
    var token = ++yearsToken;
    A.loadYears(collection).then(function (years) {
      if (token === yearsToken) { fillYears(years); } // ignore a slower answer for the collection you just left
    }, function () { /* the list still works without the year menu */ });
  }

  function chooseCollection(id) {
    if (id === collection.id) { closeSettings(); return; }
    collection = A.collectionById(id);
    ui.q = '';
    ui.year = '';
    els.q.value = '';
    A.storeSet('collection', collection.id);
    saveUi();
    currentRec = null;
    applyCollection();
    closeSettings();
    runSearch();
  }

  els.settingsBtn.addEventListener('click', function () {
    if (els.viewSettings.hidden) { openSettings(); } else { closeSettings(); }
  });
  els.settingsBack.addEventListener('click', closeSettings);

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
      var option = el('option', '', item.count ? item.year + ' (' + item.count + ')' : item.year);
      option.value = item.year;
      els.year.appendChild(option);
    });
    els.year.value = ui.year;
  }

  Promise.all([A.storeGet('ui'), A.storeGet('collection'), send({ type: 'getState' })]).then(function (results) {
    if (results[0]) { ui = Object.assign(ui, results[0]); }
    collection = A.collectionById(results[1] || '');
    els.q.value = ui.q;
    els.sort.value = ui.sort;
    if (results[2] && results[2].state) { applyState(results[2].state); }

    applyCollection();
    runSearch();
  });
}());
