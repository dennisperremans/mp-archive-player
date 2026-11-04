/*
 * Everything that talks to archive.org, shared by the popup / player window (app.js) and the audio engine
 * (offscreen.js, which needs it for the random mode). Plain script: it exposes `MPArchive` on the global object.
 *
 * Collections: archive.org collections made of "etree" live recordings (one item per recording, VBR MP3 derivatives).
 */
(function (root) {
  'use strict';

  var SEARCH_URL = 'https://archive.org/advancedsearch.php';
  var META_URL = 'https://archive.org/metadata/';
  var CACHE_MS = 12 * 60 * 60 * 1000;
  var PAGE = 200;          // recordings per request in the list ("Show more" asks for the next page)
  var COUNT_LIMIT = 500;   // up to this size we count the recordings per year, bigger collections only list the years

  var COLLECTIONS = [
    { id: 'MotorpsychoBand', name: 'Motorpsycho' },
    { id: 'KingGizzardAndTheLizardWizard', name: 'King Gizzard & The Lizard Wizard' },
    { id: 'GratefulDead', name: 'Grateful Dead' }
  ];

  function collectionById(id) {
    for (var i = 0; i < COLLECTIONS.length; i++) {
      if (COLLECTIONS[i].id === id) { return COLLECTIONS[i]; }
    }
    return COLLECTIONS[0];
  }

  /* ------------------------------------------------------------------ helpers */

  // The offscreen document has no chrome.storage: there the cache is simply skipped.
  function storeGet(key) {
    if (!root.chrome || !chrome.storage || !chrome.storage.local) { return Promise.resolve(undefined); }
    return chrome.storage.local.get(key).then(function (data) { return data[key]; });
  }

  function storeSet(key, value) {
    if (!root.chrome || !chrome.storage || !chrome.storage.local) { return Promise.resolve(); }
    var item = {};
    item[key] = value;
    return chrome.storage.local.set(item);
  }

  function fetchJson(url) {
    var controller = new AbortController();
    var abort = setTimeout(function () { controller.abort(); }, 20000);

    return fetch(url, { signal: controller.signal })
      .then(function (response) {
        if (!response.ok) { throw new Error('archive.org answered ' + response.status); }
        return response.json();
      })
      .finally(function () { clearTimeout(abort); });
  }

  function parseLength(value) {
    if (value === undefined || value === null || value === '') { return 0; }
    var text = String(value).trim();
    if (/^\d+(\.\d+)?$/.test(text)) { return Math.round(parseFloat(text)); }
    var parts = text.split(':').map(Number);
    if (parts.some(isNaN)) { return 0; }
    return parts.reduce(function (total, part) { return total * 60 + part; }, 0);
  }

  function first(value) {
    return Array.isArray(value) ? value.join(', ') : (value || '');
  }

  /** "Band Live at Venue on 2025-06-10" -> "Venue" (fallback when the item has no venue field). */
  function venueOf(doc) {
    var text = doc.venue || String(doc.title || '').replace(/^.*?\sLive at\s*/i, '').replace(/\s+on\s+\S+$/i, '');
    return text.trim();
  }

  /* ------------------------------------------------------------------ search */

  /**
   * User text -> a safe archive.org (Lucene) clause. Every word may be the start of a word in the title, venue or
   * description (wildcards only work on named fields) or a whole word anywhere in the item's text (song titles).
   */
  function textClause(text) {
    var words = String(text || '').toLowerCase().replace(/[+\-!(){}\[\]^"~*?:\\\/&|]/g, ' ').split(/\s+/).filter(Boolean);
    if (!words.length) { return ''; }

    return words.map(function (word) {
      return '(title:' + word + '* OR venue:' + word + '* OR description:' + word + '* OR ' + word + ')';
    }).join(' AND ');
  }

  function buildQuery(collection, state) {
    var parts = ['collection:' + collection.id];
    var clause = textClause(state.q);
    if (clause) { parts.push(clause); }
    if (/^\d{4}$/.test(state.year || '')) { parts.push('year:' + state.year); }
    return parts.join(' AND ');
  }

  function normalizeDoc(doc) {
    var rec = {
      id: doc.identifier,
      title: doc.title || doc.identifier,
      date: String(doc.date || '').slice(0, 10),
      venue: doc.venue || '',
      source: first(doc.source),
      taper: first(doc.taper)
    };
    rec.venue = venueOf(rec);
    // Other collections keep the city in "coverage" (Motorpsycho has it inside the venue field already).
    var place = first(doc.coverage);
    if (place && rec.venue.indexOf(',') === -1) { rec.venue += ', ' + place; }
    return rec;
  }

  function searchParams(query, rows, page, sort) {
    var params = new URLSearchParams();
    params.set('q', query);
    ['identifier', 'title', 'date', 'venue', 'coverage', 'source', 'taper'].forEach(function (field) { params.append('fl[]', field); });
    params.append('sort[]', sort);
    params.set('rows', String(rows));
    params.set('page', String(page));
    params.set('output', 'json');
    return params;
  }

  /** @returns {Promise<{docs: object[], total: number}>} one page of recordings */
  function search(collection, state, page) {
    var params = searchParams(buildQuery(collection, state), PAGE, page || 1, 'date ' + (state.sort === 'asc' ? 'asc' : 'desc'));

    return fetchJson(SEARCH_URL + '?' + params.toString()).then(function (data) {
      var response = data.response || {};
      return { docs: (response.docs || []).map(normalizeDoc), total: response.numFound || 0 };
    });
  }

  /**
   * Years for the year menu: [{ year, count }] (count is 0 when unknown). A small collection is counted from one
   * request; a big one (Grateful Dead: 18,000 items) only gets the range from its oldest to its newest recording.
   */
  function loadYears(collection) {
    var key = 'years:' + collection.id;

    return storeGet(key).then(function (cached) {
      if (cached && Date.now() - cached.at < CACHE_MS) { return cached.data; }

      var base = 'collection:' + collection.id;
      var one = function (sort) {
        var params = new URLSearchParams();
        params.set('q', base);
        params.append('fl[]', 'date');
        params.append('sort[]', 'date ' + sort);
        params.set('rows', '1');
        params.set('output', 'json');
        return fetchJson(SEARCH_URL + '?' + params.toString());
      };

      return one('asc').then(function (oldest) {
        var total = (oldest.response && oldest.response.numFound) || 0;

        if (total > 0 && total <= COUNT_LIMIT) {
          var params = new URLSearchParams();
          params.set('q', base);
          params.append('fl[]', 'date');
          params.set('rows', String(COUNT_LIMIT));
          params.set('output', 'json');
          return fetchJson(SEARCH_URL + '?' + params.toString()).then(function (data) {
            var counts = {};
            ((data.response && data.response.docs) || []).forEach(function (doc) {
              var year = String(doc.date || '').slice(0, 4);
              if (year) { counts[year] = (counts[year] || 0) + 1; }
            });
            return Object.keys(counts).sort().reverse().map(function (year) { return { year: year, count: counts[year] }; });
          });
        }

        return one('desc').then(function (newest) {
          var from = parseInt(String(((oldest.response.docs || [])[0] || {}).date || '').slice(0, 4), 10);
          var to = parseInt(String(((newest.response.docs || [])[0] || {}).date || '').slice(0, 4), 10);
          var years = [];
          if (from && to) {
            for (var year = to; year >= from; year--) { years.push({ year: String(year), count: 0 }); }
          }
          return years;
        });
      }).then(function (data) {
        storeSet(key, { at: Date.now(), data: data });
        return data;
      });
    });
  }

  /* ------------------------------------------------------------------ recording (tracks) */

  /** Same rules as the MPDB site: only the VBR MP3 derivatives, in track order. */
  function getRecording(id, hint) {
    var key = 'rec:' + id;

    return storeGet(key).then(function (cached) {
      if (cached && cached.v === 3 && Date.now() - cached.at < CACHE_MS) { return cached.data; }

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

        var rec = {
          id: id,
          title: first(meta.title) || (hint && hint.title) || id,
          date: String(first(meta.date) || (hint && hint.date) || '').slice(0, 10),
          venue: first(meta.venue) || (hint && hint.venue) || '',
          source: first(meta.source) || (hint && hint.source) || '',
          taper: first(meta.taper) || (hint && hint.taper) || '',
          artist: first(meta.creator) || '',
          url: 'https://archive.org/details/' + encodeURIComponent(id),
          servers: servers,
          tracks: tracks.map(function (track) { return { title: track.title, seconds: track.seconds, src: track.src, name: track.name }; })
        };
        if (!rec.venue) { rec.venue = venueOf(rec); }
        var place = first(meta.coverage);
        if (place && rec.venue.indexOf(',') === -1) { rec.venue += ', ' + place; }

        storeSet(key, { v: 3, at: Date.now(), data: rec });
        return rec;
      });
    });
  }

  /* ------------------------------------------------------------------ random */

  var DEEP_LIMIT = 9000; // archive.org cannot page past ~10,000 results

  function countFor(query) {
    var params = new URLSearchParams();
    params.set('q', query);
    params.append('fl[]', 'identifier');
    params.set('rows', '0');
    params.set('output', 'json');
    return fetchJson(SEARCH_URL + '?' + params.toString()).then(function (data) {
      return (data.response && data.response.numFound) || 0;
    });
  }

  /**
   * One random track from a random recording of a query (a collection, optionally narrowed by year or text).
   * archive.org's own "random" sort returns the same order every time, so the pick is made here: count the matches,
   * take a random position and fetch just that recording. A collection too big to page through (Grateful Dead)
   * is first narrowed to a random year. A recording without MP3 files is skipped and another one is drawn.
   * Very short tracks (tuning, banter) are avoided when the recording has longer ones.
   * @param {{query: string, collection: string}} cfg
   * @returns {Promise<{rec: object, track: object}>}
   */
  function randomTrack(cfg) {
    var tries = 0;

    function pick(rec) {
      var long = rec.tracks.filter(function (track) { return !track.seconds || track.seconds >= 60; });
      var list = long.length ? long : rec.tracks;
      return list[Math.floor(Math.random() * list.length)];
    }

    function narrow(query, total) {
      if (total <= DEEP_LIMIT) { return Promise.resolve({ query: query, total: total }); }
      return loadYears(collectionById(cfg.collection)).then(function (years) {
        if (!years.length) { return { query: query, total: Math.min(total, DEEP_LIMIT) }; }
        var year = years[Math.floor(Math.random() * years.length)].year;
        var narrowed = query + ' AND year:' + year;
        return countFor(narrowed).then(function (count) { return { query: narrowed, total: Math.min(count, DEEP_LIMIT) }; });
      });
    }

    function attempt() {
      tries += 1;

      return countFor(cfg.query).then(function (total) {
        if (!total) { throw new Error('no recordings'); }
        return narrow(cfg.query, total);
      }).then(function (scope) {
        if (!scope.total) { return null; }
        var position = Math.floor(Math.random() * scope.total);
        var params = searchParams(scope.query, 1, position + 1, 'date desc');
        return fetchJson(SEARCH_URL + '?' + params.toString()).then(function (data) {
          var doc = ((data.response && data.response.docs) || [])[0];
          if (!doc) { return null; }
          var hint = normalizeDoc(doc);
          return getRecording(hint.id, hint).then(function (rec) {
            return rec.tracks.length ? { rec: rec, track: pick(rec) } : null;
          }, function () { return null; });
        });
      }).then(function (found) {
        if (found) { return found; }
        if (tries >= 6) { throw new Error('no playable recording found'); }
        return attempt();
      });
    }

    return attempt();
  }

  root.MPArchive = {
    COLLECTIONS: COLLECTIONS,
    PAGE: PAGE,
    collectionById: collectionById,
    buildQuery: buildQuery,
    search: search,
    loadYears: loadYears,
    getRecording: getRecording,
    randomTrack: randomTrack,
    storeGet: storeGet,
    storeSet: storeSet,
    venueOf: venueOf
  };
}(self));
