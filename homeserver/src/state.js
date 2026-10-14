// Small JSON state store (pomodoro settings and run, alert ACKs), written atomically.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const ACK_TTL = 3 * 86400000;
const PHASES = ['work', 'short', 'long'];
const STATUSES = ['idle', 'running', 'paused'];

export function defaultState() {
  return {
    pomodoro: {
      settings: { work: 25, short: 5, long: 15, longEvery: 4 },
      run: { status: 'idle', phase: 'work', endsAt: null, remainingMs: null, done: 0 },
    },
    acks: {},
  };
}

function minutes(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

export function validSettings(s) {
  return !!s && minutes(s.work, 1, 180) && minutes(s.short, 1, 60) && minutes(s.long, 1, 120) && minutes(s.longEvery, 1, 12);
}

export function validRun(r) {
  if (!r || STATUSES.indexOf(r.status) < 0 || PHASES.indexOf(r.phase) < 0) return false;
  if (!Number.isInteger(r.done) || r.done < 0 || r.done > 10000) return false;
  if (r.status === 'running' && !Number.isFinite(r.endsAt)) return false;
  if (r.status === 'paused' && !(Number.isFinite(r.remainingMs) && r.remainingMs >= 0)) return false;
  return true;
}

export class StateStore {
  constructor(file) {
    this.file = file;
    this.state = defaultState();
    try {
      const loaded = JSON.parse(readFileSync(file, 'utf8'));
      if (loaded && loaded.pomodoro && validSettings(loaded.pomodoro.settings)) this.state.pomodoro.settings = loaded.pomodoro.settings;
      if (loaded && loaded.pomodoro && validRun(loaded.pomodoro.run)) this.state.pomodoro.run = loaded.pomodoro.run;
      if (loaded && loaded.acks && typeof loaded.acks === 'object') this.state.acks = loaded.acks;
    } catch {
      // First run, or an unreadable file: start from defaults.
    }
  }

  get() {
    return this.state;
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.file);
  }

  ack(key, now) {
    if (typeof key !== 'string' || key.length > 600) throw new Error('bad ack key');
    for (const [k, at] of Object.entries(this.state.acks)) {
      if (now - at > ACK_TTL) delete this.state.acks[k];
    }
    this.state.acks[key] = now;
    this.save();
  }

  unack(key) {
    delete this.state.acks[key];
    this.save();
  }

  setPomodoro({ settings, run }) {
    if (settings !== undefined) {
      if (!validSettings(settings)) throw new Error('bad pomodoro settings');
      this.state.pomodoro.settings = {
        work: settings.work, short: settings.short, long: settings.long, longEvery: settings.longEvery,
      };
    }
    if (run !== undefined) {
      if (!validRun(run)) throw new Error('bad pomodoro run');
      this.state.pomodoro.run = {
        status: run.status, phase: run.phase,
        endsAt: run.status === 'running' ? run.endsAt : null,
        remainingMs: run.status === 'paused' ? run.remainingMs : null,
        done: run.done,
      };
    }
    this.save();
  }
}
