// The frame's stock WebView is Chrome 44, so the UI must stay ES5 with old-browser CSS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'acorn';

const dir = new URL('../public/', import.meta.url);
const files = readdirSync(dir);

test('frontend scripts parse as ES5', () => {
  const scripts = files.filter((f) => f.endsWith('.js'));
  assert.ok(scripts.length >= 2);
  for (const f of scripts) {
    assert.doesNotThrow(() => parse(readFileSync(new URL(f, dir), 'utf8'), { ecmaVersion: 5 }), f);
  }
});

test('frontend scripts avoid APIs newer than Chrome 44', () => {
  const banned = [/\bfetch\(/, /\.find\(/, /\.findIndex\(/, /\.includes\(/, /Object\.assign/, /\.padStart\(/, /Array\.from/, /\bPromise\b/];
  for (const f of files.filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(new URL(f, dir), 'utf8').replace(/\/\/.*$/gm, '');
    for (const re of banned) assert.ok(!re.test(src), `${f} uses ${re}`);
  }
});

test('stylesheet avoids CSS the old WebView rejects', () => {
  const css = readFileSync(new URL('style.css', dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const banned = [/var\(--/, /--[a-z-]+\s*:/, /:has\(/, /oklch\(/, /color-mix\(/, /display:\s*grid/, /\bgap\s*:/, /\binset\s*:/, /#[0-9a-fA-F]{4}\b/, /#[0-9a-fA-F]{8}\b/];
  for (const re of banned) assert.ok(!re.test(css), `style.css matches ${re}`);
});

test('the text card is filled with textContent, never innerHTML', () => {
  const src = readFileSync(new URL('app.js', dir), 'utf8');
  assert.match(src, /\('textBody'\)\.textContent = d\.text/);
  assert.ok(!/innerHTML[^;]*\bd\.text\b/.test(src), 'feed text must not reach innerHTML');
});
