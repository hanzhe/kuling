// Pure place logic: saved places list and Geonorge (Kartverket) place-name results.
(function (root) {
  'use strict';
  var Kuling = root.Kuling = root.Kuling || {};

  var MAX_PLACES = 9;
  var COORD_DECIMALS = 4; // MET rejects 5+ decimals.

  function roundCoord(x) {
    var f = Math.pow(10, COORD_DECIMALS);
    return Math.round(x * f) / f;
  }

  function makePlace(name, sub, lat, lon) {
    return { name: name, sub: sub || '', lat: roundCoord(lat), lon: roundCoord(lon) };
  }

  function placeKey(p) { return p.lat.toFixed(COORD_DECIMALS) + ',' + p.lon.toFixed(COORD_DECIMALS); }

  function samePlace(a, b) { return placeKey(a) === placeKey(b); }

  // Returns a new list with `place` added (or moved) to the end; null when full.
  function addPlace(places, place) {
    var out = [];
    for (var i = 0; i < places.length; i++) {
      if (!samePlace(places[i], place)) out.push(places[i]);
    }
    if (out.length >= MAX_PLACES) return null;
    return out.concat([place]);
  }

  function removePlace(places, index) {
    return places.slice(0, index).concat(places.slice(index + 1));
  }

  function isValidPlace(p) {
    return !!p && typeof p.name === 'string' && typeof p.lat === 'number' && typeof p.lon === 'number' &&
      p.lat >= -90 && p.lat <= 90 && p.lon >= -180 && p.lon <= 180;
  }

  function cleanPlaces(list) {
    var out = [];
    for (var i = 0; i < (list || []).length && out.length < MAX_PLACES; i++) {
      if (isValidPlace(list[i])) out.push(makePlace(list[i].name, list[i].sub, list[i].lat, list[i].lon));
    }
    return out;
  }

  // Geonorge /stedsnavn/v1/navn result -> places, dropping duplicates of the same spot.
  function parseSearch(json) {
    var out = [];
    var seen = {};
    var names = (json && json.navn) || [];
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      var pt = n.representasjonspunkt;
      if (!pt || typeof pt.nord !== 'number' || typeof pt['øst'] !== 'number') continue;
      var kommune = n.kommuner && n.kommuner[0] ? n.kommuner[0].kommunenavn : '';
      var sub = [n.navneobjekttype, kommune].join(', ').replace(/^, |, $/g, '');
      var place = makePlace(n['skrivemåte'] || '?', sub, pt.nord, pt['øst']);
      var key = place.name + '|' + kommune;
      if (seen[key]) continue;
      seen[key] = true;
      out.push(place);
    }
    return out;
  }

  // Geonorge /kommuneinfo/v1/punkt result -> municipality name, or null (e.g. outside Norway).
  function municipalityName(json) {
    return json && typeof json.kommunenavn === 'string' && json.kommunenavn ? json.kommunenavn : null;
  }

  Kuling.places = {
    MAX_PLACES: MAX_PLACES,
    roundCoord: roundCoord,
    makePlace: makePlace,
    placeKey: placeKey,
    samePlace: samePlace,
    addPlace: addPlace,
    removePlace: removePlace,
    cleanPlaces: cleanPlaces,
    parseSearch: parseSearch,
    municipalityName: municipalityName
  };
})(this);
