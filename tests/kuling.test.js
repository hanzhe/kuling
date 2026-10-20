// Run: npm test   (times are checked in Norwegian local time)
'use strict';
process.env.TZ = 'Europe/Oslo';
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var JS = path.join(__dirname, '..', 'app', 'js');
var FIX = path.join(__dirname, 'fixtures');

function load() {
  var sb = { Math: Math, Date: Date, JSON: JSON, Promise: Promise, Infinity: Infinity };
  vm.createContext(sb);
  ['symbols.js', 'forecast.js', 'places.js', 'data.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), sb, { filename: f });
  });
  return sb.Kuling;
}

function fixture(name) { return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8')); }
function plain(x) { return JSON.parse(JSON.stringify(x)); }

// Synthetic forecast: hourly points from `startIso` with given temps, then 6-hourly.
function series(startIso, hourly, sixHourly) {
  var t0 = Date.parse(startIso);
  var ts = [];
  for (var i = 0; i < hourly.length; i++) {
    ts.push({ time: new Date(t0 + i * 3600000).toISOString(), data: {
      instant: { details: { air_temperature: hourly[i], wind_speed: 3 + i, wind_from_direction: 90 } },
      next_1_hours: { summary: { symbol_code: 'cloudy' }, details: { precipitation_amount: i === 2 ? 0.4 : 0 } },
      next_6_hours: { summary: { symbol_code: i % 6 === 0 ? 'rain' : 'cloudy' }, details: { precipitation_amount: 1 } }
    } });
  }
  var t1 = t0 + hourly.length * 3600000;
  for (var j = 0; j < (sixHourly || 0); j++) {
    ts.push({ time: new Date(t1 + j * 6 * 3600000).toISOString(), data: {
      instant: { details: { air_temperature: -2, wind_speed: 10 } },
      next_6_hours: { summary: { symbol_code: 'snow' }, details: { precipitation_amount: 2 } }
    } });
  }
  return { properties: { meta: { updated_at: startIso }, timeseries: ts } };
}

// ---------- formatting ----------

test('temp rounds and never shows -0', function () {
  var fc = load().fc;
  assert.strictEqual(fc.temp(6.6), '7°');
  assert.strictEqual(fc.temp(-0.4), '0°');
  assert.strictEqual(fc.temp(-3.5), '-3°');
  assert.strictEqual(fc.temp(null), '-');
});

test('mm formats small and large amounts, hides zero', function () {
  var fc = load().fc;
  assert.strictEqual(fc.mm(0), '');
  assert.strictEqual(fc.mm(null), '');
  assert.strictEqual(fc.mm(0.44), '0.4 mm');
  assert.strictEqual(fc.mm(12.6), '13 mm');
});

test('compass points', function () {
  var fc = load().fc;
  assert.deepStrictEqual([0, 43, 90, 180, 225, 337, 359, 360, -45].map(fc.compass),
    ['N', 'NE', 'E', 'S', 'SW', 'NW', 'N', 'N', 'NW']);
  assert.strictEqual(fc.compass(undefined), '');
});

test('symbolText strips day/night variants', function () {
  var fc = load().fc;
  assert.strictEqual(fc.symbolText('partlycloudy_night'), 'Partly cloudy');
  assert.strictEqual(fc.symbolText('heavyrainshowersandthunder_polartwilight'), 'Heavy rain showers and thunder');
  assert.strictEqual(fc.symbolText('nonsense'), '');
});

test('dayLabel says Today / Tomorrow / weekday', function () {
  var fc = load().fc;
  var now = new Date(2026, 9, 20, 22, 0);
  assert.strictEqual(fc.dayLabel(new Date(2026, 9, 20, 23, 0), now), 'Today');
  assert.strictEqual(fc.dayLabel(new Date(2026, 9, 21, 1, 0), now), 'Tomorrow');
  assert.strictEqual(fc.dayLabel(new Date(2026, 9, 22, 12, 0), now), 'Thu 22.');
});

// ---------- forecast ----------

test('parseForecast on a real MET response keeps the fields we show', function () {
  var fc = load().fc;
  var f = fc.parseForecast(fixture('forecast-oslo.json'));
  assert.ok(f.points.length > 60);
  var p = f.points[0];
  assert.strictEqual(typeof p.temp, 'number');
  assert.strictEqual(typeof p.wind, 'number');
  assert.ok(p.sym1);
  assert.ok(f.updatedAt > 0);
  var last = f.points[f.points.length - 1];
  assert.strictEqual(last.sym1, null);
  assert.strictEqual(fc.parseForecast({}), null);
});

test('real forecast: hour rows <= 48 with day labels, day rows <= 9 with symbols', function () {
  var fc = load().fc;
  var f = fc.parseForecast(fixture('forecast-oslo.json'));
  var now = f.points[0].t + 10 * 60000;
  var hours = fc.hourRows(f, now);
  assert.ok(hours.length > 24 && hours.length <= 48);
  assert.ok(hours[0].day);
  var days = fc.dayRows(f, now);
  assert.ok(days.length >= 7 && days.length <= 9);
  days.forEach(function (d) {
    assert.ok(d.symbol, d.label);
    assert.ok(d.hi >= d.lo, d.label);
  });
  assert.strictEqual(days[0].label, 'Today');
});

test('currentPoint picks the latest point not in the future', function () {
  var fc = load().fc;
  var f = fc.parseForecast(series('2026-10-20T10:00:00Z', [1, 2, 3]));
  assert.strictEqual(fc.currentPoint(f, Date.parse('2026-10-20T11:30:00Z')).temp, 2);
  assert.strictEqual(fc.currentPoint(f, Date.parse('2026-10-20T08:00:00Z')).temp, 1);
});

test('hourRows starts at the current hour and labels date changes', function () {
  var fc = load().fc;
  // 20:00Z = 22:00 Oslo (CEST), so 22, 23, then 00 on the next day.
  var f = fc.parseForecast(series('2026-10-20T19:00:00Z', [5, 6, 7, 8, 9]));
  var rows = fc.hourRows(f, Date.parse('2026-10-20T20:15:00Z'));
  assert.deepStrictEqual(plain(rows.map(function (r) { return r.time; })), ['22', '23', '00', '01']);
  assert.ok(rows[0].day);
  assert.strictEqual(rows[1].day, null);
  assert.ok(rows[2].day);
});

test('dayRows: high/low, wind max, 6h precip counted once per block', function () {
  var fc = load().fc;
  // 24 hourly points from 00:00Z: every point carries next_6_hours = 1 mm, but only
  // the 00/06/12/18Z blocks may count -> 4 mm for that span.
  var temps = [];
  for (var i = 0; i < 24; i++) temps.push(i - 5);
  var f = fc.parseForecast(series('2026-10-21T00:00:00Z', temps, 4));
  var days = fc.dayRows(f, Date.parse('2026-10-21T00:30:00Z'));
  // Oslo is UTC+2: 00Z..21Z is Oct 21 local (02..23), 22Z..23Z is Oct 22.
  assert.strictEqual(days[0].hi, 16);
  assert.strictEqual(days[0].lo, -5);
  assert.strictEqual(days[0].mm, 4);
  assert.strictEqual(days[0].symbol, 'rain');
  assert.strictEqual(days[1].symbol, 'snow');
  assert.strictEqual(days[1].lo, -2);
  assert.strictEqual(days[1].wind, 26); // hourly 22Z-23Z winds are 25-26; 6-hourly ones are 10
});

// ---------- nowcast ----------

test('describeNowcast covers dry, rain starting, rain stopping, all wet', function () {
  var fc = load().fc;
  assert.strictEqual(fc.describeNowcast([0, 0, 0]), 'No rain next 15 min');
  assert.strictEqual(fc.describeNowcast([0, 0, 0.5, 1]), 'Rain in ~10 min');
  assert.strictEqual(fc.describeNowcast([2, 0.3, 0, 0]), 'Rain stops in ~10 min');
  assert.strictEqual(fc.describeNowcast([1, 1]), 'Rain for the next 10 min');
  assert.strictEqual(fc.describeNowcast([0.05, 0.09]), 'No rain next 10 min');
});

test('parseNowcast on a real response; skips past steps; rejects bad coverage', function () {
  var fc = load().fc;
  var json = fixture('nowcast-oslo.json');
  var first = Date.parse(json.properties.timeseries[0].time);
  var all = fc.parseNowcast(json, first);
  assert.strictEqual(all.rates.length, json.properties.timeseries.length);
  assert.ok(all.text);
  var later = fc.parseNowcast(json, first + 20 * 60000);
  assert.strictEqual(later.rates.length, all.rates.length - 4);
  var noRadar = JSON.parse(JSON.stringify(json));
  noRadar.properties.meta = { radar_coverage: 'temporarily unavailable' };
  assert.strictEqual(fc.parseNowcast(noRadar, first), null);
  assert.strictEqual(fc.parseNowcast({}, first), null);
});

// ---------- places ----------

test('makePlace rounds to 4 decimals (MET rejects 5+)', function () {
  var pl = load().places;
  var p = pl.makePlace('X', '', 59.913912345, 10.752245678);
  assert.strictEqual(p.lat, 59.9139);
  assert.strictEqual(p.lon, 10.7522);
  assert.strictEqual(pl.placeKey(p), '59.9139,10.7522');
});

test('addPlace moves duplicates to the end, caps at 9, never mutates', function () {
  var pl = load().places;
  var a = pl.makePlace('A', '', 1, 1);
  var b = pl.makePlace('B', '', 2, 2);
  var list = [a, b];
  var again = pl.addPlace(list, pl.makePlace('A again', '', 1, 1));
  assert.deepStrictEqual(plain(again.map(function (p) { return p.name; })), ['B', 'A again']);
  assert.strictEqual(list.length, 2);
  var full = [];
  for (var i = 0; i < 9; i++) full.push(pl.makePlace('P' + i, '', i, i));
  assert.strictEqual(pl.addPlace(full, pl.makePlace('Z', '', 50, 50)), null);
  assert.strictEqual(pl.addPlace(full, pl.makePlace('P3', '', 3, 3)).length, 9);
  assert.deepStrictEqual(plain(pl.removePlace([a, b], 0)), plain([b]));
});

test('cleanPlaces drops junk from storage', function () {
  var pl = load().places;
  var out = pl.cleanPlaces([{ name: 'Ok', lat: 60, lon: 5 }, { name: 'Bad', lat: 'x', lon: 5 }, null,
    { name: 'Far', lat: 95, lon: 5 }]);
  assert.deepStrictEqual(plain(out.map(function (p) { return p.name; })), ['Ok']);
  assert.strictEqual(pl.cleanPlaces(null).length, 0);
});

test('parseSearch on a real Geonorge response', function () {
  var pl = load().places;
  var res = pl.parseSearch(fixture('search-bergen.json'));
  assert.ok(res.length >= 3);
  assert.strictEqual(res[0].name, 'Bergen');
  assert.strictEqual(res[0].sub, 'By, Bergen');
  assert.ok(Math.abs(res[0].lat - 60.3932) < 0.001);
  assert.strictEqual(pl.parseSearch({}).length, 0);
});

test('municipalityName', function () {
  var pl = load().places;
  assert.strictEqual(pl.municipalityName({ kommunenavn: 'Bergen' }), 'Bergen');
  assert.strictEqual(pl.municipalityName({}), null);
  assert.strictEqual(pl.municipalityName(null), null);
});

// ---------- data / cache ----------

function memStore() {
  var m = {};
  return {
    get: function (k) { return m[k] === undefined ? null : JSON.parse(m[k]); },
    set: function (k, v) { m[k] = JSON.stringify(v); },
    remove: function (k) { delete m[k]; },
    keys: function () { return Object.keys(m); }
  };
}

function fakeFetch(responses) {
  var calls = [];
  var fn = function (url, headers) {
    calls.push({ url: url, headers: headers });
    return Promise.resolve(responses.shift());
  };
  fn.calls = calls;
  return fn;
}

var OSLO = { name: 'Oslo', sub: '', lat: 59.9139, lon: 10.7522 };
var FC_JSON = series('2026-10-20T10:00:00Z', [1, 2]);

test('forecast: first fetch stores; within Expires no request; force before Expires is refused', function () {
  var K = load();
  var store = memStore();
  var t = 1000000;
  var fetch = fakeFetch([{ status: 200, data: FC_JSON, expires: t + 60000, lastModified: 'LM1' }]);
  var data = K.createData(store, fetch, function () { return t; });
  return data.forecast(OSLO, false).then(function (r) {
    assert.ok(r.fresh);
    assert.strictEqual(r.entry.value.points.length, 2);
    assert.match(fetch.calls[0].url, /lat=59\.9139&lon=10\.7522$/);
    return data.forecast(OSLO, false);
  }).then(function (r) {
    assert.strictEqual(fetch.calls.length, 1);
    assert.ok(!r.notYet);
    return data.forecast(OSLO, true);
  }).then(function (r) {
    assert.strictEqual(fetch.calls.length, 1, 'must not hit MET before Expires');
    assert.ok(r.notYet);
  });
});

test('forecast: after Expires sends If-Modified-Since; 304 keeps data and extends Expires', function () {
  var K = load();
  var store = memStore();
  var t = 1000000;
  var fetch = fakeFetch([
    { status: 200, data: FC_JSON, expires: t + 60000, lastModified: 'LM1' },
    { status: 304, data: null, expires: t + 200000, lastModified: '' }
  ]);
  var data = K.createData(store, fetch, function () { return t; });
  return data.forecast(OSLO, false).then(function () {
    t += 120000;
    return data.forecast(OSLO, false);
  }).then(function (r) {
    assert.strictEqual(fetch.calls[1].headers['If-Modified-Since'], 'LM1');
    assert.strictEqual(r.entry.value.points.length, 2);
    assert.strictEqual(r.entry.expires, 1000000 + 200000);
    assert.strictEqual(r.entry.lastModified, 'LM1');
  });
});

test('forecast: network failure keeps the saved forecast and reports why', function () {
  var K = load();
  var store = memStore();
  var t = 1000000;
  var fetch = fakeFetch([
    { status: 200, data: FC_JSON, expires: t + 1000, lastModified: 'LM1' },
    { status: 0, data: null, expires: 0, lastModified: '' }
  ]);
  var data = K.createData(store, fetch, function () { return t; });
  return data.forecast(OSLO, false).then(function () {
    t += 5000;
    return data.forecast(OSLO, false);
  }).then(function (r) {
    assert.strictEqual(r.error, 'No connection');
    assert.ok(!r.fresh);
    assert.strictEqual(r.entry.value.points.length, 2);
  });
});

test('forecast: missing Expires header falls back to a 30 min cache', function () {
  var K = load();
  var t = 1000000;
  var fetch = fakeFetch([{ status: 200, data: FC_JSON, expires: 0, lastModified: '' }]);
  var data = K.createData(memStore(), fetch, function () { return t; });
  return data.forecast(OSLO, false).then(function (r) {
    assert.strictEqual(r.entry.expires, t + 30 * 60000);
  });
});

test('forget removes both caches for a place', function () {
  var K = load();
  var store = memStore();
  var t = 1000000;
  var fetch = fakeFetch([
    { status: 200, data: FC_JSON, expires: t + 1000, lastModified: '' },
    { status: 200, data: fixture('nowcast-oslo.json'), expires: t + 1000, lastModified: '' }
  ]);
  var data = K.createData(store, fetch, function () { return t; });
  return data.forecast(OSLO).then(function () { return data.nowcast(OSLO); }).then(function () {
    assert.strictEqual(store.keys().length, 2);
    data.forget(OSLO);
    assert.strictEqual(store.keys().length, 0);
  });
});

test('search and municipality build the right URLs and handle errors', function () {
  var K = load();
  var fetch = fakeFetch([
    { status: 200, data: fixture('search-bergen.json') },
    { status: 500, data: null },
    { status: 200, data: { kommunenavn: 'Bergen' } }
  ]);
  var data = K.createData(memStore(), fetch);
  return data.search('Bergen').then(function (r) {
    assert.match(fetch.calls[0].url, /stedsnavn\/v1\/navn\?sok=Bergen&fuzzy=true/);
    assert.ok(r.places.length);
    return data.search('x y');
  }).then(function (r) {
    assert.strictEqual(r.error, 'Weather service error (500)');
    assert.match(fetch.calls[1].url, /sok=x%20y/);
    return data.municipality(60.39134, 5.32212);
  }).then(function (name) {
    assert.strictEqual(name, 'Bergen');
    assert.match(fetch.calls[2].url, /nord=60\.3913&ost=5\.3221&koordsys=4258/);
  });
});

test('errorText', function () {
  var K = load();
  assert.strictEqual(K.errorText(0), 'No connection');
  assert.strictEqual(K.errorText(429), 'Too many requests, try later');
  assert.strictEqual(K.errorText(403), 'Blocked by the weather service (403)');
  assert.strictEqual(K.errorText(404), 'Error 404');
});
