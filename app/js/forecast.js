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
  var LOCAL_NOON = 12; // the day's icon is the 6-hour block starting closest to local noon
  var DAY_MS = 86400000;

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // Times are shown in the place's own time. `offset` is the place's UTC offset in seconds,
  // or null/undefined to use the phone's time zone. Callers read the result with getUTC* only.
  function wall(ms, offset) {
    var off = typeof offset === 'number' ? offset : -new Date(ms).getTimezoneOffset() * 60;
    return new Date(ms + off * 1000);
  }

  function hhmm(ms, offset) {
    var w = wall(ms, offset);
    return pad(w.getUTCHours()) + ':' + pad(w.getUTCMinutes());
  }

  // Hour label for lists: "07", or "07:30" in half-hour zones.
  function hourLabel(ms, offset) {
    var w = wall(ms, offset);
    return pad(w.getUTCHours()) + (w.getUTCMinutes() ? ':' + pad(w.getUTCMinutes()) : '');
  }

  function dayKey(ms, offset) {
    var w = wall(ms, offset);
    return w.getUTCFullYear() + '-' + pad(w.getUTCMonth() + 1) + '-' + pad(w.getUTCDate());
  }

  function dayLabel(ms, nowMs, offset) {
    var key = dayKey(ms, offset);
    if (key === dayKey(nowMs, offset)) return 'Today';
    if (key === dayKey(nowMs + DAY_MS, offset)) return 'Tomorrow';
    var w = wall(ms, offset);
    return DAYS[w.getUTCDay()] + ' ' + w.getUTCDate() + '.';
  }

  // "UTC+2", "UTC-4", "UTC+5:30".
  function utcLabel(offset) {
    var sign = offset < 0 ? '-' : '+';
    var abs = Math.abs(offset);
    var h = Math.floor(abs / 3600);
    var m = Math.round((abs % 3600) / 60);
    return 'UTC' + sign + h + (m ? ':' + pad(m) : '');
  }

  // True when the place's clock differs from the phone's at `ms`.
  function differsFromPhone(offset, ms) {
    return typeof offset === 'number' && offset !== -new Date(ms).getTimezoneOffset() * 60;
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
  function hourRows(fc, nowMs, offset) {
    var rows = [];
    var lastDay = null;
    var hourStart = nowMs - (nowMs % 3600000);
    for (var i = 0; i < fc.points.length && rows.length < MAX_HOURS; i++) {
      var p = fc.points[i];
      if (p.t < hourStart || !p.sym1) continue;
      var key = dayKey(p.t, offset);
      rows.push({ day: key !== lastDay ? dayLabel(p.t, nowMs, offset) : null, time: hourLabel(p.t, offset), point: p });
      lastDay = key;
    }
    return rows;
  }

  // One row per local day: high/low, total precipitation, strongest wind, a daytime symbol.
  function dayRows(fc, nowMs, offset) {
    var byKey = {};
    var order = [];
    var todayKey = dayKey(nowMs, offset);
    for (var i = 0; i < fc.points.length; i++) {
      var p = fc.points[i];
      var d = new Date(p.t);
      var key = dayKey(p.t, offset);
      if (key < todayKey) continue;
      var day = byKey[key];
      if (!day) {
        day = byKey[key] = { key: key, label: dayLabel(p.t, nowMs, offset), hi: null, lo: null, mm: 0, wind: null,
                             symbol: null, symbolDist: 99 };
        order.push(key);
      }
      if (p.temp !== null) {
        day.hi = day.hi === null ? p.temp : Math.max(day.hi, p.temp);
        day.lo = day.lo === null ? p.temp : Math.min(day.lo, p.temp);
      }
      if (p.wind !== null) day.wind = day.wind === null ? p.wind : Math.max(day.wind, p.wind);
      // Sum non-overlapping 6-hour blocks (00/06/12/18 UTC) so nothing is counted twice.
      if (d.getUTCHours() % 6 === 0) {
        if (p.mm6 !== null) day.mm += p.mm6;
        var dist = Math.abs(wall(p.t, offset).getUTCHours() - LOCAL_NOON);
        if (p.sym6 && dist < day.symbolDist) { day.symbol = p.sym6; day.symbolDist = dist; }
      } else if (!day.symbol && p.sym6) {
        day.symbol = p.sym6; // no block start on this day yet (e.g. late today)
      }
    }
    var rows = [];
    for (var k = 0; k < order.length && rows.length < MAX_DAYS; k++) {
      var day2 = byKey[order[k]];
      rows.push({ label: day2.label, hi: day2.hi, lo: day2.lo, mm: Math.round(day2.mm * 10) / 10, wind: day2.wind,
                  symbol: day2.symbol });
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
    wall: wall,
    hhmm: hhmm,
    hourLabel: hourLabel,
    dayKey: dayKey,
    dayLabel: dayLabel,
    utcLabel: utcLabel,
    differsFromPhone: differsFromPhone,
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
