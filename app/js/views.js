// DOM rendering for 240x320. All text goes through textContent.
(function (root) {
  'use strict';
  var Kuling = root.Kuling;
  var fc = Kuling.fc;
  var doc = root.document;

  var TOAST_MS = 2500;
  var NOW_HOURS = 4;
  var NOWCAST_MAX_MM_H = 5;
  var NOWCAST_WIDTH_PX = 208; // inner width of the nowcast box
  var toastTimer = null;

  function $(id) { return doc.getElementById(id); }

  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function icon(code, size) {
    var img = el('img', 'ico');
    img.width = size;
    img.height = size;
    img.alt = '';
    if (code) img.src = 'weather/' + code + '.svg';
    return img;
  }

  // Arrow points the way the wind blows: a down arrow (wind from north) rotated by the from-direction.
  function windArrow(fromDeg) {
    var a = el('span', 'arrow', '↓');
    if (typeof fromDeg === 'number') a.style.transform = 'rotate(' + Math.round(fromDeg) + 'deg)';
    return a;
  }

  function windText(speed) { return typeof speed === 'number' ? Math.round(speed) + ' m/s' : ''; }

  function setHeader(place, index, updated) {
    $('place').textContent = place ? (index > 0 ? index + ' ' : '') + place.name : 'Kuling';
    $('updated').textContent = updated || '';
  }

  function setTabs(active, visible) {
    $('tabs').hidden = !visible;
    var tabs = $('tabs').children;
    for (var i = 0; i < tabs.length; i++) tabs[i].className = tabs[i].getAttribute('data-tab') === active ? 'on' : '';
  }

  function setSoftkeys(l, c, r) {
    $('sl').textContent = l || '';
    $('sc').textContent = c || '';
    $('sr').textContent = r || '';
  }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, TOAST_MS);
  }

  function message(text, sub) {
    var main = $('main');
    clear(main);
    var box = el('div', 'msg', text);
    if (sub) box.appendChild(el('div', 'msg-sub', sub));
    main.appendChild(box);
  }

  function attribution(main) {
    main.appendChild(el('div', 'attr', 'Data: MET Norway (CC BY 4.0) · Kartverket'));
  }

  // ---------- Now ----------

  function renderNow(forecast, nowcastJson, nowMs) {
    var main = $('main');
    clear(main);
    var p = fc.currentPoint(forecast, nowMs);
    if (!p) { message('No forecast data'); return; }
    var sym = p.sym1 || p.sym6;

    var hero = el('div', 'hero');
    hero.appendChild(icon(sym, 72));
    var right = el('div', 'hero-r');
    right.appendChild(el('div', 'big ' + (p.temp !== null && p.temp < 0 ? 'cold' : 'warm'), fc.temp(p.temp)));
    right.appendChild(el('div', 'desc', fc.symbolText(sym)));
    hero.appendChild(right);
    main.appendChild(hero);

    var wind = el('div', 'line');
    wind.appendChild(windArrow(p.dir));
    wind.appendChild(el('span', '', ' ' + windText(p.wind) + ' ' + fc.compass(p.dir)));
    var rain = fc.mm(p.mm1);
    wind.appendChild(el('span', 'rain', rain ? rain + ' next hour' : 'Dry next hour'));
    main.appendChild(wind);

    var nc = nowcastJson ? fc.parseNowcast(nowcastJson, nowMs) : null;
    if (nc) main.appendChild(nowcastBlock(nc));

    var strip = el('div', 'strip');
    var rows = fc.hourRows(forecast, nowMs);
    for (var i = 1; i <= NOW_HOURS && i < rows.length; i++) {
      var col = el('div', 'col');
      col.appendChild(el('div', 'col-t', rows[i].time));
      col.appendChild(icon(rows[i].point.sym1, 30));
      col.appendChild(el('div', 'col-v', fc.temp(rows[i].point.temp)));
      strip.appendChild(col);
    }
    main.appendChild(strip);
    attribution(main);
  }

  function nowcastBlock(nc) {
    var box = el('div', 'nc');
    box.appendChild(el('div', 'nc-text', nc.text));
    var bars = el('div', 'nc-bars');
    var barWidth = Math.max(2, Math.floor(NOWCAST_WIDTH_PX / nc.rates.length) - 2);
    for (var i = 0; i < nc.rates.length; i++) {
      var h = Math.min(1, nc.rates[i] / NOWCAST_MAX_MM_H);
      var bar = el('span', nc.rates[i] >= 0.1 ? 'wet' : '');
      bar.style.height = Math.max(1, Math.round(h * 14)) + 'px';
      bar.style.width = barWidth + 'px';
      bars.appendChild(bar);
    }
    box.appendChild(bars);
    return box;
  }

  // ---------- Hours / Days ----------

  function renderHours(forecast, nowMs) {
    var main = $('main');
    clear(main);
    var rows = fc.hourRows(forecast, nowMs);
    var list = el('div', 'rows');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.day) list.appendChild(el('div', 'day-hdr', r.day));
      var row = el('div', 'row');
      row.appendChild(el('span', 'c-time', r.time));
      row.appendChild(icon(r.point.sym1, 26));
      row.appendChild(el('span', 'c-temp ' + (r.point.temp < 0 ? 'cold' : 'warm'), fc.temp(r.point.temp)));
      row.appendChild(el('span', 'c-rain', fc.mm(r.point.mm1)));
      var w = el('span', 'c-wind');
      w.appendChild(el('span', '', windText(r.point.wind) + ' '));
      w.appendChild(windArrow(r.point.dir));
      row.appendChild(w);
      list.appendChild(row);
    }
    main.appendChild(list);
    attribution(main);
  }

  function renderDays(forecast, nowMs) {
    var main = $('main');
    clear(main);
    var rows = fc.dayRows(forecast, nowMs);
    var list = el('div', 'rows');
    for (var i = 0; i < rows.length; i++) {
      var d = rows[i];
      var row = el('div', 'row day');
      row.appendChild(el('span', 'c-day', d.label));
      row.appendChild(icon(d.symbol, 30));
      var t = el('span', 'c-hilo');
      t.appendChild(el('span', d.hi < 0 ? 'cold' : 'warm', fc.temp(d.hi)));
      t.appendChild(el('span', 'lo', ' / ' + fc.temp(d.lo)));
      row.appendChild(t);
      var extra = el('span', 'c-extra');
      extra.appendChild(el('div', 'c-rain', fc.mm(d.mm)));
      extra.appendChild(el('div', 'c-wnd', windText(d.wind)));
      row.appendChild(extra);
      list.appendChild(row);
    }
    main.appendChild(list);
    attribution(main);
  }

  // ---------- Places / search ----------

  // items: [{label, sub, num}] ; index: selected item.
  function renderMenu(items, index) {
    var main = $('main');
    clear(main);
    var ul = el('ul', 'menu');
    for (var i = 0; i < items.length; i++) {
      var li = el('li', i === index ? 'sel' : '');
      if (items[i].num) li.appendChild(el('span', 'num', items[i].num));
      li.appendChild(el('span', 'm-label', items[i].label));
      if (items[i].sub) li.appendChild(el('div', 'm-sub', items[i].sub));
      ul.appendChild(li);
    }
    main.appendChild(ul);
    var sel = ul.children[index];
    if (sel && sel.scrollIntoView) sel.scrollIntoView(false);
  }

  // Search screen: an input plus result rows. focus: -1 = input, else result index.
  function renderSearch(text, results, focus, status) {
    var main = $('main');
    var input = $('q');
    if (!input) {
      clear(main);
      input = el('input', 'q');
      input.id = 'q';
      input.type = 'text';
      input.setAttribute('placeholder', 'Place name');
      main.appendChild(input);
      main.appendChild(el('div', 's-status'));
      var ul = el('ul', 'menu');
      ul.id = 'results';
      main.appendChild(ul);
      input.value = text;
    }
    main.querySelector('.s-status').textContent = status || '';
    var list = $('results');
    clear(list);
    for (var i = 0; i < results.length; i++) {
      var li = el('li', i === focus ? 'sel' : '');
      li.appendChild(el('span', 'm-label', results[i].name));
      if (results[i].sub) li.appendChild(el('div', 'm-sub', results[i].sub));
      list.appendChild(li);
    }
    if (focus < 0) input.focus();
    else {
      input.blur();
      var sel = list.children[focus];
      if (sel && sel.scrollIntoView) sel.scrollIntoView(false);
    }
  }

  function searchText() {
    var input = $('q');
    return input ? input.value : '';
  }

  function scroll(dy) { $('main').scrollTop += dy; }
  function scrollTop() { $('main').scrollTop = 0; }

  Kuling.views = {
    setHeader: setHeader,
    setTabs: setTabs,
    setSoftkeys: setSoftkeys,
    toast: toast,
    message: message,
    renderNow: renderNow,
    renderHours: renderHours,
    renderDays: renderDays,
    renderMenu: renderMenu,
    renderSearch: renderSearch,
    searchText: searchText,
    scroll: scroll,
    scrollTop: scrollTop
  };
})(this);
