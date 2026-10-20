// Network + cache. Follows MET's terms: identify with a User-Agent, never refetch before
// `Expires`, and send If-Modified-Since so unchanged data costs a 304 instead of a download.
(function (root) {
  'use strict';
  var Kuling = root.Kuling = root.Kuling || {};

  var USER_AGENT = 'kuling/1.0 https://github.com/hanzhe';
  var FORECAST_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
  var NOWCAST_URL = 'https://api.met.no/weatherapi/nowcast/2.0/complete';
  var SEARCH_URL = 'https://ws.geonorge.no/stedsnavn/v1/navn';
  var MUNICIPALITY_URL = 'https://ws.geonorge.no/kommuneinfo/v1/punkt';
  var TIMEOUT_MS = 20000;
  var FALLBACK_TTL_MS = 30 * 60000;
  var SEARCH_HITS = 10;

  function query(obj) {
    var parts = [];
    for (var k in obj) {
      if (obj.hasOwnProperty(k)) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
    }
    return parts.join('&');
  }

  // XHR as a Promise that never rejects. mozSystem (systemXHR permission) skips CORS and
  // lets us set a real User-Agent on Gecko 48.
  function request(url, headers) {
    return new Promise(function (resolve) {
      var xhr;
      try { xhr = new root.XMLHttpRequest({ mozSystem: true }); } catch (e) { xhr = new root.XMLHttpRequest(); }
      var done = false;
      function finish(status) {
        if (done) return;
        done = true;
        var data = null;
        if (status === 200) {
          try { data = JSON.parse(xhr.responseText); } catch (e) { status = -1; }
        }
        resolve({
          status: status,
          data: data,
          expires: Date.parse(header(xhr, 'Expires')) || 0,
          lastModified: header(xhr, 'Last-Modified')
        });
      }
      try {
        xhr.open('GET', url, true);
        xhr.timeout = TIMEOUT_MS;
        try { xhr.setRequestHeader('User-Agent', USER_AGENT); } catch (e) { /* engine forbids it */ }
        for (var k in headers || {}) {
          if (headers.hasOwnProperty(k) && headers[k]) xhr.setRequestHeader(k, headers[k]);
        }
        xhr.onload = function () { finish(xhr.status); };
        xhr.onerror = function () { finish(0); };
        xhr.ontimeout = function () { finish(0); };
        xhr.send(null);
      } catch (e) {
        finish(0);
      }
    });
  }

  function header(xhr, name) {
    try { return xhr.getResponseHeader(name) || ''; } catch (e) { return ''; }
  }

  // storage: {get(key), set(key, value), remove(key)}; fetcher: request-compatible (for tests).
  function createData(storage, fetcher, now) {
    var get = fetcher || request;
    var clock = now || function () { return Date.now(); };

    // Returns a Promise of {entry, fresh, error, notYet}. entry = {value, expires, lastModified}
    // or null. A forced refresh before `Expires` is refused (notYet) rather than sent to MET.
    function cached(key, url, parse, force) {
      var entry = storage.get(key);
      if (entry && clock() < entry.expires) {
        return Promise.resolve({ entry: entry, fresh: true, error: null, notYet: !!force });
      }
      var headers = entry && entry.lastModified ? { 'If-Modified-Since': entry.lastModified } : {};
      return get(url, headers).then(function (res) {
        var expires = res.expires > clock() ? res.expires : clock() + FALLBACK_TTL_MS;
        if (res.status === 304 && entry) {
          var kept = { value: entry.value, expires: expires, lastModified: res.lastModified || entry.lastModified };
          storage.set(key, kept);
          return { entry: kept, fresh: true, error: null };
        }
        var value = res.status === 200 ? parse(res.data) : null;
        if (value) {
          var next = { value: value, expires: expires, lastModified: res.lastModified };
          storage.set(key, next);
          return { entry: next, fresh: true, error: null };
        }
        return { entry: entry || null, fresh: false, error: errorText(res.status) };
      });
    }

    function coords(place) { return { lat: place.lat.toFixed(4), lon: place.lon.toFixed(4) }; }

    function forecast(place, force) {
      return cached('kuling.fc.' + Kuling.places.placeKey(place), FORECAST_URL + '?' + query(coords(place)),
        Kuling.fc.parseForecast, force);
    }

    // Raw JSON is cached (it is small) so the "minutes from now" text is recomputed at render time.
    function nowcast(place) {
      return cached('kuling.nc.' + Kuling.places.placeKey(place), NOWCAST_URL + '?' + query(coords(place)),
        function (json) { return json && json.properties ? json : null; }, false);
    }

    function forget(place) {
      var key = Kuling.places.placeKey(place);
      storage.remove('kuling.fc.' + key);
      storage.remove('kuling.nc.' + key);
    }

    function search(text) {
      var url = SEARCH_URL + '?' + query({ sok: text, fuzzy: 'true', utkoordsys: 4258, treffPerSide: SEARCH_HITS, side: 1 });
      return get(url, {}).then(function (res) {
        if (res.status !== 200) return { places: [], error: errorText(res.status) };
        return { places: Kuling.places.parseSearch(res.data), error: null };
      });
    }

    function municipality(lat, lon) {
      var url = MUNICIPALITY_URL + '?' + query({ nord: lat.toFixed(4), ost: lon.toFixed(4), koordsys: 4258 });
      return get(url, {}).then(function (res) {
        return res.status === 200 ? Kuling.places.municipalityName(res.data) : null;
      });
    }

    return { forecast: forecast, nowcast: nowcast, forget: forget, search: search, municipality: municipality };
  }

  function errorText(status) {
    if (status === 0) return 'No connection';
    if (status === 429) return 'Too many requests, try later';
    if (status === 403) return 'Blocked by the weather service (403)';
    if (status === -1) return 'Bad data from server';
    if (status >= 500) return 'Weather service error (' + status + ')';
    return 'Error ' + status;
  }

  // localStorage wrapped so a blocked/full store never breaks the app.
  function localStore() {
    return {
      get: function (k) {
        try { return JSON.parse(root.localStorage.getItem(k) || 'null'); } catch (e) { return null; }
      },
      set: function (k, v) {
        try { root.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full or blocked */ }
      },
      remove: function (k) {
        try { root.localStorage.removeItem(k); } catch (e) { /* blocked */ }
      }
    };
  }

  Kuling.createData = createData;
  Kuling.localStore = localStore;
  Kuling.errorText = errorText;
})(this);
