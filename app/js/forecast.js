// Pure forecast logic: parse MET responses, build hour/day rows, describe nowcast.
// ES5 only (Gecko 48). Loaded in node for tests via vm.
(function (root) {
  'use strict';
  var Kuling = root.Kuling = root.Kuling || {};

  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  var WET_MM_PER_H = 0.1;
  var NOWCAST_STEP_MIN = 5;
  var MAX_HOURS = 48;
  var MAX_DAYS = 9;
  // Pick the 6-hour block starting at 12 UTC as the day's icon, like Yr's daytime symbol.
  var DAY_SYMBOL_HOURS = [12, 6, 18, 0];

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function hhmm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  function dayKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  function dayLabel(d, now) {
    if (dayKey(d) === dayKey(now)) return 'Today';
    var tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    if (dayKey(d) === dayKey(tomorrow)) return 'Tomorrow';
    return DAYS[d.getDay()] + ' ' + d.getDate() + '.';
  }

  function compass(fromDeg) {
    if (typeof fromDeg !== 'number') return '';
    return COMPASS[Math.round((((fromDeg % 360) + 360) % 360) / 45) % 8];
  }

  // "-0" reads oddly on a thermometer.
  function temp(t) {
    if (typeof t !== 'number') return '-';
    var r = Math.round(t);
    return (r === 0 ? 0 : r) + '°';
  }

  function mm(x) {
    if (typeof x !== 'number' || x <= 0) return '';
    return (x < 10 ? Math.round(x * 10) / 10 : Math.round(x)) + ' mm';
  }

  function baseSymbol(code) { return (code || '').replace(/_(day|night|polartwilight)$/, ''); }

  function symbolText(code) {
    var names = Kuling.SYMBOL_NAMES || {};
    return names[baseSymbol(code)] || '';
  }

  function num(x) { return typeof x === 'number' ? x : null; }

  // Keeps only the fields the app shows, so the cache stays small.
  function parseForecast(json) {
    var props = json && json.properties;
    if (!props || !props.timeseries) return null;
    var points = [];
    for (var i = 0; i < props.timeseries.length; i++) {
      var ts = props.timeseries[i];
      var d = ts.data || {};
      var inst = (d.instant && d.instant.details) || {};
      var n1 = d.next_1_hours;
      var n6 = d.next_6_hours;
      points.push({
        t: Date.parse(ts.time),
        temp: num(inst.air_temperature),
        wind: num(inst.wind_speed),
        dir: num(inst.wind_from_direction),
        sym1: n1 && n1.summary ? n1.summary.symbol_code : null,
        mm1: n1 && n1.details ? num(n1.details.precipitation_amount) : null,
        sym6: n6 && n6.summary ? n6.summary.symbol_code : null,
        mm6: n6 && n6.details ? num(n6.details.precipitation_amount) : null
      });
    }
    return { updatedAt: Date.parse(props.meta && props.meta.updated_at) || null, points: points };
  }

  // The point covering `nowMs` (the latest one not in the future), or the first.
  function currentPoint(fc, nowMs) {
    var best = null;
    for (var i = 0; i < fc.points.length; i++) {
      if (fc.points[i].t <= nowMs) best = fc.points[i];
      else break;
    }
    return best || fc.points[0] || null;
  }

  // Hourly rows from the current hour, at most 48, with a day label where the date changes.
  function hourRows(fc, nowMs) {
    var rows = [];
    var lastDay = null;
    var now = new Date(nowMs);
    var hourStart = nowMs - (nowMs % 3600000);
    for (var i = 0; i < fc.points.length && rows.length < MAX_HOURS; i++) {
      var p = fc.points[i];
      if (p.t < hourStart || !p.sym1) continue;
      var d = new Date(p.t);
      var key = dayKey(d);
      rows.push({ day: key !== lastDay ? dayLabel(d, now) : null, time: pad(d.getHours()), point: p });
      lastDay = key;
    }
    return rows;
  }

  // One row per local day: high/low, total precipitation, strongest wind, a daytime symbol.
  function dayRows(fc, nowMs) {
    var byKey = {};
    var order = [];
    var now = new Date(nowMs);
    var todayKey = dayKey(now);
    for (var i = 0; i < fc.points.length; i++) {
      var p = fc.points[i];
      var d = new Date(p.t);
      var key = dayKey(d);
      if (key < todayKey) continue;
      var day = byKey[key];
      if (!day) {
        day = byKey[key] = { key: key, label: dayLabel(d, now), hi: null, lo: null, mm: 0, wind: null, symbols: {} };
        order.push(key);
      }
      if (p.temp !== null) {
        day.hi = day.hi === null ? p.temp : Math.max(day.hi, p.temp);
        day.lo = day.lo === null ? p.temp : Math.min(day.lo, p.temp);
      }
      if (p.wind !== null) day.wind = day.wind === null ? p.wind : Math.max(day.wind, p.wind);
      // Sum non-overlapping 6-hour blocks (00/06/12/18 UTC) so nothing is counted twice.
      var utcHour = d.getUTCHours();
      if (utcHour % 6 === 0 && p.mm6 !== null) day.mm += p.mm6;
      if (p.sym6 && day.symbols[utcHour] === undefined) day.symbols[utcHour] = p.sym6;
    }
    var rows = [];
    for (var k = 0; k < order.length && rows.length < MAX_DAYS; k++) {
      var day2 = byKey[order[k]];
      var sym = null;
      for (var h = 0; h < DAY_SYMBOL_HOURS.length && !sym; h++) sym = day2.symbols[DAY_SYMBOL_HOURS[h]] || null;
      if (!sym) for (var any in day2.symbols) { if (day2.symbols.hasOwnProperty(any)) { sym = day2.symbols[any]; break; } }
      rows.push({ label: day2.label, hi: day2.hi, lo: day2.lo, mm: Math.round(day2.mm * 10) / 10, wind: day2.wind, symbol: sym });
    }
    return rows;
  }

  // Nowcast: rates (mm/h) every 5 minutes from now. Returns {text, rates} or null when unusable.
  function parseNowcast(json, nowMs) {
    var props = json && json.properties;
    if (!props || !props.timeseries || !props.timeseries.length) return null;
    if (props.meta && props.meta.radar_coverage && props.meta.radar_coverage !== 'ok') return null;
    var rates = [];
    for (var i = 0; i < props.timeseries.length; i++) {
      var ts = props.timeseries[i];
      var t = Date.parse(ts.time);
      if (t + NOWCAST_STEP_MIN * 60000 <= nowMs) continue;
      var det = ts.data && ts.data.instant && ts.data.instant.details;
      rates.push(det && typeof det.precipitation_rate === 'number' ? det.precipitation_rate : 0);
    }
    if (!rates.length) return null;
    return { text: describeNowcast(rates), rates: rates };
  }

  function describeNowcast(rates) {
    var wetNow = rates[0] >= WET_MM_PER_H;
    for (var i = 1; i < rates.length; i++) {
      if ((rates[i] >= WET_MM_PER_H) !== wetNow) {
        var mins = i * NOWCAST_STEP_MIN;
        return wetNow ? 'Rain stops in ~' + mins + ' min' : 'Rain in ~' + mins + ' min';
      }
    }
    var span = rates.length * NOWCAST_STEP_MIN;
    return wetNow ? 'Rain for the next ' + span + ' min' : 'No rain next ' + span + ' min';
  }

  Kuling.fc = {
    pad: pad,
    hhmm: hhmm,
    dayKey: dayKey,
    dayLabel: dayLabel,
    compass: compass,
    temp: temp,
    mm: mm,
    baseSymbol: baseSymbol,
    symbolText: symbolText,
    parseForecast: parseForecast,
    currentPoint: currentPoint,
    hourRows: hourRows,
    dayRows: dayRows,
    parseNowcast: parseNowcast,
    describeNowcast: describeNowcast
  };
})(this);
