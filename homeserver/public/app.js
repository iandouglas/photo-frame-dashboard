// Frame dashboard UI. ES5 for the stock Android 6 WebView (Chrome 44): no arrows, let/const,
// template literals, fetch or Array#find. Times come from the server, not the frame's clock.
(function () {
  'use strict';
  var L = window.Logic;
  var MIN = 60000;
  var POLL_EVENTS = 60000, POLL_STATE = 10000, POLL_WEATHER = 10 * MIN, POLL_TEXT = 15000;
  var HOURLY_IDLE = MIN; // the hourly view returns to the 10-day list after this long untouched
  var POLL_NEWS = 5 * MIN;
  var AGENDA_IDLE = 2 * MIN; // a browsed day returns to today after this long untouched
  var NAV_BACK = -30, NAV_AHEAD = 90, NAV_DAYS = 14; // match the server's /api/events bounds
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  var S = {
    skew: 0, offsets: [[0, 0]], calendars: [], calById: {}, alertCals: {}, alertOpts: null,
    events: [], status: [], weather: null, pomodoro: null, acks: {},
    online: true, agendaMinute: -1, lastAlertKey: null, pomoDoneShown: null, editing: null,
    wxDay: null, wxTouched: 0, text: null,
    navDay: null, navData: null, navTouched: 0, // agenda day browsing (null = today)
    news: null, newsOn: false, tab: savedTab(), clockHM: '', clockSec: '', clockAmPm: '',
    flashing: false,
    // Screen: cfg from /api/state; off = we turned it off; manual = the moon button did.
    screen: { cfg: null, off: false, manual: false, wakeUntil: 0 }
  };
  // The kiosk's bridge (window.HomeHQ) exists only inside the Home HQ app on the dashboard origin.
  var bridge = typeof window.HomeHQ !== 'undefined' && window.HomeHQ ? window.HomeHQ : null;
  var token = (/[?&]token=([^&]+)/.exec(location.search) || [])[1] || '';

  function $(id) { return document.getElementById(id); }
  function savedTab() {
    try { return window.localStorage.getItem('frame.tab') === 'news' ? 'news' : 'agenda'; } catch (e) { return 'agenda'; }
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // ------------------------------------------------------------ server time and zone
  function now() { return Date.now() + S.skew; }
  function offsetFor(ms) {
    var off = S.offsets[0][1];
    for (var i = 0; i < S.offsets.length; i++) if (S.offsets[i][0] <= ms) off = S.offsets[i][1];
    return off;
  }
  // A Date whose UTC fields hold the wall-clock time in the server's zone.
  function wall(ms) { return new Date(ms + offsetFor(ms) * MIN); }
  function dayNumber(ms) { var w = wall(ms); return Math.floor(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()) / 864e5); }
  function fmtTime(ms, withAmPm) {
    var w = wall(ms), h = w.getUTCHours(), m = w.getUTCMinutes();
    var s = (h % 12 || 12) + ':' + pad2(m);
    return withAmPm === false ? s : s + (h >= 12 ? ' PM' : ' AM');
  }
  function fmtCountdown(ms) {
    var neg = ms < 0;
    var s = Math.floor(Math.abs(ms) / 1000);
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    var out = (h ? h + ':' + pad2(m) : m) + ':' + pad2(sec);
    return neg ? '-' + out : out;
  }
  function relDay(ms) {
    var diff = dayNumber(ms) - dayNumber(now());
    var w = wall(ms);
    var label = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : DAYS[w.getUTCDay()];
    return { label: label, date: MONTHS[w.getUTCMonth()].slice(0, 3) + ' ' + w.getUTCDate() };
  }

  // ------------------------------------------------------------ network
  function request(method, path, body, done) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, path, true);
    xhr.timeout = 15000;
    if (body) xhr.setRequestHeader('Content-Type', 'application/json');
    if (token && method !== 'GET') xhr.setRequestHeader('X-Token', decodeURIComponent(token));
    xhr.onload = function () {
      var data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
      setOnline(true);
      done(xhr.status >= 200 && xhr.status < 300 ? null : (data && data.error) || 'HTTP ' + xhr.status, data);
    };
    xhr.onerror = xhr.ontimeout = function () { setOnline(false); done('offline', null); };
    xhr.send(body ? JSON.stringify(body) : null);
  }
  function setOnline(on) {
    S.online = on;
    $('offline').className = on ? 'offline hidden' : 'offline';
  }
  function syncClock(serverNow, sentAt) {
    if (typeof serverNow === 'number') S.skew = serverNow - Math.round((sentAt + Date.now()) / 2);
  }

  function loadEvents() {
    var sent = Date.now();
    request('GET', 'api/events', null, function (err, d) {
      if (err || !d) return;
      syncClock(d.now, sent);
      S.offsets = d.offsets && d.offsets.length ? d.offsets : S.offsets;
      S.calendars = d.calendars || [];
      S.calById = {};
      S.alertCals = {};
      for (var i = 0; i < S.calendars.length; i++) {
        S.calById[S.calendars[i].id] = S.calendars[i];
        if (S.calendars[i].alert) S.alertCals[S.calendars[i].id] = true;
      }
      S.alertOpts = d.alert;
      S.events = d.events || [];
      S.status = d.status || [];
      renderLegend();
      renderAgenda();
      tick();
    });
    if (S.navDay !== null) loadNavDay(S.navDay);
  }

  function isoDay(day) {
    var d = new Date(day * 864e5);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  function loadNavDay(day) {
    request('GET', 'api/events?from=' + isoDay(day) + '&days=' + NAV_DAYS, null, function (err, d) {
      if (err || !d || S.navDay !== day) return; // a later tap moved on
      S.navData = { day: day, events: d.events || [] };
      renderAgenda();
    });
  }
  function loadWeather() {
    request('GET', 'api/weather', null, function (err, d) {
      if (!err && d) { S.weather = d; renderWeather(); }
      else if (d && d.error === 'NO_LOCATION') $('wxNow').innerHTML = '<div class="wx-desc">Set LAT and LON in the stack to show weather.</div>';
    });
  }
  function applyState(d) {
    if (!d) return;
    S.pomodoro = d.pomodoro;
    S.acks = d.acks || {};
    if (d.screen) S.screen.cfg = d.screen;
    if (!S.editing) renderPomodoro();
    renderAlert();
  }
  function loadState() {
    var sent = Date.now();
    request('GET', 'api/state', null, function (err, d) {
      if (!err && d) { syncClock(d.now, sent); applyState(d); }
    });
  }

  // ------------------------------------------------------------ agenda
  function calColor(id) { return (S.calById[id] && S.calById[id].color) || '#7A756B'; }
  function calName(id) { return (S.calById[id] && S.calById[id].name) || id; }

  function renderLegend() {
    var html = '';
    for (var i = 0; i < S.calendars.length; i++) {
      var c = S.calendars[i];
      html += '<span><i class="dot" style="background:' + c.color + '"></i>' + esc(c.name) + '</span>';
    }
    $('legend').innerHTML = html;
  }

  function renderAgenda() {
    var t = now();
    var today = dayNumber(t);
    var start = S.navDay === null ? today : S.navDay;
    var list = S.navDay === null ? S.events : (S.navData && S.navData.day === start ? S.navData.events : null);
    renderNav(start, today);
    if (!list) { $('agenda').innerHTML = '<p class="empty">Loading…</p>'; return; }
    var groups = {}, order = [];
    function group(day) {
      if (!groups[day]) { groups[day] = { allDay: [], timed: [] }; order.push(day); }
      return groups[day];
    }
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (start === today) {
        if (e.end <= t && !(e.allDay && dayNumber(e.start) === today)) continue;
      } else if (dayNumber(e.end - 1) < start) continue;
      if (e.allDay) {
        // Multi-day all-day events appear on each remaining day they cover.
        var first = Math.max(dayNumber(e.start), start), last = dayNumber(e.end - 1);
        for (var d = first; d <= last && d < start + 14; d++) group(d).allDay.push(e);
      } else {
        group(Math.max(dayNumber(e.start), start)).timed.push(e);
      }
    }
    group(start); // always show the first day, even when it is empty
    order.sort(function (a, b) { return a - b; });

    var html = '';
    for (var g = 0; g < order.length; g++) {
      var day = order[g], grp = groups[day];
      // The first day's heading is the navigation bar above the list.
      if (day !== start) {
        var rd = relDay(dayMs(day));
        html += '<div class="day-head"><b>' + rd.label + '</b> · ' + rd.date + '</div>';
      }
      for (var a = 0; a < grp.allDay.length; a++) {
        html += '<span class="allday" style="background:' + calColor(grp.allDay[a].cal) + '">' + esc(grp.allDay[a].title) + '</span>';
      }
      for (var k = 0; k < grp.timed.length; k++) html += eventRow(grp.timed[k], t);
      if (day === start && !grp.allDay.length && !grp.timed.length) {
        html += '<p class="empty">' + (day === today ? 'Nothing else today' : 'Nothing scheduled') + '</p>';
      }
    }
    $('agenda').innerHTML = html;

    var bad = [];
    for (var s = 0; s < S.status.length; s++) {
      var st = S.status[s];
      if (st.error) bad.push(calName(st.id) + ': ' + st.error + (st.okAt ? ' (showing data from ' + fmtTime(st.okAt) + ')' : ''));
    }
    $('calStatus').textContent = bad.join(' · ');
    S.agendaMinute = Math.floor(t / MIN);
  }

  // Noon of a day number, as an instant (safe across DST changes).
  function dayMs(day) { return day * 864e5 + 12 * 36e5 - offsetFor(day * 864e5) * MIN; }

  function renderNav(start, today) {
    var rd = relDay(dayMs(start)), diff = start - today;
    var label = diff === -1 ? 'Yesterday' : rd.label;
    var lab = $('dayLabel');
    lab.className = 'nav-day' + (diff ? ' is-away' : '');
    lab.innerHTML = '<b>' + label + '</b> · ' + rd.date + (diff ? '<small>Tap for today</small>' : '');
    $('dayPrev').disabled = diff <= NAV_BACK;
    $('dayNext').disabled = diff >= NAV_AHEAD;
  }

  function goDay(day) {
    var today = dayNumber(now());
    day = Math.max(today + NAV_BACK, Math.min(today + NAV_AHEAD, day));
    S.navTouched = Date.now();
    S.navDay = day === today ? null : day;
    if (S.navDay !== null && !(S.navData && S.navData.day === day)) S.navData = null;
    $('agenda').scrollTop = 0;
    renderAgenda();
    if (S.navDay !== null) loadNavDay(day);
  }
  function stepDay(delta) {
    goDay((S.navDay === null ? dayNumber(now()) : S.navDay) + delta);
  }

  // ------------------------------------------------------------ news
  function loadNews() {
    request('GET', 'api/news', null, function (err, d) {
      if (err === 'NOT_CONFIGURED') { S.newsOn = false; applyTab(); return; }
      if (err || !d) return; // keep what is shown
      S.newsOn = true;
      S.news = d;
      renderNews();
      applyTab();
    });
  }

  function relTime(ms) {
    if (ms == null) return '';
    var m = Math.floor((now() - ms) / MIN);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    if (m < 24 * 60) return Math.floor(m / 60) + 'h ago';
    return Math.floor(m / 1440) + 'd ago';
  }

  function renderNews() {
    var d = S.news;
    if (!d) return;
    var html = '';
    for (var i = 0; i < d.items.length; i++) {
      var it = d.items[i];
      html += '<div class="news-item"><div class="news-title">' + esc(it.title) + '</div>' +
        '<div class="news-meta"><b>' + esc(it.source) + '</b>' +
        (it.time != null ? ' · <span class="news-time" data-t="' + it.time + '">' + relTime(it.time) + '</span>' : '') + '</div></div>';
    }
    $('news').innerHTML = html || '<p class="empty">No headlines yet</p>';
    var bad = [];
    for (var s = 0; s < d.status.length; s++) {
      var st = d.status[s];
      if (st.error) bad.push(st.name + ': ' + st.error);
    }
    $('newsStatus').textContent = bad.join(' · ');
  }

  // Refresh the "12m ago" labels without re-rendering (keeps the scroll position).
  function updateNewsTimes() {
    var els = $('news').getElementsByClassName('news-time');
    for (var i = 0; i < els.length; i++) els[i].textContent = relTime(+els[i].getAttribute('data-t'));
  }

  function applyTab() {
    var tab = S.newsOn ? S.tab : 'agenda';
    $('seg').className = S.newsOn ? 'seg' : 'seg hidden';
    $('agendaLabel').className = S.newsOn ? 'hidden' : '';
    var btns = $('seg').getElementsByTagName('button');
    for (var i = 0; i < btns.length; i++) btns[i].className = btns[i].getAttribute('data-tab') === tab ? 'is-on' : '';
    $('agendaPane').className = tab === 'agenda' ? 'pane' : 'pane hidden';
    $('newsPane').className = tab === 'news' ? 'pane' : 'pane hidden';
    $('legend').className = tab === 'agenda' ? 'legend' : 'legend hidden';
  }

  function setTab(tab) {
    S.tab = tab === 'news' ? 'news' : 'agenda';
    try { window.localStorage.setItem('frame.tab', S.tab); } catch (e) { /* storage off */ }
    applyTab();
  }

  function eventRow(e, t) {
    var cls = 'ev' + (e.end <= t ? ' is-past' : '') + (e.start <= t && e.end > t ? ' is-now' : '');
    var sub = calName(e.cal);
    if (e.also) for (var i = 0; i < e.also.length; i++) sub += ' + ' + calName(e.also[i]);
    if (e.location) sub += ' · ' + e.location;
    return '<div class="' + cls + '"><span class="ev-bar" style="background:' + calColor(e.cal) + '"></span>' +
      '<span class="ev-time">' + fmtTime(e.start) + '</span>' +
      '<div class="ev-body"><div class="ev-title">' + esc(e.title) + '</div><div class="ev-sub">' + esc(sub) + ' · ' +
      Math.round((e.end - e.start) / MIN) + ' min</div></div></div>';
  }

  // ------------------------------------------------------------ weather
  var ICON = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    cloud: '<path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 11a3.5 3.5 0 0 0 1 7z"/>',
    partly: '<path d="M8 3v1.5M3.5 8H2M4.3 4.3l1 1M12.5 5.5l1-1"/><path d="M5.5 10.5a3 3 0 0 1 5.5-2.2"/><path d="M9 20h8a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.4 1.3A3 3 0 0 0 9 20z"/>',
    'partly-night': '<path d="M10.5 4A5 5 0 0 0 4 10.5a5 5 0 0 0 4 1.5"/><path d="M9 20h8a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.4 1.3A3 3 0 0 0 9 20z"/>',
    rain: '<path d="M7 15h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 8a3.5 3.5 0 0 0 1 7z"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>',
    snow: '<path d="M7 14h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 7a3.5 3.5 0 0 0 1 7z"/><path d="M8 18h.01M12 20h.01M16 18h.01M10 22h.01M14 22h.01"/>',
    sleet: '<path d="M7 14h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 7a3.5 3.5 0 0 0 1 7z"/><path d="M8 18l-1 3M16 18l-1 3M12 19h.01"/>',
    storm: '<path d="M7 14h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 7a3.5 3.5 0 0 0 1 7z"/><path d="M13 14l-3 4h4l-3 4"/>',
    fog: '<path d="M4 9h16M4 13h16M6 17h12M8 5h8"/>',
    sunrise: '<path d="M12 3v6M9 6l3-3 3 3M4 18h16M6.5 18a5.5 5.5 0 0 1 11 0M2 21h20"/>',
    sunset: '<path d="M12 9V3M9 6l3 3 3-3M4 18h16M6.5 18a5.5 5.5 0 0 1 11 0M2 21h20"/>'
  };
  function icon(name, size) {
    return '<svg class="wx-icon" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICON[name] || ICON.cloud) + '</svg>';
  }
  function hm12(s) {
    if (!s) return '--';
    var h = +s.slice(0, 2), m = s.slice(3, 5);
    return (h % 12 || 12) + ':' + m + (h >= 12 ? ' PM' : ' AM');
  }

  function renderWeather() {
    var w = S.weather;
    if (!w) return;
    var c = w.current, u = w.units;
    $('wxNow').innerHTML = icon(c.icon, 72) + '<div class="wx-temp">' + (c.temp == null ? '--' : c.temp) + '°</div>' +
      '<div class="wx-desc">' + esc(c.label) + '<div>Feels ' + c.feels + '° · ' + c.wind + ' ' + u.wind + ' · ' + c.humidity + '%</div>' +
      '<div>' + esc(w.location) + (w.stale ? ' · stale' : '') + '</div></div>';
    var today = w.days[0] || {};
    $('sun').innerHTML = '<span>' + icon('sunrise', 22) + hm12(today.sunrise) + '</span><span>' + icon('sunset', 22) + hm12(today.sunset) + '</span>';

    // A poll must not throw the user out of the hourly view (or reset its scroll position).
    if (S.wxDay) return;
    renderDays();
  }

  function dayName(date, index, short) {
    if (index === 0) return 'Today';
    var parts = date.split('-');
    var name = DAYS[new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2])).getUTCDay()];
    return short ? name.slice(0, 3) : name;
  }

  function renderDays() {
    var w = S.weather;
    if (!w) return;
    var lo = Infinity, hi = -Infinity, i;
    for (i = 0; i < w.days.length; i++) { lo = Math.min(lo, w.days[i].lo); hi = Math.max(hi, w.days[i].hi); }
    var span = Math.max(1, hi - lo), html = '';
    for (i = 0; i < w.days.length; i++) {
      var d = w.days[i];
      var left = (d.lo - lo) / span * 100, width = Math.max(4, (d.hi - d.lo) / span * 100);
      html += '<div class="wx-day" data-date="' + esc(d.date) + '"><span class="d">' + dayName(d.date, i, true) + '</span>' +
        '<span class="i">' + icon(d.icon, 26) + '</span>' +
        '<span class="p">' + (d.pop ? d.pop + '%' : '') + '</span>' +
        '<span class="lo">' + d.lo + '°</span><span class="range"><i style="left:' + left + '%;width:' + width + '%"></i></span>' +
        '<span class="hi">' + d.hi + '°</span></div>';
    }
    var box = $('wxDays');
    box.className = 'wx-days';
    box.innerHTML = html;
  }

  function hourLabel(t) {
    var h = +t.slice(0, 2);
    return (h % 12 || 12) + ' ' + (h >= 12 ? 'PM' : 'AM');
  }

  // Hourly breakdown for one day, in the same panel as the 10-day list.
  function openHourly(date) {
    var w = S.weather, day = null, index = -1, i;
    if (!w) return;
    for (i = 0; i < w.days.length; i++) if (w.days[i].date === date) { day = w.days[i]; index = i; }
    if (!day) return closeHourly();
    S.wxDay = date;
    S.wxTouched = Date.now();

    var hours = day.hours || [], rows = '';
    // Today: start at the current hour in the server's zone.
    var nowWall = wall(now()), nowHour = pad2(nowWall.getUTCHours()) + ':00';
    for (i = 0; i < hours.length; i++) {
      var h = hours[i];
      if (index === 0 && h.t < nowHour) continue;
      rows += '<div class="wx-hour"><span class="h">' + (index === 0 && h.t === nowHour ? 'Now' : hourLabel(h.t)) + '</span>' +
        '<span class="i">' + icon(h.icon, 26) + '</span>' +
        '<span class="p">' + (h.pop ? h.pop + '%' : '') + '</span>' +
        '<span class="t">' + (h.temp == null ? '--' : h.temp) + '°</span></div>';
    }
    var parts = date.split('-');
    var box = $('wxDays');
    box.className = 'wx-days is-hourly';
    box.innerHTML = '<div class="wx-hhead"><button class="wx-back" data-act="wx-back" aria-label="Back to 10-day forecast">' +
      '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>' +
      '<b>' + dayName(date, index, false) + '</b><span>' + MONTHS[+parts[1] - 1].slice(0, 3) + ' ' + (+parts[2]) +
      ' · ' + day.lo + '° / ' + day.hi + '°</span></div>' +
      '<div class="wx-hours" id="wxHours">' + (rows || '<p class="empty">No hourly forecast yet</p>') + '</div>';
  }

  function closeHourly() {
    if (!S.wxDay) return;
    S.wxDay = null;
    renderDays();
  }

  function onDaysTap(ev) {
    S.wxTouched = Date.now();
    var el = ev.target;
    while (el && el !== this && !el.getAttribute('data-date') && !el.getAttribute('data-act')) el = el.parentNode;
    if (!el || el === this) return;
    if (el.getAttribute('data-act') === 'wx-back') return closeHourly();
    if (!S.wxDay) openHourly(el.getAttribute('data-date'));
  }

  // ------------------------------------------------------------ text feed
  function loadText() {
    request('GET', 'api/text', null, function (err, d) {
      var card = $('textCard');
      if (err === 'NOT_CONFIGURED') { card.className = 'card text-card hidden'; return; }
      if (d && d.title) { $('textTitle').textContent = d.title; $('textTitle').className = 'card-label'; }
      if (err || !d || typeof d.text !== 'string') {
        // Keep the last text; just mark it as old.
        if (S.text !== null) fitText(true);
        return;
      }
      card.className = 'card text-card';
      if (d.text !== S.text) { S.text = d.text; $('textBody').textContent = d.text; }
      fitText(!!d.stale);
    });
  }
  // Use the largest font size at which the text fits the card (the card's height depends on
  // what is above it, so measure instead of guessing from the length).
  var TEXT_SIZES = ['', ' is-m', ' is-s', ' is-xs'];
  function fitText(stale) {
    var body = $('textBody'), extra = stale ? ' is-stale' : '';
    for (var i = 0; i < TEXT_SIZES.length; i++) {
      body.className = 'text-body' + TEXT_SIZES[i] + extra;
      if (body.scrollHeight <= body.clientHeight + 1) return;
    }
  }

  // ------------------------------------------------------------ meeting alert
  function renderAlert() {
    if (!S.alertOpts) return;
    var t = now();
    var a = L.alertState(S.events, S.alertCals, t, S.acks, S.alertOpts);
    var card = $('alertCard'), body = $('alertBody'), flash = $('flash');
    card.className = 'card alert-card' + (a.phase === 'countdown' ? ' is-countdown' : a.phase === 'acked' ? ' is-acked' : '');

    if (a.phase === 'none') {
      body.innerHTML = '<p class="empty">Nothing coming up</p>';
    } else {
      var e = a.event;
      var count = a.phase === 'upcoming' ? relDay(e.start).label + ' ' + fmtTime(e.start)
        : a.msUntil > 0 ? 'in ' + fmtCountdown(a.msUntil) : 'started';
      body.innerHTML = '<div class="alert-title">' + esc(e.title) + '</div><div class="alert-sub">' +
        fmtTime(e.start) + ' · ' + esc(calName(e.cal)) + '</div><div class="alert-count' + (a.phase === 'upcoming' ? ' is-later' : '') + '">' + count + '</div>';
    }

    S.flashing = a.phase === 'flash';
    if (a.phase === 'flash') {
      $('flashWhen').textContent = a.msUntil > 0 ? 'in ' + fmtCountdown(a.msUntil) : 'started ' + Math.floor(-a.msUntil / MIN) + ' min ago';
      $('flashTitle').textContent = a.event.title;
      $('flashMeta').textContent = fmtTime(a.event.start) + ' · ' + calName(a.event.cal) + (a.event.location ? ' · ' + a.event.location : '');
      flash.className = 'flash';
      S.lastAlertKey = a.key;
    } else {
      flash.className = 'flash hidden';
    }
  }

  function ack() {
    if (!S.lastAlertKey) return;
    // The ACK tap counts as a touch: stay on for the wake time, then the schedule resumes.
    S.screen.manual = false;
    S.screen.wakeUntil = Date.now() + wakeMs();
    S.acks[S.lastAlertKey] = now(); // hide at once; the server confirms
    renderAlert();
    request('POST', 'api/ack', { key: S.lastAlertKey }, function (err, d) { if (!err) applyState(d); });
  }

  // ------------------------------------------------------------ pomodoro
  var PHASE_LABEL = { work: 'Focus', short: 'Short break', long: 'Long break' };

  function settings() { return (S.pomodoro && S.pomodoro.settings) || L.DEFAULT_SETTINGS; }

  function renderPomodoro() {
    if (!S.pomodoro) return;
    var v = L.pomodoroView(S.pomodoro.run, settings(), now());
    var card = $('pomo');
    var done = v.status === 'finished';
    var cls = 'card pomo' + (v.phase === 'work' ? '' : ' is-break');
    var doneKey = done ? v.phase + '@' + S.pomodoro.run.endsAt : null;
    if (done) cls += S.pomoDoneShown === doneKey ? ' is-done-steady' : ' is-done';
    if (card.className !== cls) card.className = cls;
    if (done && S.pomoDoneShown !== doneKey && S.pomoDoneTimer !== doneKey) {
      // Pulse for 8 s (the CSS animation), then stay highlighted until the next phase starts.
      S.pomoDoneTimer = doneKey;
      setTimeout(function () { S.pomoDoneShown = doneKey; renderPomodoro(); }, 8000);
    }

    var next = done ? L.nextPhase(S.pomodoro.run, settings()).phase : null;
    $('pomoPhase').textContent = done ? PHASE_LABEL[v.phase] + ' done' : PHASE_LABEL[v.phase] + (v.status === 'paused' ? ' · paused' : '');
    $('pomoTime').textContent = fmtCountdown(v.remainingMs).replace(/^-/, '');
    $('pomoBar').style.width = Math.min(100, 100 - v.remainingMs / v.totalMs * 100) + '%';
    $('pomoCount').textContent = v.done ? v.done + ' focus session' + (v.done === 1 ? '' : 's') + ' done' : '';
    $('pomoStart').textContent = done ? 'Start ' + PHASE_LABEL[next].toLowerCase() : v.status === 'running' ? 'Pause' : v.status === 'paused' ? 'Resume' : 'Start';
  }

  function pomoAction(action) {
    if (!S.pomodoro) return;
    var run = L.pomodoroAction(S.pomodoro.run, settings(), now(), action);
    S.pomodoro.run = run;
    renderPomodoro();
    request('POST', 'api/pomodoro', { run: run }, function (err, d) { if (!err) applyState(d); });
  }

  var FIELDS = [['work', 'Focus (min)', 1, 180], ['short', 'Short break (min)', 1, 60], ['long', 'Long break (min)', 1, 120], ['longEvery', 'Long break every', 1, 12]];

  function renderSettings() {
    var html = '';
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      html += '<div class="row"><span>' + f[1] + '</span><button class="step" data-f="' + f[0] + '" data-d="-1">−</button>' +
        '<b>' + S.editing[f[0]] + '</b><button class="step" data-f="' + f[0] + '" data-d="1">+</button></div>';
    }
    html += '<div class="btn-row"><button class="btn btn-primary" data-act="save">Save</button><button class="btn" data-act="cancel">Cancel</button></div>';
    $('pomoSettings').innerHTML = html;
  }

  function openSettings(open) {
    if (open) {
      var s = settings();
      S.editing = { work: s.work, short: s.short, long: s.long, longEvery: s.longEvery };
      renderSettings();
    } else {
      S.editing = null;
    }
    $('pomoSettings').className = open ? 'pomo-settings' : 'pomo-settings hidden';
    $('pomoMain').className = open ? 'hidden' : '';
    renderPomodoro();
  }

  function onSettingsTap(ev) {
    var el = ev.target;
    while (el && el !== this && !el.getAttribute('data-f') && !el.getAttribute('data-act')) el = el.parentNode;
    if (!el || el === this) return;
    var f = el.getAttribute('data-f');
    if (f) {
      for (var i = 0; i < FIELDS.length; i++) {
        if (FIELDS[i][0] !== f) continue;
        var step = f === 'work' && S.editing.work >= 10 ? 5 : 1;
        S.editing[f] = Math.max(FIELDS[i][2], Math.min(FIELDS[i][3], S.editing[f] + step * +el.getAttribute('data-d')));
      }
      renderSettings();
      return;
    }
    if (el.getAttribute('data-act') === 'save') {
      var body = { settings: S.editing };
      // An idle timer picks up the new length at once.
      request('POST', 'api/pomodoro', body, function (err, d) { if (!err) applyState(d); });
      S.pomodoro.settings = S.editing;
    }
    openSettings(false);
  }

  // ------------------------------------------------------------ screen off / schedule
  function wakeMs() { return ((S.screen.cfg && S.screen.cfg.wakeMin) || 2) * MIN; }

  function setScreen(on) {
    S.screen.off = !on;
    if (bridge) {
      if (on) bridge.screenOn(); else bridge.screenOff();
    } else {
      $('blackout').className = on ? 'blackout hidden' : 'blackout';
    }
  }

  // Called by the kiosk after a touch woke the screen (and by the plain-browser black page).
  function onWoke() {
    S.screen.off = false;
    S.screen.manual = false;
    S.screen.wakeUntil = Date.now() + wakeMs();
  }
  window.onHomeHQScreen = function (off) { if (!off) onWoke(); };

  function screenTick() {
    // The kiosk may have woken the screen on its own (a touch); trust what it reports.
    if (bridge && S.screen.off) {
      try { if (!bridge.isScreenOff()) onWoke(); } catch (e) { /* bridge refused */ }
    }
    var w = wall(now());
    var want = L.screenWanted({
      minuteOfDay: w.getUTCHours() * 60 + w.getUTCMinutes(),
      screen: S.screen.cfg,
      now: Date.now(),
      wakeUntil: S.screen.wakeUntil,
      flashing: S.flashing,
      manualOff: S.screen.manual
    });
    if (want === 'off' && !S.screen.off) setScreen(false);
    else if (want === 'on' && S.screen.off) setScreen(true);
  }

  // ------------------------------------------------------------ clock and tick
  function renderClock() {
    var t = now(), w = wall(t), h = w.getUTCHours();
    if (!$('clockHM')) {
      $('clock').innerHTML = '<span id="clockHM"></span><span class="clock-side"><span class="clock-sec" id="clockSec"></span>' +
        '<span class="clock-ampm" id="clockAmPm"></span></span>';
    }
    var hm = (h % 12 || 12) + ':' + pad2(w.getUTCMinutes()), sec = pad2(w.getUTCSeconds()), ampm = h >= 12 ? 'PM' : 'AM';
    if (hm !== S.clockHM) { S.clockHM = hm; $('clockHM').textContent = hm; }
    if (sec !== S.clockSec) { S.clockSec = sec; $('clockSec').textContent = sec; }
    if (ampm !== S.clockAmPm) { S.clockAmPm = ampm; $('clockAmPm').textContent = ampm; }
    $('date').textContent = DAYS[w.getUTCDay()] + ', ' + MONTHS[w.getUTCMonth()] + ' ' + w.getUTCDate();
  }

  function tick() {
    renderClock();
    renderAlert();
    screenTick();
    if (!S.editing) renderPomodoro();
    if (Math.floor(now() / MIN) !== S.agendaMinute) { renderAgenda(); updateNewsTimes(); }
    if (S.navDay !== null && Date.now() - S.navTouched > AGENDA_IDLE) goDay(dayNumber(now()));
    if (S.wxDay && Date.now() - S.wxTouched > HOURLY_IDLE) closeHourly();
  }

  // ------------------------------------------------------------ wire up
  $('ack').addEventListener('click', ack);
  $('pomoStart').addEventListener('click', function () {
    var v = L.pomodoroView(S.pomodoro && S.pomodoro.run, settings(), now());
    pomoAction(v.status === 'running' ? 'pause' : 'start');
  });
  $('pomoSkip').addEventListener('click', function () { pomoAction('skip'); });
  $('pomoReset').addEventListener('click', function () { pomoAction('reset'); });
  $('pomoGear').addEventListener('click', function () { openSettings(!S.editing); });
  $('pomoSettings').addEventListener('click', onSettingsTap);
  $('wxDays').addEventListener('click', onDaysTap);
  if (bridge) {
    $('btnSettings').className = 'tool-btn';
    $('btnSettings').addEventListener('click', function () { bridge.openSettings(); });
  }
  $('btnSleep').addEventListener('click', function () { S.screen.manual = true; setScreen(false); });
  // Plain browser: the black page swallows the waking tap (hidden on click, so the tap's own
  // click can't land on a button underneath).
  $('blackout').addEventListener('click', function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    $('blackout').className = 'blackout hidden';
    onWoke();
  });
  $('dayPrev').addEventListener('click', function () { stepDay(-1); });
  $('dayNext').addEventListener('click', function () { stepDay(1); });
  $('dayLabel').addEventListener('click', function () { goDay(dayNumber(now())); });
  // Touching or scrolling the agenda keeps a browsed day open.
  $('agendaPane').addEventListener('touchstart', function () { S.navTouched = Date.now(); });
  $('agenda').addEventListener('scroll', function () { S.navTouched = Date.now(); });
  $('seg').addEventListener('click', function (ev) {
    var el = ev.target;
    while (el && el !== this && !el.getAttribute('data-tab')) el = el.parentNode;
    if (el && el !== this) setTab(el.getAttribute('data-tab'));
  });
  // Any touch or scroll in the panel keeps the hourly view open.
  $('wxDays').addEventListener('touchstart', function () { S.wxTouched = Date.now(); });
  $('wxDays').addEventListener('scroll', function () { S.wxTouched = Date.now(); }, true);

  loadEvents();
  loadState();
  loadWeather();
  loadText();
  loadNews();
  applyTab();
  setInterval(loadEvents, POLL_EVENTS);
  setInterval(loadState, POLL_STATE);
  setInterval(loadWeather, POLL_WEATHER);
  setInterval(loadText, POLL_TEXT);
  setInterval(loadNews, POLL_NEWS);
  setInterval(tick, 1000);
})();
