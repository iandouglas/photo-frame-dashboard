// Pure dashboard logic shared by the frame UI and the server's tests.
// ES5 on purpose: the frame's stock WebView is Chrome 44 (no arrows, let/const, Array#find).
(function (root) {
  'use strict';

  var MIN = 60000;

  function alertKey(ev) {
    return ev.uid + '@' + ev.start;
  }

  function alertsOn(ev, alertCals) {
    if (alertCals[ev.cal]) return true;
    var also = ev.also || [];
    for (var i = 0; i < also.length; i++) if (alertCals[also[i]]) return true;
    return false;
  }

  /**
   * Meeting alert state.
   * events: merged event list (sorted or not); alertCals: { calId: true };
   * acks: { key: ackedAtMs }; opts: { leadMin, countdownMin, graceMin }.
   * Returns { phase, event, key, msUntil } where phase is
   *   'none'      nothing alertable ahead
   *   'upcoming'  next alertable event is further than countdownMin away
   *   'countdown' within countdownMin, show a countdown
   *   'flash'     within leadMin (or started < graceMin ago) and not acknowledged
   *   'acked'     would flash, but was acknowledged
   * An acknowledged event that has already started is skipped, so a back-to-back
   * meeting can still flash.
   */
  function alertState(events, alertCals, now, acks, opts) {
    var lead = (opts && opts.leadMin != null ? opts.leadMin : 2) * MIN;
    var countdown = (opts && opts.countdownMin != null ? opts.countdownMin : 15) * MIN;
    var grace = (opts && opts.graceMin != null ? opts.graceMin : 10) * MIN;
    acks = acks || {};

    var list = [];
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev.allDay || !alertsOn(ev, alertCals)) continue;
      if (ev.start + grace <= now) continue;
      list.push(ev);
    }
    list.sort(function (a, b) { return a.start - b.start; });

    for (var j = 0; j < list.length; j++) {
      var e = list[j];
      var key = alertKey(e);
      var msUntil = e.start - now;
      var acked = !!acks[key];
      if (acked && msUntil <= 0) continue;
      var phase;
      if (msUntil > countdown) phase = 'upcoming';
      else if (msUntil > lead) phase = 'countdown';
      else phase = acked ? 'acked' : 'flash';
      return { phase: phase, event: e, key: key, msUntil: msUntil };
    }
    return { phase: 'none', event: null, key: null, msUntil: null };
  }

  // ------------------------------------------------------------ pomodoro

  var DEFAULT_SETTINGS = { work: 25, short: 5, long: 15, longEvery: 4 };

  function phaseMinutes(phase, settings) {
    settings = settings || DEFAULT_SETTINGS;
    return phase === 'short' ? settings.short : phase === 'long' ? settings.long : settings.work;
  }

  function idleRun(phase, done) {
    return { status: 'idle', phase: phase || 'work', endsAt: null, remainingMs: null, done: done || 0 };
  }

  /** What the timer shows at `now`: { status, phase, remainingMs, totalMs }. */
  function pomodoroView(run, settings, now) {
    run = run || idleRun();
    var total = phaseMinutes(run.phase, settings) * MIN;
    var remaining;
    var status = run.status;
    if (status === 'running') {
      remaining = run.endsAt - now;
      if (remaining <= 0) {
        remaining = 0;
        status = 'finished';
      }
    } else if (status === 'paused') {
      remaining = run.remainingMs;
    } else {
      remaining = total;
    }
    return { status: status, phase: run.phase, remainingMs: remaining, totalMs: total, done: run.done || 0 };
  }

  /** Phase after `run.phase` finishes, and the completed-work count after it. */
  function nextPhase(run, settings) {
    settings = settings || DEFAULT_SETTINGS;
    var done = run.done || 0;
    if (run.phase === 'work') {
      done += 1;
      return { phase: done % settings.longEvery === 0 ? 'long' : 'short', done: done };
    }
    return { phase: 'work', done: done };
  }

  /** Apply a button press. action: 'start' | 'pause' | 'reset' | 'skip'. Returns a new run. */
  function pomodoroAction(run, settings, now, action) {
    run = run || idleRun();
    var view = pomodoroView(run, settings, now);
    if (action === 'start') {
      if (view.status === 'finished') {
        var n = nextPhase(run, settings);
        return { status: 'running', phase: n.phase, endsAt: now + phaseMinutes(n.phase, settings) * MIN, remainingMs: null, done: n.done };
      }
      if (view.status === 'running') return run;
      return { status: 'running', phase: run.phase, endsAt: now + view.remainingMs, remainingMs: null, done: run.done || 0 };
    }
    if (action === 'pause') {
      if (view.status !== 'running') return run;
      return { status: 'paused', phase: run.phase, endsAt: null, remainingMs: view.remainingMs, done: run.done || 0 };
    }
    if (action === 'skip') {
      var s = nextPhase(run, settings);
      return idleRun(s.phase, s.done);
    }
    return idleRun('work', 0);
  }

  // ------------------------------------------------------------ screen schedule

  /** "HH:MM" -> minutes after midnight, or null. */
  function hhmmToMin(s) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
    if (!m || +m[1] > 23 || +m[2] > 59) return null;
    return +m[1] * 60 + +m[2];
  }

  /** Is minute-of-day m inside [from, to)? Windows may cross midnight (from > to). */
  function inWindow(m, from, to) {
    if (from == null || to == null || from === to) return false;
    return from < to ? m >= from && m < to : m >= from || m < to;
  }

  /**
   * Should the screen be on or off right now?
   *   minuteOfDay  local wall-clock minute (server zone)
   *   screen       { from: "HH:MM"|null, to: "HH:MM"|null } from /api/state
   *   now, wakeUntil  ms; a touch during the window keeps the screen on until wakeUntil
   *   flashing     a meeting alert is flashing: always on, schedule or not
   *   manualOff    the moon button was pressed (until the next touch)
   */
  function screenWanted(o) {
    if (o.flashing) return 'on';
    if (o.manualOff) return 'off';
    var s = o.screen;
    if (s && inWindow(o.minuteOfDay, hhmmToMin(s.from), hhmmToMin(s.to)) && o.now >= (o.wakeUntil || 0)) return 'off';
    return 'on';
  }

  root.Logic = {
    hhmmToMin: hhmmToMin,
    inWindow: inWindow,
    screenWanted: screenWanted,
    alertKey: alertKey,
    alertState: alertState,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    phaseMinutes: phaseMinutes,
    pomodoroView: pomodoroView,
    pomodoroAction: pomodoroAction,
    nextPhase: nextPhase
  };
})(typeof window !== 'undefined' ? window : this);
