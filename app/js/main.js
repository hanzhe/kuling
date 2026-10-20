// Kuling: state, screens and keys.
(function (root) {
  'use strict';
  var Kuling = root.Kuling;
  var places = Kuling.places;
  var fc = Kuling.fc;
  var views = Kuling.views;
  var store = Kuling.localStore();
  var data = Kuling.createData(store);

  var PLACES_KEY = 'kuling.places';
  var CURRENT_KEY = 'kuling.current';
  var TAB_KEY = 'kuling.tab';
  var TABS = ['now', 'hours', 'days'];
  var SCROLL_PX = 60;
  var RERENDER_MS = 60000;
  var GPS_OPTIONS = { enableHighAccuracy: false, timeout: 30000, maximumAge: 10 * 60000 };
  var DEFAULT_PLACES = [places.makePlace('Oslo', 'By, Oslo', 59.9133, 10.7389)];

  var savedPlaces = places.cleanPlaces(store.get(PLACES_KEY));
  if (!savedPlaces.length) savedPlaces = DEFAULT_PLACES;
  var state = {
    screen: 'weather',  // weather | places | search
    tab: TABS.indexOf(store.get(TAB_KEY)) >= 0 ? store.get(TAB_KEY) : 'now',
    current: clampIndex(store.get(CURRENT_KEY)),
    forecast: null,
    nowcast: null,
    expires: 0,
    error: null,
    loading: false,
    loadedKey: null,
    menuIndex: 0,
    searchResults: [],
    searchFocus: -1
  };
  var loadSeq = 0;

  function clampIndex(i) {
    return typeof i === 'number' && i >= 0 && i < savedPlaces.length ? i : 0;
  }

  function setState(patch) {
    var next = {};
    var k;
    for (k in state) if (state.hasOwnProperty(k)) next[k] = state[k];
    for (k in patch) if (patch.hasOwnProperty(k)) next[k] = patch[k];
    state = next;
  }

  function place() { return savedPlaces[state.current]; }

  function savePlaces(list) {
    savedPlaces = list;
    store.set(PLACES_KEY, list);
  }

  // ---------- weather ----------

  function render() {
    if (state.screen !== 'weather') return;
    var p = place();
    var updated = state.loading ? 'updating...' : (state.forecast && state.forecast.updatedAt ?
      fc.hhmm(new Date(state.forecast.updatedAt)) : '');
    views.setHeader(p, state.current + 1, updated);
    views.setTabs(state.tab, true);
    views.setSoftkeys('Places', '', 'Refresh');
    if (!state.forecast) {
      if (state.loading) views.message('Loading forecast...');
      else views.message(state.error || 'No forecast', 'Press SoftRight to try again');
      return;
    }
    var now = Date.now();
    if (state.tab === 'now') views.renderNow(state.forecast, state.nowcast, now);
    else if (state.tab === 'hours') views.renderHours(state.forecast, now);
    else views.renderDays(state.forecast, now);
  }

  function load(force) {
    var p = place();
    var seq = ++loadSeq;
    var cachedFc = store.get('kuling.fc.' + places.placeKey(p));
    setState({ loading: true, error: null, forecast: cachedFc ? cachedFc.value : null, nowcast: null,
               loadedKey: places.placeKey(p) });
    render();
    data.forecast(p, force).then(function (res) {
      if (seq !== loadSeq) return;
      if (res.notYet) {
        views.toast('Up to date. Next update ' + fc.hhmm(new Date(res.entry.expires)));
      }
      if (res.error) views.toast(res.error + (res.entry ? ' (showing saved forecast)' : ''));
      setState({
        loading: false,
        forecast: res.entry ? res.entry.value : null,
        expires: res.entry ? res.entry.expires : 0,
        error: res.error
      });
      render();
      return data.nowcast(p).then(function (nc) {
        if (seq !== loadSeq) return;
        setState({ nowcast: nc.entry ? nc.entry.value : null });
        if (state.tab === 'now') render();
      });
    });
  }

  function selectPlace(i) {
    if (i < 0 || i >= savedPlaces.length) { views.toast('No place on ' + (i + 1)); return; }
    setState({ current: i, screen: 'weather' });
    store.set(CURRENT_KEY, i);
    views.scrollTop();
    load(false);
  }

  function switchTab(dir) {
    var i = (TABS.indexOf(state.tab) + dir + TABS.length) % TABS.length;
    setState({ tab: TABS[i] });
    store.set(TAB_KEY, TABS[i]);
    views.scrollTop();
    render();
  }

  // ---------- places screen ----------

  function menuItems() {
    var items = [];
    for (var i = 0; i < savedPlaces.length; i++) {
      items.push({ num: String(i + 1), label: savedPlaces[i].name, sub: savedPlaces[i].sub, place: i });
    }
    items.push({ label: 'My location', sub: 'Use GPS', action: 'gps' });
    items.push({ label: 'Search...', sub: 'Add a place in Norway', action: 'search' });
    return items;
  }

  function showPlaces(index) {
    setState({ screen: 'places', menuIndex: typeof index === 'number' ? index : state.current });
    renderPlaces();
  }

  function renderPlaces() {
    var items = menuItems();
    var item = items[state.menuIndex];
    views.setHeader({ name: 'Places' }, 0, savedPlaces.length + '/' + places.MAX_PLACES);
    views.setTabs(null, false);
    views.setSoftkeys('Back', 'Select', item && item.place !== undefined && savedPlaces.length > 1 ? 'Remove' : '');
    views.renderMenu(items, state.menuIndex);
  }

  function pickMenu() {
    var item = menuItems()[state.menuIndex];
    if (!item) return;
    if (item.place !== undefined) selectPlace(item.place);
    else if (item.action === 'gps') locate();
    else showSearch();
  }

  function removeSelected() {
    var item = menuItems()[state.menuIndex];
    if (!item || item.place === undefined || savedPlaces.length <= 1) return;
    var gone = savedPlaces[item.place];
    data.forget(gone);
    savePlaces(places.removePlace(savedPlaces, item.place));
    var current = state.current > item.place ? state.current - 1 : state.current;
    setState({ current: clampIndex(current), menuIndex: Math.min(state.menuIndex, menuItems().length - 1) });
    store.set(CURRENT_KEY, state.current);
    views.toast('Removed ' + gone.name);
    renderPlaces();
  }

  function addAndSelect(p) {
    var next = places.addPlace(savedPlaces, p);
    if (!next) { views.toast('Max ' + places.MAX_PLACES + ' places. Remove one first.'); return; }
    savePlaces(next);
    views.toast(p.name + ' on key ' + next.length);
    selectPlace(next.length - 1);
  }

  function locate() {
    var geo = root.navigator.geolocation;
    if (!geo) { views.toast('No GPS on this device'); return; }
    views.toast('Finding your location...');
    geo.getCurrentPosition(function (pos) {
      var lat = pos.coords.latitude;
      var lon = pos.coords.longitude;
      data.municipality(lat, lon).then(function (name) {
        addAndSelect(places.makePlace(name || 'My location', 'My location', lat, lon));
      });
    }, function (err) {
      var why = err && err.code === 1 ? 'GPS permission denied' : err && err.code === 3 ? 'GPS timed out' : 'No GPS fix';
      views.toast(why);
    }, GPS_OPTIONS);
  }

  // ---------- search screen ----------

  function showSearch() {
    setState({ screen: 'search', searchResults: [], searchFocus: -1 });
    views.setHeader({ name: 'Search' }, 0, '');
    views.setTabs(null, false);
    views.setSoftkeys('Back', 'Search', '');
    views.renderSearch('', [], -1, 'Type a name, press Enter');
  }

  function runSearch() {
    var text = views.searchText().replace(/^\s+|\s+$/g, '');
    if (text.length < 2) { views.toast('Type at least 2 letters'); return; }
    views.renderSearch(text, [], -1, 'Searching...');
    data.search(text).then(function (res) {
      if (state.screen !== 'search') return;
      var status = res.error || (res.places.length ? res.places.length + ' found. Down to pick.' : 'Nothing found');
      setState({ searchResults: res.places, searchFocus: -1 });
      views.setSoftkeys('Back', 'Search', '');
      views.renderSearch(text, res.places, -1, status);
    });
  }

  function moveSearch(dir) {
    var n = state.searchResults.length;
    if (!n) return;
    var f = Math.max(-1, Math.min(n - 1, state.searchFocus + dir));
    setState({ searchFocus: f });
    views.setSoftkeys('Back', f < 0 ? 'Search' : 'Add', '');
    views.renderSearch(views.searchText(), state.searchResults, f, null);
  }

  // ---------- keys ----------

  function onWeatherKey(k) {
    if (/^[1-9]$/.test(k)) { selectPlace(parseInt(k, 10) - 1); return true; }
    switch (k) {
      case 'ArrowLeft': switchTab(-1); return true;
      case 'ArrowRight': switchTab(1); return true;
      case 'ArrowUp': views.scroll(-SCROLL_PX); return true;
      case 'ArrowDown': views.scroll(SCROLL_PX); return true;
      case 'SoftLeft': showPlaces(); return true;
      case 'SoftRight': load(true); return true;
      default: return false;
    }
  }

  function onPlacesKey(k) {
    var n = menuItems().length;
    switch (k) {
      case 'ArrowUp': setState({ menuIndex: (state.menuIndex - 1 + n) % n }); renderPlaces(); return true;
      case 'ArrowDown': setState({ menuIndex: (state.menuIndex + 1) % n }); renderPlaces(); return true;
      case 'Enter': pickMenu(); return true;
      case 'SoftRight': removeSelected(); return true;
      case 'SoftLeft': case 'Backspace':
        setState({ screen: 'weather' });
        // The shown place may have been removed meanwhile; reload if it changed.
        if (places.placeKey(place()) !== state.loadedKey) load(false);
        else render();
        return true;
      default:
        if (/^[1-9]$/.test(k)) { selectPlace(parseInt(k, 10) - 1); return true; }
        return false;
    }
  }

  function onSearchKey(k) {
    var inInput = state.searchFocus < 0;
    switch (k) {
      case 'ArrowDown': moveSearch(1); return true;
      case 'ArrowUp': moveSearch(-1); return true;
      case 'Enter':
        if (inInput) runSearch();
        else addAndSelect(state.searchResults[state.searchFocus]);
        return true;
      case 'SoftLeft': showPlaces(savedPlaces.length + 1); return true;
      case 'Backspace':
        // In the text box Backspace deletes letters; only an empty box goes back.
        if (inInput && views.searchText()) return false;
        showPlaces(savedPlaces.length + 1);
        return true;
      default: return false;
    }
  }

  function onKey(e) {
    var handled;
    if (state.screen === 'weather') handled = onWeatherKey(e.key);
    else if (state.screen === 'places') handled = onPlacesKey(e.key);
    else handled = onSearchKey(e.key);
    if (handled) e.preventDefault();
  }

  // ---------- start ----------

  root.addEventListener('keydown', onKey);
  root.document.addEventListener('visibilitychange', function () {
    if (!root.document.hidden && state.screen === 'weather' && Date.now() >= state.expires) load(false);
  });
  // Keep "Now" honest while the app stays open. Only that tab, so list scroll positions survive.
  setInterval(function () {
    if (!root.document.hidden && state.screen === 'weather' && state.tab === 'now') render();
  }, RERENDER_MS);
  load(false);
})(this);
