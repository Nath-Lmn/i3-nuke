#!/usr/bin/env node
/*
 * QA harness for ../../index.html (single-file static page).
 *
 * Non-interactive. Exit code 0 = no FAIL, 1 = at least one FAIL, 2 = harness error.
 * Drives a real Chrome through puppeteer-core over file://.
 *
 * Env:
 *   CHROME_PATH   path to chrome.exe / msedge.exe (auto-detected otherwise)
 *   QA_OUT        directory for screenshots / pdf (default: <os tmp>/i3-nuke-qa)
 *   QA_ONLY       comma separated list of check groups to run (default: all)
 *                 groups: load,layout,content,interact,a11y,motion,robust,html,design,regress
 *
 * Status meaning: PASS, FAIL (fails the run), WARN (reported, does not fail), INFO.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..');
const INDEX = path.join(ROOT, 'index.html');
const INDEX_URL = pathToFileURL(INDEX).href;
const OUT = process.env.QA_OUT || path.join(os.tmpdir(), 'i3-nuke-qa');
const ONLY = (process.env.QA_ONLY || '').split(',').filter(Boolean);
fs.mkdirSync(OUT, { recursive: true });

let puppeteer, axeSource, HtmlValidate;
try { puppeteer = require('puppeteer-core'); } catch (e) { console.error('Missing dependency puppeteer-core: run `npm install` in tests/site'); process.exit(2); }
try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch (e) { axeSource = null; }
try { ({ HtmlValidate } = require('html-validate')); } catch (e) { HtmlValidate = null; }

/* ------------------------------------------------------------ reporting */
const results = [];
function rec(group, id, status, name, evidence) {
  results.push({ group, id, status, name, evidence: String(evidence === undefined ? '' : evidence) });
  const tag = status.padEnd(4);
  console.log(`[${tag}] ${id} ${name}${evidence ? '\n         ' + String(evidence).split('\n').join('\n         ') : ''}`);
}
const pass = (g, id, name, ev) => rec(g, id, 'PASS', name, ev);
const fail = (g, id, name, ev) => rec(g, id, 'FAIL', name, ev);
const warn = (g, id, name, ev) => rec(g, id, 'WARN', name, ev);
const info = (g, id, name, ev) => rec(g, id, 'INFO', name, ev);
const check = (g, id, name, ok, ev) => rec(g, id, ok ? 'PASS' : 'FAIL', name, ev);
const want = g => !ONLY.length || ONLY.includes(g);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const short = (o, n = 900) => { const s = typeof o === 'string' ? o : JSON.stringify(o); return s.length > n ? s.slice(0, n) + '...' : s; };

/* ------------------------------------------------------------ chrome */
function findChrome() {
  const c = [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return c.filter(Boolean).find(p => fs.existsSync(p));
}

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

async function openPage(browser, o = {}) {
  const page = await browser.newPage();
  const log = { console: [], errors: [], failed: [], external: [], bad: [], dialogs: [] };
  page._log = log;
  await page.setViewport({ width: o.w || 1280, height: o.h || 800, deviceScaleFactor: o.dsf || 1, isMobile: !!o.mobile, hasTouch: !!o.mobile });
  if (o.js === false) await page.setJavaScriptEnabled(false);
  page.on('console', m => { if (['error', 'warning', 'assert'].includes(m.type())) log.console.push(m.type() + ': ' + m.text() + ' @' + (m.location().url || '')); });
  page.on('pageerror', e => log.errors.push(String(e.message || e)));
  page.on('dialog', d => { log.dialogs.push(d.type() + ':' + d.message()); d.dismiss().catch(() => {}); });
  page.on('requestfailed', r => log.failed.push(r.url().slice(0, 120) + ' ' + (r.failure() || {}).errorText));
  page.on('request', r => {
    const u = r.url();
    if (/^(file|data|about|blob|chrome):/.test(u)) return;
    let host = ''; try { host = new URL(u).host; } catch (e) {}
    log.external.push(u.slice(0, 140));
    if (!FONT_HOSTS.includes(host)) log.bad.push(u.slice(0, 140));
  });
  page.on('response', r => { if (r.status() >= 400) log.failed.push(r.status() + ' ' + r.url().slice(0, 120)); });
  if (o.reduced) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  if (o.blockFonts) {
    await page.setRequestInterception(true);
    page.on('request', r => { let h = ''; try { h = new URL(r.url()).host; } catch (e) {} FONT_HOSTS.includes(h) ? r.abort('blockedbyclient') : r.continue(); });
  }
  return page;
}
async function load(page, hash = '') {
  await page.goto(INDEX_URL + hash, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await sleep(250);
}
const openAll = page => page.evaluate(() => document.querySelectorAll('tr.part').forEach(tr => { if (tr.dataset.open !== '1') tr.querySelector('.toggle').click(); }));

/* ------------------------------------------------------------ browser-side probes */
const PROBE = {
  overflow: () => {
    const de = document.documentElement, vw = de.clientWidth, off = [], txt = [];
    const skip = el => el.closest('.sr-only, .skip, .matrix-wrap, .tabs, svg defs');
    for (const el of document.querySelectorAll('body *')) {
      if (skip(el)) continue;
      const th = el.closest('thead'); if (th && th.getBoundingClientRect().width <= 2) continue; /* visually-hidden header of reflowed tables */
      if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      if (r.right > vw + 1 || r.left < -1) off.push((el.className && el.className.baseVal === undefined ? '.' + String(el.className).split(' ')[0] : el.tagName.toLowerCase()) + '#' + (el.id || '') + ' ' + el.tagName.toLowerCase() + ' L' + Math.round(r.left) + ' R' + Math.round(r.right));
      // text overflowing its own box
      if (cs.display !== 'inline' && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1 && !/^(table|tbody|thead|tr)$/.test(el.tagName.toLowerCase())) txt.push('scroll ' + el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0] + ' sw' + el.scrollWidth + ' cw' + el.clientWidth + ' "' + (el.textContent || '').trim().slice(0, 30) + '"');
      if (/^(td|th|p|li|pre|span|b|strong|code|a|button|h1|h2|h3|dd|dt|figcaption)$/.test(el.tagName.toLowerCase()) && el.children.length === 0 && (el.textContent || '').trim()) {
        const box = (el.closest('td,th,.notice-b,.cmd,.drawing,.legend li,.refblock div,p,li,h1,h2,h3') || el).getBoundingClientRect();
        const rg = document.createRange(); rg.selectNodeContents(el);
        for (const q of rg.getClientRects()) if (q.right > box.right + 1.5 || q.left < box.left - 1.5) { txt.push('escape ' + el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0] + ' "' + el.textContent.trim().slice(0, 30) + '" ' + Math.round(q.left) + '..' + Math.round(q.right) + ' box ' + Math.round(box.left) + '..' + Math.round(box.right)); break; }
      }
    }
    const mw = document.querySelector('.matrix-wrap');
    const mcs = mw ? getComputedStyle(mw) : null;
    return { scrollW: de.scrollWidth, bodyScrollW: document.body.scrollWidth, vw, innerW: innerWidth, off: off.slice(0, 15), txt: txt.slice(0, 15),
      matrixShown: !!(mcs && mcs.display !== 'none'), matrixScrolls: !!(mw && mcs.display !== 'none' && mw.scrollWidth > mw.clientWidth + 1), matrixW: mw ? mw.scrollWidth + '/' + mw.clientWidth : null };
  },
  tabs: () => {
    const nav = document.querySelector('.tabs'); const cs = getComputedStyle(nav); const ol = nav.querySelector('ol');
    const r = nav.getBoundingClientRect(); const o = ol.getBoundingClientRect(); const vh = innerHeight, vw = innerWidth;
    const lo = Math.max(o.top, 0), hi = Math.min(o.bottom, vh);
    const links = [...nav.querySelectorAll('a')]; const rs = links.map(a => a.getBoundingClientRect());
    const hidden = rs.filter(l => l.top < lo - 0.5 || l.bottom > hi + 0.5 || l.left < o.left - 0.5 || l.right > o.right + 0.5).length;
    const fs = parseFloat(getComputedStyle(links[0]).fontSize);
    return { pos: cs.position, top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), vh, vw,
      clipped: hidden > 0, clippedLinks: hidden, n: links.length, scrolls: ol.scrollHeight > ol.clientHeight + 1, overflowY: getComputedStyle(ol).overflowY, fontPx: fs,
      labels: links.map(a => a.innerText.trim()).join('|'), totalH: Math.round(rs.reduce((s, l) => s + l.height, 0)) };
  },
  tabsReach: () => {
    const links = [...document.querySelectorAll('.tabs a')], bad = [];
    for (const a of links) {
      a.focus(); const r = a.getBoundingClientRect(); const ol = document.querySelector('.tabs ol').getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2; const top = document.elementFromPoint(cx, cy);
      const ok = r.top >= Math.max(ol.top, 0) - 0.5 && r.bottom <= Math.min(ol.bottom, innerHeight) + 0.5 && top && (top === a || a.contains(top));
      if (!ok) bad.push(a.dataset.for + ' top' + Math.round(r.top) + ' bottom' + Math.round(r.bottom));
    }
    document.activeElement.blur(); return bad;
  },
  tabsOverlap: () => {
    const nav = document.querySelector('.tabs'); if (getComputedStyle(nav).position !== 'fixed') return { applicable: false };
    const tr = [...nav.querySelectorAll('a')].map(a => a.getBoundingClientRect());
    const hits = [];
    const w = document.createTreeWalker(document.querySelector('.sheet'), NodeFilter.SHOW_TEXT);
    let n; while ((n = w.nextNode())) {
      if (!n.nodeValue.trim() || n.parentElement.closest('.tabs, .sr-only, svg defs, [hidden]')) continue;
      const rg = document.createRange(); rg.selectNodeContents(n);
      for (const q of rg.getClientRects()) {
        if (q.width < 1 || q.bottom < 0 || q.top > innerHeight) continue;
        if (tr.some(t => q.left < t.right && q.right > t.left && q.top < t.bottom && q.bottom > t.top)) { hits.push(n.nodeValue.trim().slice(0, 25) + ' @' + Math.round(q.left) + ',' + Math.round(q.top)); break; }
      }
    }
    return { applicable: true, hits };
  },
  contrast: () => {
    const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
    const lum = c => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }; return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b); };
    const bgOf = el => { const layers = []; let imgs = false; for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); const b = parse(cs.backgroundColor); if (cs.backgroundImage !== 'none' && e !== el) imgs = true; if (b && b.a > 0) { layers.push(b); if (b.a >= 1) break; } } let base = { r: 255, g: 255, b: 255, a: 1 }; for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base); return { c: base, imgs }; };
    const bad = [], seen = []; let min = 99, minEl = '';
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('.sr-only, defs, [hidden], title, style, script')) continue;
      const own = [...el.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim());
      if (!own) continue;
      const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
      const isSvg = el.closest('svg') !== null;
      const fgc = parse(isSvg ? cs.fill : cs.color); if (!fgc) continue;
      const { c: bg, imgs } = bgOf(el);
      let op = 1; for (let e = el; e; e = e.parentElement) op *= parseFloat(getComputedStyle(e).opacity);
      const fg = over({ ...fgc, a: fgc.a * op }, bg);
      const L1 = lum(fg), L2 = lum(bg); const ratio = (Math.max(L1, L2) + .05) / (Math.min(L1, L2) + .05);
      const px = parseFloat(cs.fontSize), w = parseInt(cs.fontWeight, 10) || 400;
      const large = px >= 24 || (px >= 18.66 && w >= 700); const need = large ? 3 : 4.5;
      const tag = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '') + ' "' + el.textContent.trim().slice(0, 28) + '"';
      seen.push(1);
      if (ratio < min) { min = ratio; minEl = tag; }
      if (ratio < need) bad.push({ el: tag, ratio: +ratio.toFixed(2), need, px, w, fg: `rgb(${fg.r | 0},${fg.g | 0},${fg.b | 0})`, bg: `rgb(${bg.r | 0},${bg.g | 0},${bg.b | 0})`, svg: isSvg, imgBg: imgs });
    }
    return { tested: seen.length, min: +min.toFixed(2), minEl, bad };
  },
  focusInfo: () => {
    const e = document.activeElement; if (!e || e === document.body) return null;
    const cs = getComputedStyle(e), r = e.getBoundingClientRect();
    const rcx = r.left + r.width / 2, rcy = r.top + r.height / 2; const cx = Math.min(Math.max(rcx, 0), innerWidth - 1), cy = Math.min(Math.max(rcy, 0), innerHeight - 1);
    const top = document.elementFromPoint(cx, cy);
    const outlined = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
    const shadow = cs.boxShadow !== 'none';
    return { id: e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : '') + ' "' + ((e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 24)) + '"',
      outlined, shadow, outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor, inView: rcx >= 0 && rcx <= innerWidth && rcy >= 0 && rcy <= innerHeight && (r.width > innerWidth || (r.left > -1 && r.right < innerWidth + 1)),
      obscured: !!top && !(e === top || e.contains(top) || top.contains(e)), obscuredBy: top ? top.tagName.toLowerCase() + '.' + String(top.className).split(' ')[0] : '', pageY: Math.round(r.top + scrollY), x: Math.round(r.left), inMain: !!e.closest('main'), inTabs: !!e.closest('.tabs'), w: Math.round(r.width), h: Math.round(r.height) };
  },
  figures: () => {
    const out = [];
    for (const svg of document.querySelectorAll('svg.fig')) {
      const t = svg.querySelector('title'); const lid = svg.getAttribute('aria-labelledby');
      const named = !!(lid && document.getElementById(lid) && document.getElementById(lid).textContent.trim());
      const vb = svg.viewBox.baseVal; const issues = [];
      const texts = [...svg.querySelectorAll('text')].map(x => ({ x, r: x.getBoundingClientRect(), s: x.textContent }));
      const sr = svg.getBoundingClientRect(); const sc = sr.width / vb.width;
      texts.forEach(a => { if (a.r.left < sr.left - 1 || a.r.right > sr.right + 1 || a.r.top < sr.top - 1 || a.r.bottom > sr.bottom + 1) issues.push('text outside viewBox: "' + a.s + '"'); });
      for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i].r, b = texts[j].r; const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 2 * sc && oy > 3 * sc) issues.push('text overlap: "' + texts[i].s + '" / "' + texts[j].s + '"');
      }
      const all = [...svg.querySelectorAll('rect,line,path,circle,ellipse')].filter(e => !e.closest('defs,marker,pattern'));
      all.forEach(e => { const r = e.getBoundingClientRect(); if (r.width && (r.left < sr.left - 2 || r.right > sr.right + 2 || r.top < sr.top - 2 || r.bottom > sr.bottom + 2)) issues.push('shape outside viewBox: ' + e.tagName + ' ' + (e.getAttribute('d') || '').slice(0, 20)); });
      out.push({ id: svg.id || (svg.closest('tr') || {}).id, role: svg.getAttribute('role'), named, title: t ? t.textContent.slice(0, 40) : '', shapes: all.length, texts: texts.length, issues });
    }
    return out;
  },
  anims: () => ({ running: document.getAnimations().map(a => (a.animationName || a.transitionProperty || a.constructor.name)).slice(0, 10),
    css: [...document.querySelectorAll('*')].filter(e => { const c = getComputedStyle(e); return (c.animationName !== 'none' && parseFloat(c.animationDuration) > 0) || parseFloat(c.transitionDuration) > 0; }).map(e => e.tagName.toLowerCase() + '.' + String(e.className && e.className.baseVal === undefined ? e.className : '').split(' ')[0]).slice(0, 10),
    stampAnim: (() => { const s = document.querySelector('.stamp svg'); return s ? getComputedStyle(s).animationName : 'n/a'; })() }),
  matrix: () => {
    const t = document.querySelector('.matrix'); if (!t) return null;
    const cols = [...t.querySelectorAll('thead th.col')].map(th => th.textContent.trim());
    const rows = [...t.querySelectorAll('tbody tr')].map(tr => ({ pkg: tr.querySelector('th').textContent.trim(), cols: [...tr.querySelectorAll('td')].map((td, i) => td.textContent.includes('●') ? i : -1).filter(i => i >= 0) }));
    return { cols, rows };
  },
  parts: () => [...document.querySelectorAll('tr.part')].map(tr => ({
    id: tr.id, n: tr.querySelector('.n').textContent.trim(), name: tr.querySelector('.toggle code').textContent.trim(), eff: tr.querySelector('.eff').textContent.trim(),
    cls: tr.querySelector('.cl').textContent.trim(), anti: tr.querySelector('.anti code') ? tr.querySelector('.anti code').textContent.trim() : tr.querySelector('.anti').textContent.trim(),
    antiBtn: tr.querySelector('.anti .copy') ? tr.querySelector('.anti .copy').dataset.copy : null })),
  visibleRows: () => [...document.querySelectorAll('tr.part')].filter(tr => !tr.hidden && getComputedStyle(tr).display !== 'none').map(tr => tr.id.replace('part-', ''))
};

/* ------------------------------------------------------------ README / prank.sh sources */
function readSources() {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const strip = s => s.replace(/`/g, '').replace(/\*\*/g, '').trim();
  const rows = [];
  for (const l of readme.split(/\r?\n/)) {
    const m = l.match(/^\|\s*(\d+)\s*\|\s*`([^`]+)`\s*\|(.*)\|([^|]*)\|\s*$/);
    if (m) rows.push({ n: +m[1], name: m[2], effect: strip(m[3]), anti: strip(m[4]) });
  }
  const deps = []; let inDeps = false;
  for (const l of readme.split(/\r?\n/)) {
    if (/^##\s+D[ée]pendances/.test(l)) { inDeps = true; continue; }
    if (inDeps && /^##\s/.test(l)) break;
    const m = inDeps && l.match(/^\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*$/);
    if (m && !/^(option|---)/i.test(m[1]) && !/^-+$/.test(m[1])) deps.push({ opt: m[1].replace(/`/g, ''), pk: m[2] });
  }
  let list = '';
  try { list = cp.execFileSync('bash', ['./prank.sh', 'list'], { cwd: ROOT, encoding: 'utf8', timeout: 20000 }); }
  catch (e) { list = fs.readFileSync(path.join(ROOT, 'prank.sh'), 'utf8').split(/\r?\n/).filter(l => /say "\s+\d+\s+[a-z-]+\s/.test(l)).join('\n'); }
  list = list.replace(/\x1b\[[0-9;]*m/g, '');
  const pr = [];
  for (const l of list.split(/\r?\n/)) { const m = l.match(/^\s*(\d+)\s+([a-z][a-z-]*)\s+(.*)$/) || l.match(/say "\s*(\d+)\s+([a-z][a-z-]*)\s+(.*)$/); if (m && +m[1] <= 16) pr.push({ n: +m[1], name: m[2], rc: /\[fichier rc/.test(l) }); }
  return { rows, deps, list: pr, readme };
}
const foldTxt = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/* ------------------------------------------------------------ main */
(async () => {
  const chrome = findChrome();
  if (!chrome) { console.error('No Chrome/Edge found; set CHROME_PATH'); process.exit(2); }
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--allow-file-access-from-files', '--hide-scrollbars=false'] });
  const ver = await browser.version();
  console.log('Browser:', ver, '| index:', INDEX, '| out:', OUT, '\n');
  const SRC = readSources();
  const G = (name, fn) => want(name) ? fn().catch(e => fail(name, name + '-crash', 'check group crashed', e.stack || e)) : null;

  const VPS = [
    { w: 1280, h: 800 }, { w: 768, h: 1024 }, { w: 360, h: 740, mobile: true }, { w: 1280, h: 600 }, { w: 320, h: 640, mobile: true },
    { w: 900, h: 700 }, { w: 1000, h: 700 }, { w: 1100, h: 700 }, { w: 719, h: 900 }, { w: 720, h: 900 }, { w: 640, h: 900 }, { w: 639, h: 900 }, { w: 480, h: 800, mobile: true }, { w: 1440, h: 900 }
  ];
  const vpName = v => `${v.w}x${v.h}`;

  /* ===== 1 + 2: load, console, layout ===== */
  await G('load', async () => {
    for (const vp of VPS.slice(0, 4).concat([VPS[4]])) {
      const page = await openPage(browser, vp);
      await load(page);
      await openAll(page); await sleep(700);
      await page.evaluate(() => scrollTo(0, document.body.scrollHeight)); await sleep(300);
      const L = page._log;
      const probs = [...L.console, ...L.errors.map(e => 'pageerror: ' + e), ...L.failed, ...L.dialogs.map(d => 'dialog ' + d)];
      check('load', '1.' + vpName(vp), `console errors/warnings/exceptions at ${vpName(vp)} (all 16 rows expanded, scrolled to bottom)`, probs.length === 0, probs.length ? probs.join('\n') : 'none');
      check('load', '1x.' + vpName(vp), `no external requests other than Google Fonts at ${vpName(vp)}`, L.bad.length === 0, L.bad.length ? L.bad.join('\n') : 'external: ' + (L.external.length ? [...new Set(L.external.map(u => new URL(u).host))].join(', ') : 'none'));
      await page.close();
    }
  });

  await G('layout', async () => {
    for (const vp of VPS) {
      const page = await openPage(browser, { ...vp, mobile: false });
      await load(page); await openAll(page); await sleep(900);
      const o = await page.evaluate(PROBE.overflow);
      check('layout', '2.' + vpName(vp), `no horizontal scroll at ${vpName(vp)}`, o.scrollW <= o.vw && o.bodyScrollW <= o.vw, `scrollWidth ${o.scrollW} / body ${o.bodyScrollW} / client ${o.vw}`);
      check('layout', '2t.' + vpName(vp), `no element past viewport / text escaping boxes at ${vpName(vp)} (rows expanded)`, o.off.length === 0 && o.txt.length === 0, short({ off: o.off, txt: o.txt }));
      if (o.matrixShown) (o.matrixScrolls ? warn : pass)('layout', '2m.' + vpName(vp), `matrix fits its wrapper at ${vpName(vp)}`, 'scrollWidth/clientWidth ' + o.matrixW);
      if (vp.w >= 900) {
        const hits = [];
        const H = await page.evaluate(() => document.documentElement.scrollHeight);
        for (let y = 0; y < H; y += Math.floor(vp.h * 0.6)) { await page.evaluate(yy => scrollTo(0, yy), y); await sleep(30); const ov = await page.evaluate(PROBE.tabsOverlap); if (ov.applicable) hits.push(...ov.hits.map(h => y + ':' + h)); }
        check('layout', '2ov.' + vpName(vp), `tabs never overlap page text while scrolling at ${vpName(vp)}`, hits.length === 0, hits.length ? hits.slice(0, 6).join('; ') : 'no overlap');
      }
      await page.close();
    }
    // Tabs vs viewport size: fully visible without scrolling, or (very short) reachable
    for (const [w, h, mode] of [[1280, 800, 'full'], [1280, 720, 'full'], [1280, 600, 'full'], [1280, 540, 'full'], [900, 700, 'full'], [1000, 700, 'full'], [1100, 700, 'full'], [960, 540, 'full'], [1440, 900, 'full'], [1920, 1080, 'full'], [900, 500, 'full'], [1280, 860, 'full'], [1280, 400, 'reach'], [1280, 300, 'reach']]) {
      const page = await openPage(browser, { w, h }); await load(page);
      const t = await page.evaluate(PROBE.tabs);
      if (mode === 'full') check('layout', `2tab.${w}x${h}`, `all 9 right-edge tabs fully visible without scrolling at ${w}x${h}`, !t.clipped && !t.scrolls, `nav ${t.top}..${t.bottom} (vh ${t.vh}), hidden tabs ${t.clippedLinks}/${t.n}, scrolls ${t.scrolls}, tab font ${t.fontPx}px, labels ${t.labels}`);
      const bad = await page.evaluate(PROBE.tabsReach);
      check('layout', `2reach.${w}x${h}`, `every tab can be brought into view and hit at ${w}x${h} (focus scrolls the strip)`, bad.length === 0, bad.join('; ') || `ok (scrollable strip: ${t.scrolls}, overflow-y ${t.overflowY}, visible without scroll: ${t.n - t.clippedLinks}/${t.n})`);
      await page.close();
    }
    // Screenshots per section
    for (const vp of [{ w: 1280, h: 800 }, { w: 360, h: 740, mobile: true }, { w: 768, h: 1024 }, { w: 1280, h: 600 }]) {
      const page = await openPage(browser, vp); await load(page);
      await page.screenshot({ path: path.join(OUT, `viewport-${vpName(vp)}-top.png`) });
      for (const id of ['cover', 'contents', 'safety', 'install', 'parts', 'matrix', 'recovery', 'annex', 'colophon']) {
        const el = await page.$('#' + id); if (!el) continue;
        await el.evaluate(e => e.scrollIntoView({ block: 'start' })); await sleep(120);
        try { await el.screenshot({ path: path.join(OUT, `sec-${vpName(vp)}-${id}.png`) }); } catch (e) { /* element too tall */ }
      }
      await openAll(page); await sleep(900);
      const parts = await page.$('#parts');
      try { await parts.screenshot({ path: path.join(OUT, `sec-${vpName(vp)}-parts-open.png`) }); } catch (e) {}
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: path.join(OUT, `full-${vpName(vp)}.png`), fullPage: true }).catch(() => {});
      await page.close();
    }
    info('layout', '2shots', 'screenshots written', OUT);
  });

  /* ===== 3: content fidelity ===== */
  await G('content', async () => {
    const page = await openPage(browser, { w: 1280, h: 800 }); await load(page);
    const parts = await page.evaluate(PROBE.parts);
    const R = SRC.rows, LST = SRC.list;
    check('content', '3.count', 'exactly 16 pranks in page, README and prank.sh list', parts.length === 16 && R.length === 16 && LST.length === 16, `page ${parts.length}, README ${R.length}, prank.sh list ${LST.length}`);
    check('content', '3.names', 'names and order equal README table', JSON.stringify(parts.map(p => p.name)) === JSON.stringify(R.map(r => r.name)), parts.map(p => p.name).join(','));
    check('content', '3.names-list', 'names and order equal `./prank.sh list`', JSON.stringify(parts.map(p => p.name)) === JSON.stringify(LST.map(r => r.name)), LST.map(p => p.name).join(','));
    check('content', '3.numbers', 'row numbers are 01..16 in order', parts.every((p, i) => p.n === String(i + 1).padStart(2, '0')), parts.map(p => p.n).join(','));
    const bad = [];
    parts.forEach((p, i) => {
      const r = R[i]; if (!r) return;
      if (/^undo /.test(r.anti)) {
        if (p.anti !== r.anti) bad.push(`${p.name}: antidote "${p.anti}" != README "${r.anti}"`);
        if (p.anti !== 'undo ' + p.name) bad.push(`${p.name}: antidote is not 'undo <name>'`);
        if (p.antiBtn !== './prank.sh undo ' + p.name) bad.push(`${p.name}: copy payload "${p.antiBtn}"`);
      } else if (foldTxt(p.anti) !== foldTxt(r.anti)) bad.push(`${p.name}: antidote "${p.anti}" != README "${r.anti}"`);
    });
    check('content', '3.antidotes', 'antidote cell and copy payload for every prank match README (`undo <name>` / password)', bad.length === 0, bad.join('\n') || 'all 16 ok');
    const ls = parts.find(p => p.name === 'lock-shot');
    check('content', '3.lockshot', "lock-shot antidote is the victim's password and has no undo command/copy button", !!ls && /mot de passe de la victime/i.test(ls.anti) && ls.antiBtn === null && !/undo/.test(ls.anti), ls && ls.anti);
    const cb = [];
    parts.forEach((p, i) => { const rc = LST[i] && LST[i].rc; const exp = p.name === 'lock-shot' ? 'C' : rc ? 'B' : 'A'; if (p.cls !== exp) cb.push(`${p.name}: page ${p.cls} expected ${exp}`); });
    check('content', '3.classes', 'class B == [rc] rows of `prank.sh list` (swap-commands, swap-apps, shutup, terminal-shutdown), C == lock-shot, rest A', cb.length === 0, cb.join('\n') || 'B: ' + parts.filter(p => p.cls === 'B').map(p => p.name).join(',') + ' | C: ' + parts.filter(p => p.cls === 'C').map(p => p.name).join(','));
    // effect wording vs README (informational, wording may be adapted)
    const sig = s => foldTxt(s).replace(/[^a-z0-9]+/g, ' ').trim();
    const diffs = parts.map((p, i) => ({ p, r: R[i] })).filter(x => x.r && sig(x.p.eff) !== sig(x.r.effect)).map(x => `${x.p.name}: page "${x.p.eff}" | README "${x.r.effect}"`);
    diffs.length ? warn('content', '3.effects', `${diffs.length} effect texts reworded vs README (check no meaning change)`, diffs.join('\n')) : pass('content', '3.effects', 'effect texts equal README', '');
    // install commands
    const cmds = await page.evaluate(() => [...document.querySelectorAll('[id^=cmd-]')].map(c => ({ id: c.id, t: c.textContent.trim() })));
    const exp = { 'cmd-1': 'curl -fsSL https://raw.githubusercontent.com/Nath-Lmn/i3-nuke/main/prank.sh -o prank.sh && chmod +x prank.sh', 'cmd-2': './prank.sh', 'cmd-3': './prank.sh rotate', 'cmd-4': './prank.sh undo-all', 'cmd-5': './prank.sh new-terminal', 'cmd-6': './prank.sh undo-all' };
    const cbad = Object.keys(exp).filter(k => (cmds.find(c => c.id === k) || {}).t !== exp[k]);
    check('content', '3.cmds', 'install/use command blocks exact (curl URL, chmod, list, rotate, undo-all, new-terminal)', cbad.length === 0 && cmds.length === 6, cbad.length ? cbad.join(',') : cmds.map(c => c.t).join(' | '));
    const readmeCmds = ['chmod +x prank.sh', './prank.sh', './prank.sh list', './prank.sh rotate', './prank.sh undo rotate', './prank.sh undo-all', './prank.sh new-terminal'];
    check('content', '3.readme-cmds', 'README install block contains the commands the page documents', readmeCmds.every(c => SRC.readme.includes(c)), readmeCmds.filter(c => !SRC.readme.includes(c)).join(',') || 'ok');
    // every ./prank.sh X mentioned anywhere is a real subcommand or prank name
    const body = await page.evaluate(() => document.body.innerText + ' ' + [...document.querySelectorAll('[data-copy]')].map(b => b.dataset.copy).join(' '));
    const known = new Set([...R.map(r => r.name), 'list', 'undo', 'undo-all', 'new-terminal']);
    const mentioned = [...body.matchAll(/\.\/prank\.sh(?:\s+undo)?\s+([a-z<][a-z<>-]*)/g)].map(m => m[1]);
    const unknown = [...new Set(mentioned.filter(x => !known.has(x) && x !== '<nom>' && x !== 'undo'))];
    check('content', '3.subcommands', 'every `./prank.sh <x>` / `undo <x>` mentioned refers to a real name/subcommand', unknown.length === 0, unknown.join(',') || `${mentioned.length} mentions checked`);
    const prankSrc = fs.readFileSync(path.join(ROOT, 'prank.sh'), 'utf8');
    check('content', '3.subcmds-src', 'list / undo / undo-all / new-terminal exist in prank.sh', ['undo-all)', 'undo)', 'new-terminal', 'list'].every(s => prankSrc.includes(s)), '');
    // links
    const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')));
    const ext = [...new Set(links.filter(h => /^https?:/.test(h)))];
    check('content', '3.links', 'external links are only the GitHub repo (and README anchor)', ext.every(h => /^https:\/\/github\.com\/Nath-Lmn\/i3-nuke(#readme)?$/.test(h)), ext.join(', '));
    const anchors = [...new Set(links.filter(h => h.startsWith('#')))];
    const missing = await page.evaluate(a => a.filter(h => !document.getElementById(h.slice(1))), anchors);
    check('content', '3.anchors', 'all in-page anchors resolve to an id', missing.length === 0, missing.join(',') || anchors.length + ' anchors ok');
    // matrix vs README deps table
    const mx = await page.evaluate(PROBE.matrix);
    const names = R.map(r => r.name);
    const expand = opt => { const out = new Set(); opt.split(',').map(s => s.trim()).forEach(tok => { if (tok.includes('*')) { const re = new RegExp('^' + tok.replace(/\*/g, '.*') + '$'); names.filter(n => re.test(n)).forEach(n => out.add(n)); } else out.add(tok); }); return out; };
    const tokensFor = {
      'i3lock': ['i3lock'], 'maim / ImageMagick': ['maim', 'ImageMagick'], 'xrandr': ['xrandr'], 'xinput': ['xinput'], 'setxkbmap': ['setxkbmap'],
      'xcursorgen': ['xcursorgen'], 'vim +clientserver': ['vim'], 'xprop': ['xprop'], 'xwininfo': ['xwininfo'], 'picom / compton': ['picom', 'compton'], 'oneko': ['oneko'] };
    const pkgTokens = d => { const t = new Set([...d.pk.matchAll(/`([^`]+)`/g)].map(m => m[1].replace(/^xorg\./, '').replace(/\+clientserver.*/, '').trim())); if (/ImageMagick/.test(d.pk)) t.add('ImageMagick'); if (/^vim/.test(d.pk)) t.add('vim'); return t; };
    const mxBad = [];
    check('content', '3.matrix-shape', 'matrix has 16 columns in README order and 11 package rows', mx && mx.cols.length === 16 && mx.rows.length === 11 && mx.cols.every((c, i) => c === String(i + 1).padStart(2, '0') + ' ' + names[i]), mx ? mx.cols.length + ' cols, ' + mx.rows.length + ' rows' : 'no matrix');
    if (mx) {
      mx.rows.forEach(row => {
        const toks = tokensFor[row.pkg]; if (!toks) { mxBad.push('unknown row ' + row.pkg); return; }
        const expSet = new Set(); SRC.deps.forEach(d => { const pt = pkgTokens(d); if (toks.some(t => pt.has(t))) expand(d.opt).forEach(n => expSet.add(n)); });
        const got = new Set(row.cols.map(i => names[i]));
        const miss = [...expSet].filter(n => !got.has(n)), extra = [...got].filter(n => !expSet.has(n));
        if (miss.length || extra.length) mxBad.push(`${row.pkg}: missing [${miss}] extra [${extra}]`);
      });
    }
    check('content', '3.matrix', `dependency matrix equals README dependency table (${SRC.deps.length} README rows parsed)`, mxBad.length === 0 && SRC.deps.length >= 6, mxBad.join('\n') || mx.rows.map(r => `${r.pkg}:${r.cols.map(i => names[i]).join('/')}`).join('\n'));
    const depTable = await page.evaluate(() => [...document.querySelectorAll('.deps tbody tr')].map(tr => [...tr.children].map(c => c.textContent.trim().replace(/\s+/g, ' ')).join(' => ')));
    info('content', '3.deplist', 'fallback dependency list (page)', depTable.join('\n'));
    info('content', '3.deplist-readme', 'README dependency rows (parsed)', SRC.deps.map(d => d.opt + ' => ' + d.pk).join('\n'));
    // [rc] explanation and counts claim
    const txt = await page.evaluate(() => document.body.innerText);
    check('content', '3.sixteen', "copy says sixteen/16 pranks and never another count", !/\b(quinze|dix-sept|15 modules|17 modules)\b/i.test(txt) && /seize/i.test(txt), '');
    const pn = await page.evaluate(() => [...document.querySelectorAll('td')].map(td => td.textContent).join('\n').match(/n° ?\d+/g) || []);
    const trouble = await page.evaluate(() => [...document.querySelectorAll('.trouble tbody tr')].map(tr => tr.children[1].textContent.trim()));
    const nbad = []; trouble.forEach(c => [...c.matchAll(/([a-z-]+)(?: \(n° (\d+)\))/g)].forEach(m => { const r = R.find(x => x.name === m[1]); if (!r || r.n !== +m[2]) nbad.push(m[1] + ' n°' + m[2]); }));
    check('content', '3.trouble-numbers', 'prank numbers cited in troubleshooting table match README numbering', nbad.length === 0, nbad.join(',') || 'ok');
    const tUndo = await page.evaluate(() => [...document.querySelectorAll('.trouble code')].map(c => c.textContent.trim()).filter(t => /^\.\/prank\.sh undo /.test(t)));
    const tBad = tUndo.filter(t => !/^\.\/prank\.sh undo (<nom>|undo-all|[a-z-]+)$/.test(t) || (t.split(' ')[2] && t.split(' ')[2] !== 'undo-all' && !names.includes(t.split(' ')[2])));
    check('content', '3.trouble-undo', 'every undo command in the troubleshooting table names a real prank', tBad.length === 0, tBad.join(',') || tUndo.length + ' commands ok');
    const covered = names.filter(n => n !== 'lock-shot' && !tUndo.some(t => t.endsWith(' ' + n)) && !/vim-(red|mirror|light)/.test(n));
    info('content', '3.trouble-coverage', 'pranks without their own undo line in troubleshooting (vim-* grouped via "ses deux collègues")', covered.join(',') || 'none');
    const emoji = /\p{Extended_Pictographic}/u.test(txt);
    check('content', '3.no-emoji-text', 'no emoji characters in rendered text (README quotes two; page must not)', !emoji, emoji ? txt.match(/\p{Extended_Pictographic}/u)[0] : 'none');
    info('content', '3.invented', 'copy that is NOT in README/prank.sh (decorative or invented; judge manually)', 'cover refblock: Réf I3N-016, Rév C, Date 25.11.2026, Pages 12; "Imprimé à EPITA, tirage 1 exemplaire"; "Éch. 1 : 1", "LARGEUR 1 : 1"; class names A/B/C and labels; "Fig. 17 / Pièce à conviction n° 1" caption; notice numbering 1.1-2.6; troubleshooting causes; every troubleshooting quip');
    await page.close();
  });

  /* ===== 4: interactions ===== */
  await G('interact', async () => {
    const R = SRC.rows; const names = R.map(r => r.name);
    const page = await openPage(browser, { w: 1280, h: 800 }); await load(page); await page.bringToFront();
    const cdp = await browser.target().createCDPSession();
    await cdp.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(e => warn('interact', '4.perm', 'clipboard permission grant failed', e.message));
    const count = () => page.$eval('#parts-count', e => e.textContent.trim());
    const rows = () => page.evaluate(PROBE.visibleRows);
    // filters
    const expCls = { A: 11, B: 4, C: 1, all: 16 };
    for (const f of ['B', 'C', 'A', 'all']) {
      await page.click(`#parts-filters button[data-f="${f}"]`);
      const vis = await rows(); const c = await count();
      const pressed = await page.$$eval('#parts-filters button', bs => bs.map(b => b.dataset.f + '=' + b.getAttribute('aria-pressed')).join(','));
      const wantN = expCls[f];
      check('interact', '4.filter-' + f, `filter ${f}: ${wantN} rows, count text, aria-pressed`, vis.length === wantN && c.startsWith(wantN + ' pièce') && pressed.includes(f + '=true') && (pressed.match(/=true/g) || []).length === 1, `visible ${vis.length}, count "${c}", ${pressed}`);
    }
    // search
    const search = async q => { await page.click('#parts-q', { clickCount: 3 }); await page.keyboard.press('Backspace'); if (q) await page.type('#parts-q', q); await sleep(60); return { vis: await rows(), c: await count(), empty: await page.$eval('#parts-empty', e => !e.hidden && getComputedStyle(e).display !== 'none' ? e.textContent.trim() : '') }; };
    const e1 = await search('ecran'), e2 = await search('Écran'), e3 = await search('ÉCRAN');
    const expE = R.filter(r => foldTxt(r.name + ' ' + r.effect).includes('ecran')).map(r => r.name);
    check('interact', '4.search-ecran', "search 'ecran' / 'Écran' / 'ÉCRAN' are equivalent and find rotate", JSON.stringify(e1.vis) === JSON.stringify(e2.vis) && JSON.stringify(e2.vis) === JSON.stringify(e3.vis) && e1.vis.includes('rotate') && expE.every(n => e1.vis.includes(n)), `ecran -> ${e1.vis.join(',')} (${e1.c}); Écran -> ${e2.vis.join(',')}; README-derived expectation ${expE.join(',')}`);
    const v = await search('vim');
    const expV = R.filter(r => foldTxt(r.name + ' ' + r.effect).includes('vim')).map(r => r.name);
    check('interact', '4.search-vim', "search 'vim' finds every README row mentioning vim", expV.every(n => v.vis.includes(n)), `got ${v.vis.join(',')} (${v.c}); expected at least ${expV.join(',')}`);
    const g = await search('zzqxj');
    check('interact', '4.search-empty', 'gibberish -> empty-state message shown, 0 rows, count says 0', g.vis.length === 0 && /Aucune pièce/.test(g.empty) && /^0 pièce/.test(g.c), `rows ${g.vis.length}, empty "${g.empty}", count "${g.c}"`);
    const g2 = await search('  rotate  ');
    check('interact', '4.search-trim', "search with surrounding spaces ('  rotate  ') still finds rotate", g2.vis.includes('rotate'), g2.vis.join(','));
    const g3 = await search('rotate'); const sg = g3.c;
    check('interact', '4.search-singular', "singular count text '1 pièce sur 16'", /^1 pièce sur 16$/.test(sg) || g3.vis.length > 1, sg + ' rows=' + g3.vis.join(','));
    await search('');
    // combined filter+search
    await page.click('#parts-filters button[data-f="B"]'); const cs = await search('vim');
    check('interact', '4.search+filter', "class B + 'vim' => swap-apps only", JSON.stringify(cs.vis) === '["swap-apps"]', cs.vis.join(','));
    await search(''); await page.click('#parts-filters button[data-f="all"]');
    // empty state announced? count live region
    const live = await page.$eval('#parts-count', e => e.getAttribute('aria-live'));
    check('interact', '4.count-live', 'result count is an aria-live region', live === 'polite', live);

    // expand/collapse each row by mouse and keyboard
    const bad = [];
    for (const n of names) {
      const sel = `#part-${n} .toggle`;
      const btn = await page.$(sel); await btn.evaluate(e => e.scrollIntoView({ block: 'center' }));
      const st = () => page.evaluate(n => ({ exp: document.querySelector(`#part-${n} .toggle`).getAttribute('aria-expanded'), vis: !document.getElementById('plate-' + n).hidden && getComputedStyle(document.getElementById('plate-' + n)).display !== 'none', plus: document.querySelector(`#part-${n} .plus`).textContent }), n);
      let s = await st(); if (s.exp !== 'false' || s.vis) bad.push(n + ' initial state wrong ' + JSON.stringify(s));
      await btn.click(); s = await st(); if (s.exp !== 'true' || !s.vis || s.plus !== '−') bad.push(n + ' mouse open ' + JSON.stringify(s));
      const fig = await page.evaluate(n => { const f = document.querySelector(`#plate-${n} svg.fig`); if (!f) return null; const lid = f.getAttribute('aria-labelledby'); return { role: f.getAttribute('role'), name: (document.getElementById(lid) || {}).textContent, kids: f.querySelectorAll('rect,line,path,circle,ellipse,text').length, w: f.getBoundingClientRect().width }; }, n);
      if (!fig || fig.role !== 'img' || !fig.name || fig.kids < 5 || fig.w < 100) bad.push(n + ' figure ' + JSON.stringify(fig));
      await btn.click(); s = await st(); if (s.exp !== 'false' || s.vis) bad.push(n + ' mouse close ' + JSON.stringify(s));
      for (const key of ['Enter', 'Space']) {
        await btn.focus(); await page.keyboard.press(key); s = await st(); if (s.exp !== 'true' || !s.vis) bad.push(`${n} ${key} open ${JSON.stringify(s)}`);
        await btn.focus(); await page.keyboard.press(key); s = await st(); if (s.exp !== 'false' || s.vis) bad.push(`${n} ${key} close ${JSON.stringify(s)}`);
      }
      // click on the row's effect text (not the button) also toggles
      const eff = await page.$(`#part-${n} .eff`); await eff.click(); s = await st(); if (s.exp !== 'true') bad.push(n + ' row-click did not open'); else await eff.click();
    }
    check('interact', '4.expand', 'each of 16 rows: closed initially; opens/closes via mouse, Enter, Space (+row click); aria-expanded and +/- toggle; plate visible/hidden; figure role=img with accessible name', bad.length === 0, bad.join('\n') || '16 rows x (mouse, Enter, Space, row click) ok');
    const ctrl = await page.evaluate(() => [...document.querySelectorAll('.toggle')].filter(b => !document.getElementById(b.getAttribute('aria-controls'))).length);
    check('interact', '4.aria-controls', 'every aria-controls points to an existing element', ctrl === 0, ctrl + ' dangling');
    // figures after opening all
    await openAll(page); await sleep(800);
    const figs = await page.evaluate(PROBE.figures);
    const figBad = figs.filter(f => f.role !== 'img' || !f.named || f.issues.length);
    check('interact', '4.figures', '16 figure SVGs present, role=img, accessible name, no text outside viewBox / text-on-text overlap', figs.length === 16 && figBad.length === 0, figBad.length ? short(figBad.map(f => f.id + ': ' + (f.issues.join('; ') || 'no name')), 1500) : `16 figures, ${figs.reduce((s, f) => s + f.shapes, 0)} shapes`);
    await page.screenshot({ path: path.join(OUT, 'interact-all-open.png') }).catch(() => {});
    // filter while rows open: plates must follow their rows
    await page.click('#parts-filters button[data-f="C"]');
    const orphan = await page.evaluate(() => [...document.querySelectorAll('tr.plate')].filter(p => !p.hidden && p.previousElementSibling.hidden).length);
    const lockOpen = await page.evaluate(() => !document.getElementById('plate-lock-shot').hidden);
    check('interact', '4.filter-open-plates', 'filtering while rows are open leaves no orphan plate; the kept row stays open', orphan === 0 && lockOpen, `orphans ${orphan}, lock-shot plate visible ${lockOpen}`);
    await page.click('#parts-filters button[data-f="all"]');
    await page.close();

    // deep links
    for (const vp of [{ w: 1280, h: 800 }, { w: 360, h: 740, mobile: true }]) {
      const dbad = [];
      for (const n of names) {
        const p = await openPage(browser, vp); await load(p, '#part-' + n);
        const s = await p.evaluate(n => { const tr = document.getElementById('part-' + n), r = tr.getBoundingClientRect(), t = document.querySelector('.tabs').getBoundingClientRect(); return { exp: tr.querySelector('.toggle').getAttribute('aria-expanded'), vis: !document.getElementById('plate-' + n).hidden, top: Math.round(r.top), bottom: Math.round(r.bottom), tabsBottom: getComputedStyle(document.querySelector('.tabs')).position === 'sticky' ? Math.round(t.bottom) : 0, vh: innerHeight }; }, n);
        if (s.exp !== 'true' || !s.vis) dbad.push(n + ' not opened ' + JSON.stringify(s)); else if (s.top < s.tabsBottom || s.top > s.vh) dbad.push(n + ' row not in view / under sticky tabs ' + JSON.stringify(s));
        if (p._log.errors.length || p._log.console.length) dbad.push(n + ' console ' + short(p._log.console.concat(p._log.errors)));
        await p.close();
      }
      check('interact', '4.deeplink.' + vpName(vp), `#part-<name> opens and scrolls to the row for all 16 names at ${vpName(vp)}`, dbad.length === 0, dbad.join('\n') || 'all 16 ok');
    }
    { const p = await openPage(browser, { w: 1280, h: 800 }); await load(p, '#part-nope'); check('interact', '4.deeplink-bad', '#part-nope is harmless', p._log.errors.length === 0 && p._log.console.length === 0, short(p._log.errors));
      await p.evaluate(() => { location.hash = '#part-rotate'; }); await sleep(300);
      const o = await p.$eval('#part-rotate .toggle', e => e.getAttribute('aria-expanded'));
      check('interact', '4.deeplink-hashchange', 'changing the hash to #part-rotate on an already loaded page (address-bar edit, back/forward, in-page link) opens the row', o === 'true', 'aria-expanded=' + o);
      await p.close(); }

    // copy buttons
    const cp1 = await openPage(browser, { w: 1280, h: 800 }); await load(cp1); await cp1.bringToFront();
    const dcdp = await browser.target().createCDPSession(); await dcdp.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => {});
    await openAll(cp1);
    const btns = await cp1.$$('[data-copy-from], [data-copy]');
    const expMap = { 'cmd-1': 'curl -fsSL https://raw.githubusercontent.com/Nath-Lmn/i3-nuke/main/prank.sh -o prank.sh && chmod +x prank.sh', 'cmd-2': './prank.sh', 'cmd-3': './prank.sh rotate', 'cmd-4': './prank.sh undo-all', 'cmd-5': './prank.sh new-terminal', 'cmd-6': './prank.sh undo-all' };
    const cbad = []; let nCopy = 0;
    for (const b of btns) {
      const meta = await b.evaluate(e => ({ from: e.dataset.copyFrom || '', copy: e.dataset.copy || '', label: e.getAttribute('aria-label'), mini: e.classList.contains('mini'), row: (e.closest('tr.part') || {}).id || '' }));
      const expected = meta.from ? expMap[meta.from] : meta.copy;
      if (meta.row) { const n = meta.row.replace('part-', ''); if (expected !== './prank.sh undo ' + n) cbad.push(n + ' antidote payload ' + expected); }
      await cp1.evaluate(() => navigator.clipboard.writeText('SENTINEL'));
      await b.evaluate(e => e.scrollIntoView({ block: 'center' }));
      const before = await b.evaluate(e => (e.closest('tr.part') || { dataset: {} }).dataset.open);
      await b.click();
      await sleep(150);
      const got = await cp1.evaluate(() => navigator.clipboard.readText()).catch(e => 'READ-ERR ' + e.message);
      const st = await b.evaluate(e => ({ t: e.textContent, s: e.dataset.state, wasOpen: !!e.closest('tr.part') && e.closest('tr.part').dataset.open }));
      const liveTxt = await cp1.$eval('#live', e => e.textContent);
      nCopy++;
      if (got !== expected) cbad.push(`${meta.label}: clipboard "${got}" != "${expected}"`);
      if (st.t !== 'Copié' || st.s !== 'done') cbad.push(`${meta.label}: feedback state ${JSON.stringify(st)}`);
      if (!/copiée/.test(liveTxt)) cbad.push(`${meta.label}: live region "${liveTxt}"`);
      if (!meta.label || !/Copier/.test(meta.label)) cbad.push('bad aria-label ' + meta.label);
      if (meta.row && st.wasOpen !== before) cbad.push(meta.label + ': clicking copy toggled the row');
    }
    check('interact', '4.copy', `${nCopy} copy buttons: clipboard equals command exactly, 'Copié' state, live-region message, row not toggled`, cbad.length === 0 && nCopy === 21, cbad.join('\n') || `${nCopy} buttons ok (6 command blocks + 15 antidotes)`);
    check('interact', '4.copy-dialogs', 'no alert()/confirm()/prompt() raised', cp1._log.dialogs.length === 0, cp1._log.dialogs.join(',') || 'none');
    // restore + fast repeated clicks
    const b1 = await cp1.$('[data-copy-from="cmd-1"]'); await b1.evaluate(e => e.scrollIntoView({ block: 'center' }));
    for (let i = 0; i < 12; i++) await b1.click({ delay: 0 });
    const mid = await b1.evaluate(e => e.textContent); await sleep(2300);
    const after = await b1.evaluate(e => ({ t: e.textContent, s: e.dataset.state }));
    const clip = await cp1.evaluate(() => navigator.clipboard.readText());
    check('interact', '4.copy-fast', '12 rapid clicks: stays consistent, label returns to "Copier", clipboard still exact, no errors', mid === 'Copié' && after.t === 'Copier' && !after.s && clip === expMap['cmd-1'] && cp1._log.errors.length === 0, `mid "${mid}", after ${JSON.stringify(after)}, errors ${cp1._log.errors.length}`);
    // clipboard failure path (API denied): fall back, announce
    await cp1.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('denied')); document.execCommand = () => false; });
    const b2 = await cp1.$('[data-copy-from="cmd-2"]'); await b2.click(); await sleep(200);
    const failLive = await cp1.$eval('#live', e => e.textContent); const sel = await cp1.evaluate(() => String(getSelection()));
    check('interact', '4.copy-fail', 'clipboard + execCommand failure: message announced, command left selected, label not stuck on Copié', /impossible/.test(failLive) && sel.trim() === './prank.sh' && (await b2.evaluate(e => e.textContent)) === 'Copier', `live "${failLive}", selection "${sel}"`);
    await cp1.close();

    // matrix hover/focus highlight
    const mp = await openPage(browser, { w: 1280, h: 800 }); await load(mp);
    await (await mp.$('.matrix')).evaluate(e => e.scrollIntoView({ block: 'center' }));
    const cell = await mp.$('.matrix tbody tr:nth-child(3) td:nth-child(7)'); await cell.hover();
    const hv = await mp.evaluate(() => ({ r: document.querySelectorAll('.hl-r').length, c: document.querySelectorAll('.hl-c').length, both: document.querySelectorAll('td.hl-r.hl-c').length }));
    check('interact', '4.matrix-hover', 'hovering a cell highlights its row (1 th + 16 td) and column (1 th + 11 td)', hv.r === 17 && hv.c === 12 && hv.both === 1, JSON.stringify(hv));
    await mp.screenshot({ path: path.join(OUT, 'matrix-hover-1280.png') });
    await mp.mouse.move(5, 5); await sleep(50);
    const cl = await mp.evaluate(() => document.querySelectorAll('.hl-r,.hl-c').length);
    check('interact', '4.matrix-unhover', 'highlight clears on mouse leave', cl === 0, cl + ' left');
    const tabstops = await mp.evaluate(() => document.querySelectorAll('.matrix [tabindex], .matrix a, .matrix button').length);
    check('interact', '4.matrix-no-tabstops', 'matrix cross-highlight is mouse-only: no tab stops inside the matrix (keyboard users are not trapped in 27 stops)', tabstops === 0, tabstops + ' focusable items');
    const promise = await mp.evaluate(() => /focalis/i.test(document.querySelector('#matrix .lead').textContent));
    check('interact', '4.matrix-copy-honest', 'matrix lead text does not promise keyboard focus highlighting', !promise, await mp.evaluate(() => document.querySelector('#matrix .lead').textContent.trim().slice(0, 160)));
    const mcol = await mp.evaluate(() => document.querySelector('.matrix th.col').getAttribute('role'));
    await mp.close();

    // tab order, focus visibility, skip link, at 3 viewports
    for (const vp of [{ w: 1280, h: 800 }, { w: 360, h: 740, mobile: true }, { w: 768, h: 1024 }]) {
      const p = await openPage(browser, vp); await load(p); await p.bringToFront();
      await p.keyboard.press('Tab'); await sleep(80);
      const first = await p.evaluate(PROBE.focusInfo); const skipTop = await p.$eval('.skip', e => Math.round(e.getBoundingClientRect().top));
      check('interact', '4.skip-visible.' + vpName(vp), 'first Tab lands on the skip link and it becomes visible', first && /Aller au contenu/.test(first.id) && skipTop >= 0, JSON.stringify(first) + ' top=' + skipTop);
      await p.screenshot({ path: path.join(OUT, `focus-skip-${vpName(vp)}.png`), clip: { x: 0, y: 0, width: vp.w, height: Math.min(120, vp.h) } });
      await p.keyboard.press('Enter'); await sleep(250);
      const hash = await p.evaluate(() => location.hash);
      await p.keyboard.press('Tab'); await sleep(80);
      const afterSkip = await p.evaluate(PROBE.focusInfo);
      check('interact', '4.skip-works.' + vpName(vp), 'skip link goes to #main and the next Tab lands inside <main>', hash === '#main' && afterSkip && afterSkip.inMain, `hash ${hash}, next focus ${afterSkip && afterSkip.id} inMain=${afterSkip && afterSkip.inMain}`);
      await p.close();
      const q = await openPage(browser, vp); await load(q); await q.bringToFront();
      const stops = []; const seen = new Set();
      for (let i = 0; i < 160; i++) {
        await q.keyboard.press('Tab'); await sleep(25);
        const f = await q.evaluate(PROBE.focusInfo); if (!f) break;
        const key = f.id + f.x + f.pageY; if (seen.has(key)) break; seen.add(key); stops.push(f);
        if (i === 40 || i === 20) await q.screenshot({ path: path.join(OUT, `focus-stop${i}-${vpName(vp)}.png`) }).catch(() => {});
      }
      const noRing = stops.filter(s => !s.outlined && !s.shadow), hidden = stops.filter(s => !s.inView), obsc = stops.filter(s => s.obscured);
      check('interact', '4.focus-visible.' + vpName(vp), `${stops.length} tab stops at ${vpName(vp)}: each shows a focus ring (outline/box-shadow)`, noRing.length === 0 && stops.length > 40, noRing.map(s => s.id).join('; ') || stops.length + ' stops');
      check('interact', '4.focus-inview.' + vpName(vp), 'each focused element is inside the viewport and not covered by another element (sticky tabs etc.)', hidden.length === 0 && obsc.length === 0, hidden.concat(obsc).map(s => s.id + ' by ' + s.obscuredBy).join('; ') || 'ok');
      const body = stops.filter(s => !s.inTabs && !/Aller au contenu/.test(s.id));
      let back = []; for (let i = 1; i < body.length; i++) if (body[i].pageY < body[i - 1].pageY - 4) back.push(`${body[i - 1].id} (y${body[i - 1].pageY}) -> ${body[i].id} (y${body[i].pageY})`);
      check('interact', '4.tab-order.' + vpName(vp), 'tab order follows the visual reading order (page y never goes backwards)', back.length === 0, back.join('\n') || 'monotonic');
      info('interact', '4.tab-summary.' + vpName(vp), 'tab stop sequence (compressed)', stops.map(s => s.id.replace(/ ".*/, '')).join(' > ').replace(/(a\.\w*? > ?)+/g, m => m).slice(0, 700));
      await q.close();
    }

    // tabs aria-current via IntersectionObserver
    for (const vp of [{ w: 1280, h: 800 }, { w: 1280, h: 600 }, { w: 1280, h: 400 }, { w: 360, h: 740, mobile: true }, { w: 768, h: 1024 }]) {
      const p = await openPage(browser, vp); await load(p);
      const mism = [];
      for (const id of ['cover', 'contents', 'safety', 'install', 'parts', 'matrix', 'recovery', 'annex', 'colophon']) {
        await p.click(`.tabs a[data-for="${id}"]`).catch(async () => { await p.$eval(`.tabs a[data-for="${id}"]`, e => e.click()); });
        await sleep(450);
        const cur = await p.evaluate(() => [...document.querySelectorAll('.tabs a[aria-current]')].map(a => a.dataset.for + '=' + a.getAttribute('aria-current')));
        if (cur.length !== 1 || cur[0] !== id + '=true') mism.push(`click ${id} -> aria-current ${cur.join(',') || 'none'}`);
      }
      check('interact', '4.aria-current.' + vpName(vp), `binder tab aria-current follows the section after clicking each tab at ${vpName(vp)}`, mism.length === 0, mism.join('\n') || 'all 9 ok');
      // scrolling case
      const cur2 = []; const H = await p.evaluate(() => document.documentElement.scrollHeight);
      for (const id of ['safety', 'parts', 'recovery']) { await p.evaluate(i => { const e = document.getElementById(i); scrollTo(0, e.getBoundingClientRect().top + scrollY + 120); }, id); await sleep(400); cur2.push(id + '->' + (await p.evaluate(() => (document.querySelector('.tabs a[aria-current]') || {}).dataset.for))); }
      info('interact', '4.aria-current-scroll.' + vpName(vp), 'aria-current after scrolling 120px into a section', cur2.join(', '));
      if (vp.w < 900) { const strip = await p.evaluate(() => { const o = document.querySelector('.tabs ol'), a = document.querySelector('.tabs a[aria-current]'); const r = a.getBoundingClientRect(), t = o.getBoundingClientRect(); return { cur: a.dataset.for, visible: r.left >= t.left - 1 && r.right <= t.right + 1 }; }); check('interact', '4.strip-scrolls-current.' + vpName(vp), 'mobile tab strip scrolls the current tab into view', strip.visible, JSON.stringify(strip)); }
      await p.close();
    }
  });

  /* ===== 5: accessibility ===== */
  await G('a11y', async () => {
    for (const vp of [{ w: 1280, h: 800 }, { w: 360, h: 740, mobile: true }]) {
      const page = await openPage(browser, vp); await load(page); await openAll(page); await sleep(800);
      if (axeSource) {
        await page.evaluate(axeSource);
        const ax = await page.evaluate(async () => { const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } }); return { v: r.violations.map(v => ({ id: v.id, impact: v.impact, n: v.nodes.length, help: v.help, sample: v.nodes.slice(0, 3).map(n => n.target.join(' ') + ' :: ' + (n.failureSummary || '').split('\n').slice(0, 2).join(' ').slice(0, 160)) })), inc: r.incomplete.map(i => i.id + '(' + i.nodes.length + ')'), passes: r.passes.length, ver: axe.version }; });
        check('a11y', '5.axe.' + vpName(vp), `axe-core ${ax.ver} (wcag2a/aa, 2.1, 2.2aa, best-practice) at ${vpName(vp)}: 0 violations`, ax.v.length === 0, ax.v.length ? ax.v.map(v => `${v.id} [${v.impact}] x${v.n}: ${v.help}\n   ${v.sample.join('\n   ')}`).join('\n') : `${ax.passes} rules passed; incomplete: ${ax.inc.join(', ') || 'none'}`);
        if (ax.v.length === 0 || true) info('a11y', '5.axe-incomplete.' + vpName(vp), 'axe "needs review" items', ax.inc.join(', ') || 'none');
      } else warn('a11y', '5.axe', 'axe-core not installed (npm install in tests/site)', '');
      const c = await page.evaluate(PROBE.contrast);
      check('a11y', '5.contrast.' + vpName(vp), `computed-style text contrast >= 4.5:1 (3:1 large) for ${c.tested} text elements at ${vpName(vp)}`, c.bad.length === 0, c.bad.length ? c.bad.map(b => `${b.el} ${b.ratio}:1 (need ${b.need}) ${b.fg} on ${b.bg} ${b.px}px/${b.w}${b.svg ? ' svg' : ''}${b.imgBg ? ' bg-image' : ''}`).join('\n') : `lowest ${c.min}:1 on ${c.minEl}`);
      await page.close();
    }
    // token-pair contrast incl. hover / current / pressed / open-row states
    const page = await openPage(browser, { w: 1280, h: 800 }); await load(page);
    const tok = await page.evaluate(() => { const cs = getComputedStyle(document.documentElement); const o = {}; ['--paper', '--desk', '--ink', '--red', '--red-deep'].forEach(k => o[k] = cs.getPropertyValue(k).trim()); return o; });
    const hex = h => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });
    const L = c => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }; return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b); };
    const cr = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
    const mix = (f, a, b) => ({ r: f.r * a + b.r * (1 - a), g: f.g * a + b.g * (1 - a), b: f.b * a + b.b * (1 - a) });
    const paper = hex(tok['--paper']), ink = hex(tok['--ink']), red = hex(tok['--red']), rd = hex(tok['--red-deep']), desk = hex(tok['--desk']);
    const redTint = mix(red, .11, paper), inkSoft = mix(ink, .76, paper), inkSoftOnTint = mix(ink, .76, redTint);
    const pairs = [['ink on paper', ink, paper, 4.5], ['ink-soft (.76) on paper', inkSoft, paper, 4.5], ['ink-soft on open-row red tint', inkSoftOnTint, redTint, 4.5], ['red-deep on paper (small text/links hover)', rd, paper, 4.5], ['paper on red-deep (aria-current, hover buttons, danger header)', paper, rd, 4.5], ['paper on ink (copy button, skip link, tabs)', paper, ink, 4.5], ['ink on red tint', ink, redTint, 4.5], ['red-deep on paper (stamp small text)', rd, paper, 4.5], ['spot red on paper (large text/graphics)', red, paper, 3], ['focus outline red on paper (non-text 3:1)', red, paper, 3], ['red-deep on red tint', rd, redTint, 4.5], ['ink-soft on desk (anything outside the sheet)', mix(ink, .76, desk), desk, 4.5]];
    const pb = pairs.filter(p => cr(p[1], p[2]) < p[3]);
    check('a11y', '5.contrast-pairs', 'token pair contrast (rest/hover/current/open-row/focus ring)', pb.length === 0, pairs.map(p => `${cr(p[1], p[2]).toFixed(2)}:1 (${p[3]}) ${p[0]}`).join('\n'));
    // structure
    const st = await page.evaluate(() => {
      const hs = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(h => !h.closest('.sr-only')).map(h => +h.tagName[1]);
      const jumps = []; for (let i = 1; i < hs.length; i++) if (hs[i] - hs[i - 1] > 1) jumps.push(hs[i - 1] + '->' + hs[i]);
      const id = {}; document.querySelectorAll('[id]').forEach(e => id[e.id] = (id[e.id] || 0) + 1);
      const lm = [...document.querySelectorAll('header,nav,main,footer,aside,section[aria-labelledby],[role]')].map(e => (e.getAttribute('role') || e.tagName.toLowerCase()) + (e.getAttribute('aria-label') ? '(' + e.getAttribute('aria-label') + ')' : '')).filter(x => !/^img/.test(x));
      const nameless = { links: [...document.querySelectorAll('a')].filter(a => !(a.textContent.trim() || a.getAttribute('aria-label'))).length, buttons: [...document.querySelectorAll('button')].filter(a => !(a.textContent.trim() || a.getAttribute('aria-label'))).length, imgs: [...document.querySelectorAll('img')].filter(i => !i.hasAttribute('alt')).length, inputs: [...document.querySelectorAll('input')].filter(i => !(i.labels && i.labels.length) && !i.getAttribute('aria-label')).length };
      const vt = b => [...b.childNodes].map(n => n.nodeType === 3 ? n.textContent : (getComputedStyle(n).display === 'none' ? '' : n.textContent)).join('').trim().toLowerCase(); const dupLabelMismatch = [...document.querySelectorAll('button[aria-label],a[aria-label]')].filter(b => vt(b) && !b.getAttribute('aria-label').toLowerCase().includes(vt(b))).map(b => '"' + vt(b) + '" vs aria-label "' + b.getAttribute('aria-label') + '"');
      return { lang: document.documentElement.lang, title: document.title, h1: document.querySelectorAll('h1').length, hs: hs.join(''), jumps, dups: Object.keys(id).filter(k => id[k] > 1), lm, nameless, dupLabelMismatch, viewport: document.querySelector('meta[name=viewport]').content, zoomBlocked: /user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?(\D|$)/.test(document.querySelector('meta[name=viewport]').content), tabindexPos: document.querySelectorAll('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])').length, mainCount: document.querySelectorAll('main').length, liveRegions: document.querySelectorAll('[aria-live],[role=status]').length };
    });
    check('a11y', '5.lang-title', "html lang='fr', non-empty title, one h1, one <main>", st.lang === 'fr' && st.title.length > 5 && st.h1 === 1 && st.mainCount === 1, `lang=${st.lang}, title="${st.title}", h1=${st.h1}, main=${st.mainCount}`);
    check('a11y', '5.headings', 'heading levels never skip downward (h1>h2>h3)', st.jumps.length === 0, `sequence ${st.hs}; jumps ${st.jumps.join(',') || 'none'}`);
    check('a11y', '5.ids', 'no duplicate ids in the rendered DOM', st.dups.length === 0, st.dups.join(',') || 'none');
    check('a11y', '5.names', 'all links/buttons/inputs have names; every <img> has alt', Object.values(st.nameless).every(v => v === 0), JSON.stringify(st.nameless));
    check('a11y', '5.label-in-name', 'aria-label contains the visible text (WCAG 2.5.3 label-in-name)', st.dupLabelMismatch.length === 0, st.dupLabelMismatch.length + ' mismatches: ' + st.dupLabelMismatch.join('; '));
    check('a11y', '5.zoom', 'viewport meta does not block zoom', !st.zoomBlocked, st.viewport);
    check('a11y', '5.tabindex', 'no positive tabindex', st.tabindexPos === 0, String(st.tabindexPos));
    info('a11y', '5.landmarks', 'landmarks/roles in page', st.lm.join(', '));
    const tgt = await page.evaluate(() => { const bad = []; for (const e of document.querySelectorAll('a[href],button,input,[tabindex="0"]')) { if (e.closest('.sr-only,.skip,.tabs,[hidden],.matrix')) continue; const r = e.getBoundingClientRect(); if (r.width && (r.width < 24 || r.height < 24) && getComputedStyle(e).display !== 'inline') bad.push(e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0] + ' "' + (e.textContent || '').trim().slice(0, 15) + '" ' + Math.round(r.width) + 'x' + Math.round(r.height)); } return bad.slice(0, 12); });
    (tgt.length ? warn : pass)('a11y', '5.target-size', 'pointer targets < 24x24 CSS px (WCAG 2.2 AA 2.5.8; WARN only because the spacing exception applies and axe 4.10 target-size reports 0 violations; excludes inline links, tabs, matrix)', tgt.join('; ') || 'ok');
    await page.close();
  });

  /* ===== 6: motion + print ===== */
  await G('motion', async () => {
    const p1 = await openPage(browser, { w: 1280, h: 800, reduced: true }); await load(p1); await openAll(p1); await sleep(100);
    const a1 = await p1.evaluate(PROBE.anims);
    check('motion', '6.reduced', 'prefers-reduced-motion: reduce => no running animation/transition, no animation-name on stamp or plates', a1.running.length === 0 && a1.css.length === 0 && a1.stampAnim === 'none', JSON.stringify(a1));
    await p1.evaluate(() => scrollTo(0, 3000)); await sleep(300);
    const a1b = await p1.evaluate(PROBE.anims);
    check('motion', '6.reduced-scroll', 'still none after scrolling (tabs transitions)', a1b.running.length === 0 && a1b.css.length === 0, JSON.stringify(a1b));
    const sb = await p1.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior);
    check('motion', '6.scroll-behavior', 'no smooth scrolling under reduced motion', sb !== 'smooth', sb);
    await p1.close();
    const p2 = await openPage(browser, { w: 1280, h: 800 }); await load(p2);
    const a2 = await p2.evaluate(() => getComputedStyle(document.querySelector('.stamp svg')).animationName);
    check('motion', '6.control', 'control: without the preference the stamp animation is defined (proves the probe can detect motion)', a2 === 'thunk', a2);
    await p2.close();
    // print
    const pp = await openPage(browser, { w: 794, h: 1123 }); await load(pp); await openAll(pp);
    await pp.emulateMediaType('print'); await sleep(300);
    const pr = await pp.evaluate(() => { const hid = s => [...document.querySelectorAll(s)].every(e => getComputedStyle(e).display === 'none'); const de = document.documentElement; return { tabsHidden: hid('.tabs'), copyHidden: hid('.copy'), toolsHidden: hid('.tools'), cropHidden: hid('.crop'), scrollW: de.scrollWidth, cw: de.clientWidth, bg: getComputedStyle(document.body).backgroundColor, linkSuffix: getComputedStyle(document.querySelector('a[href^=http]'), '::after').content.slice(0, 40), plates: [...document.querySelectorAll('tr.plate')].filter(p => !p.hidden).length }; });
    check('motion', '6.print-dom', 'print media: binder tabs, copy buttons, search/filter tools hidden; no horizontal overflow; white background', pr.tabsHidden && pr.copyHidden && pr.toolsHidden && pr.scrollW <= pr.cw && /255, 255, 255/.test(pr.bg), JSON.stringify(pr));
    const ov = await pp.evaluate(PROBE.overflow);
    check('motion', '6.print-overflow', 'print layout: nothing past the right edge, no text escaping boxes', ov.off.length === 0 && ov.txt.length === 0, short({ off: ov.off, txt: ov.txt }));
    await pp.screenshot({ path: path.join(OUT, 'print-media-top.png') });
    await pp.screenshot({ path: path.join(OUT, 'print-media-full.png'), fullPage: true }).catch(() => {});
    const pdfPath = path.join(OUT, 'print.pdf');
    await pp.pdf({ path: pdfPath, preferCSSPageSize: true, printBackground: true });
    const buf = fs.readFileSync(pdfPath).toString('latin1'); const pages = (buf.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
    let pdfText = '';
    try { pdfText = cp.execFileSync('python', ['-I', '-X', 'utf8', '-c', 'import sys\nfrom pypdf import PdfReader\nr=PdfReader(sys.argv[1])\nprint("\\f".join((p.extract_text() or "") for p in r.pages))', pdfPath], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }); } catch (e) { pdfText = ''; }
    if (pdfText) {
      const norm = s => s.replace(/\s+/g, ' ').toLowerCase();
      const t = norm(pdfText);
      const needles = ['unité de', 'consignes de sécurité', 'mise en service', 'nomenclature des modules', 'matrice des dépendances', 'retour à la normale', 'pièce à conviction', 'bon confloose, avec modération', ...SRC.rows.map(r => r.name)];
      const miss = needles.filter(n => !t.includes(n.toLowerCase()));
      check('motion', '6.print-pdf', `A4 PDF has ${pages} pages and contains every heading, all 16 prank names, and the last line of the colophon (nothing cut off)`, miss.length === 0 && pages >= 6, `pages ${pages}; missing: ${miss.join(',') || 'none'}; text length ${pdfText.length}`);
      const urlLeak = /raw\.githubusercontent|github\.com\/Nath-Lmn/.test(pdfText);
      info('motion', '6.print-urls', 'link URLs printed after links', String(urlLeak));
    } else warn('motion', '6.print-pdf', `PDF generated (${pages} pages) but python/pypdf unavailable for text check`, pdfPath);
    await pp.close();
  });

  /* ===== 7: robustness ===== */
  await G('robust', async () => {
    // resize with a row open
    const p = await openPage(browser, { w: 1280, h: 800 }); await load(p);
    await p.click('#part-rotate .toggle'); await p.click('#part-lock-shot .toggle');
    const seq = [[900, 700], [768, 1024], [719, 900], [360, 740], [320, 640], [640, 800], [1000, 700], [1280, 800]]; const rb = [];
    for (const [w, h] of seq) {
      await p.setViewport({ width: w, height: h }); await sleep(250);
      const s = await p.evaluate(() => ({ open: ['rotate', 'lock-shot'].map(n => document.querySelector(`#part-${n} .toggle`).getAttribute('aria-expanded') + '/' + (!document.getElementById('plate-' + n).hidden)), figW: Math.round(document.querySelector('#plate-rotate svg.fig').getBoundingClientRect().width), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, tabs: getComputedStyle(document.querySelector('.tabs')).position, matrix: getComputedStyle(document.querySelector('.matrix-wrap')).display }));
      if (s.open.join() !== 'true/true,true/true' || s.sw > s.cw || s.figW < 100) rb.push(`${w}x${h}: ${JSON.stringify(s)}`);
      const ov = await p.evaluate(PROBE.overflow); if (ov.off.length || ov.txt.length) rb.push(`${w}x${h} overflow ${short({ off: ov.off, txt: ov.txt }, 300)}`);
    }
    check('robust', '7.resize', 'resizing 1280>900>768>719>360>320>640>1000>1280 with two rows open keeps them open, no overflow, figures sized', rb.length === 0, rb.join('\n') || seq.map(s => s.join('x')).join(' > ') + ' ok');
    check('robust', '7.resize-errors', 'no console errors during resizing', p._log.errors.length + p._log.console.length === 0, short(p._log.console.concat(p._log.errors)));
    await p.close();
    // JS disabled
    for (const vp of [{ w: 1280, h: 800 }, { w: 360, h: 740, mobile: true }]) {
      const q = await openPage(browser, { ...vp, js: false }); await load(q);
      const s = await q.evaluate(() => { const vis = e => !!e && getComputedStyle(e).display !== 'none'; return { text: document.body.innerText.length, partsFallback: document.getElementById('parts-body').innerText.slice(0, 80), partsRows: document.querySelectorAll('tr.part').length, matrixEmpty: document.getElementById('matrix-wrap').children.length === 0, depsList: document.querySelectorAll('.deps tbody tr').length, trouble: document.querySelectorAll('.trouble tbody tr').length, copyBtns: [...document.querySelectorAll('.copy')].filter(vis).length, filters: [...document.querySelectorAll('#parts-filters button')].filter(vis).length, search: vis(document.getElementById('parts-q')), countText: vis(document.getElementById('parts-count')) ? document.getElementById('parts-count').textContent : '', cmdBlocks: document.querySelectorAll('[id^=cmd-]').length, aria: document.querySelectorAll('[aria-current]').length, h1: !!document.querySelector('h1'), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, imgOk: document.querySelector('.xerox img').complete, noscript: document.querySelectorAll('noscript').length }; });
      info('robust', '7.nojs.' + vpName(vp), 'JS disabled: what is present', JSON.stringify(s));
      check('robust', '7.nojs-readable.' + vpName(vp), 'JS disabled: page text, h1, install commands, troubleshooting table, deps list, annex image present; no horizontal overflow', s.text > 3000 && s.h1 && s.cmdBlocks === 6 && s.trouble >= 12 && s.depsList === 6 && s.imgOk && s.sw <= s.cw, JSON.stringify({ text: s.text, cmd: s.cmdBlocks, trouble: s.trouble, deps: s.depsList, sw: s.sw, cw: s.cw }));
      const degraded = [];
      if (s.partsRows === 0) degraded.push('parts table (16 pranks + figures + antidotes) replaced by a one-line fallback linking to the README');
      if (s.matrixEmpty) degraded.push('dependency matrix absent (the alternative list remains)');
      if (s.search || s.filters) degraded.push(`dead controls shown without JS: search input, ${s.filters} filter buttons, ${s.copyBtns} copy buttons`);
      if (/16 pièces sur 16/.test(s.countText)) degraded.push('static count text claims "16 pièces sur 16" while no rows are listed');
      if (!s.aria) degraded.push('no aria-current on tabs');
      if (!s.noscript) degraded.push('no <noscript> message');
      (degraded.length ? warn : pass)('robust', '7.nojs-degrades.' + vpName(vp), 'JS disabled: degradations', degraded.join('\n') || 'none');
      await q.screenshot({ path: path.join(OUT, `nojs-${vpName(vp)}-top.png`) });
      const par = await q.$('#parts'); await par.screenshot({ path: path.join(OUT, `nojs-${vpName(vp)}-parts.png`) }).catch(() => {});
      await q.close();
    }
    // 320, zoom 200% / 400%
    for (const [w, h, d, label] of [[320, 640, 1, '320px'], [640, 400, 2, '200% zoom at 1280x800 (640x400 CSS px)'], [320, 256, 4, '400% zoom at 1280x1024 (320x256 CSS px)'], [960, 540, 2, '200% zoom at 1920x1080 (960x540 CSS px)']]) {
      const q = await openPage(browser, { w, h, dsf: d }); await load(q); await openAll(q); await sleep(800);
      const o = await q.evaluate(PROBE.overflow);
      check('robust', `7.zoom-${w}x${h}`, `${label}: no horizontal scroll, no overflowing/escaping text`, o.scrollW <= o.vw && o.off.length === 0 && o.txt.length === 0, `scrollW ${o.scrollW}/${o.vw} ` + short({ off: o.off, txt: o.txt }, 600));
      if (w >= 900) { const t = await q.evaluate(PROBE.tabs); check('robust', `7.zoom-tabs-${w}x${h}`, `${label}: right-edge tabs all visible`, !t.clipped, `hidden ${t.clippedLinks}/${t.n} scrolls ${t.scrolls}`); }
      await q.screenshot({ path: path.join(OUT, `zoom-${w}x${h}.png`) });
      await q.close();
    }
    // offline fonts
    for (const vp of [{ w: 1280, h: 800 }, { w: 360, h: 740, mobile: true }]) {
      const q = await openPage(browser, { ...vp, blockFonts: true }); await load(q); await openAll(q); await sleep(700);
      const o = await q.evaluate(PROBE.overflow);
      const f = await q.evaluate(() => ({ plex: [...document.fonts].filter(x => x.status === 'loaded').length, mono: getComputedStyle(document.querySelector('code')).fontFamily.slice(0, 80) }));
      check('robust', '7.nofonts.' + vpName(vp), `fonts.googleapis.com blocked at ${vpName(vp)}: still no overflow, text not escaping boxes`, o.scrollW <= o.vw && o.off.length === 0 && o.txt.length === 0, `loaded webfonts ${f.plex}; scrollW ${o.scrollW}/${o.vw} ` + short({ off: o.off, txt: o.txt }, 500));
      const L = q._log; const nonFont = L.console.filter(m => !/fonts\.(googleapis|gstatic)|ERR_BLOCKED_BY_CLIENT/.test(m));
      check('robust', '7.nofonts-console.' + vpName(vp), 'blocked fonts produce no other console errors', L.errors.length === 0 && nonFont.length === 0, short(L.console.concat(L.errors)));
      const c = await q.evaluate(PROBE.contrast);
      const bq = await openPage(browser, vp); await load(bq); await openAll(bq); const base = await bq.evaluate(PROBE.contrast); await bq.close();
      check('robust', '7.nofonts-contrast.' + vpName(vp), 'no NEW contrast failures without webfonts (compared with the same page with fonts)', c.bad.length <= base.bad.length, `without fonts ${c.bad.length} failing elements, with fonts ${base.bad.length}`);
      const t = vp.w >= 900 ? await q.evaluate(PROBE.tabs) : null; if (t) check('robust', '7.nofonts-tabs', 'tabs all visible with fallback fonts', !t.clipped, JSON.stringify(t));
      await q.screenshot({ path: path.join(OUT, `nofonts-${vpName(vp)}-top.png`) });
      const pe = await q.$('#parts'); await pe.screenshot({ path: path.join(OUT, `nofonts-${vpName(vp)}-parts-open.png`) }).catch(() => {});
      const me = await q.$('#matrix'); await me.screenshot({ path: path.join(OUT, `nofonts-${vpName(vp)}-matrix.png`) }).catch(() => {});
      await q.close();
    }
    // image
    const q = await openPage(browser, { w: 1280, h: 800 }); await load(q);
    await (await q.$('#annex')).evaluate(e => e.scrollIntoView()); await sleep(800);
    const im = await q.evaluate(() => { const i = document.querySelector('.xerox img'); return { ok: i.complete && i.naturalWidth > 0, nw: i.naturalWidth, nh: i.naturalHeight, w: i.getAttribute('width'), h: i.getAttribute('height'), alt: i.alt.length, src: i.getAttribute('src'), lazy: i.loading }; });
    check('robust', '7.image', 'Annex image loads, declared width/height equal natural size, alt text present', im.ok && String(im.nw) === im.w && String(im.nh) === im.h && im.alt > 20, JSON.stringify(im));
    const sz = fs.statSync(path.join(ROOT, 'image github.png')).size;
    (sz > 1500000 ? warn : pass)('robust', '7.image-weight', 'annex image weight', `${(sz / 1048576).toFixed(2)} MiB PNG, loading=${im.lazy}`);
    await q.close();
  });

  /* ===== 8: HTML validity ===== */
  await G('html', async () => {
    const src = fs.readFileSync(INDEX, 'utf8');
    const ids = {}; [...src.matchAll(/\sid="([^"]+)"/g)].forEach(m => ids[m[1]] = (ids[m[1]] || 0) + 1);
    const dups = Object.keys(ids).filter(k => ids[k] > 1);
    check('html', '8.static-dup-ids', 'no duplicate ids in static source', dups.length === 0, dups.join(',') || Object.keys(ids).length + ' unique ids');
    const hasBom = src.charCodeAt(0) === 0xFEFF; check('html', '8.encoding', 'UTF-8, no BOM, <meta charset> first 1 KB, doctype', !hasBom && /^<!doctype html>/i.test(src) && src.slice(0, 1024).includes('charset'), '');
    if (!HtmlValidate) { warn('html', '8.validator', 'html-validate not installed (npm install in tests/site)', ''); return; }
    const STYLE_ONLY = new Set(['no-inline-style', 'void-style', 'attribute-boolean-style', 'no-trailing-whitespace', 'doctype-style', 'attribute-empty-style', 'long-title', 'tel-non-breaking', 'no-implicit-close', 'prefer-native-element']);
    const hv = new HtmlValidate({ extends: ['html-validate:recommended'] });
    const run = async (label, html) => {
      const rep = await hv.validateString(html);
      const msgs = rep.results.flatMap(r => r.messages);
      const hard = msgs.filter(m => !STYLE_ONLY.has(m.ruleId)), soft = msgs.filter(m => STYLE_ONLY.has(m.ruleId));
      { const by = {}; hard.forEach(m => by[m.ruleId] = (by[m.ruleId] || 0) + 1); if (hard.length) info('html', '8.rules-' + label, 'blocking findings by rule', JSON.stringify(by)); }
      check('html', '8.validate-' + label, `html-validate (recommended preset) on ${label}: no structural/ARIA/nesting errors`, hard.length === 0, hard.length ? hard.slice(0, 15).map(m => `${m.ruleId} L${m.line}:${m.column} ${m.message}`).join('\n') : 'clean');
      if (soft.length) { const by = {}; soft.forEach(m => by[m.ruleId] = (by[m.ruleId] || 0) + 1); warn('html', '8.style-' + label, 'style-only html-validate findings (not failing)', JSON.stringify(by)); }
    };
    await run('static source', src);
    const page = await openPage(browser, { w: 1280, h: 800 }); await load(page); await openAll(page);
    const dom = await page.evaluate(() => '<!doctype html>\n' + document.documentElement.outerHTML);
    await run('rendered DOM (all rows expanded)', dom);
    const rel = await page.evaluate(() => { const bad = []; document.querySelectorAll('[aria-labelledby],[aria-controls],[aria-describedby],[for],use[href^="#"]').forEach(e => { ['aria-labelledby', 'aria-controls', 'aria-describedby', 'for'].forEach(a => { const v = e.getAttribute(a); if (v) v.split(/\s+/).forEach(id => { if (!document.getElementById(id)) bad.push(a + '=' + id); }); }); if (e.tagName.toLowerCase() === 'use' && !document.getElementById(e.getAttribute('href').slice(1))) bad.push('use ' + e.getAttribute('href')); }); const urls = [...document.querySelectorAll('[style*="url(#"], .fig *')].length; return bad; });
    check('html', '8.refs', 'all aria-labelledby/controls/for/use references resolve', rel.length === 0, rel.join(',') || 'ok');
    const mk = await page.evaluate(() => ['m-arrow', 'm-arrow-r', 'hatch', 'rough', 'plan-hatch'].filter(i => !document.getElementById(i)));
    check('html', '8.svg-defs', 'SVG marker/pattern/filter ids used by CSS exist', mk.length === 0, mk.join(',') || 'ok');
    await page.close();
  });

  /* ===== 9: design slop ===== */
  await G('design', async () => {
    const page = await openPage(browser, { w: 1280, h: 800 }); await load(page); await openAll(page); await sleep(800);
    const d = await page.evaluate(() => {
      const out = { gradients: {}, shadows: [], radius: [], backdrop: [], textShadow: [], colors: {}, fonts: {}, emoji: [], lorem: /lorem ipsum/i.test(document.body.innerText), pseudo: [] };
      const rgbToHsl = (r, g, b) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; const dd = mx - mn; const s = dd === 0 ? 0 : dd / (1 - Math.abs(2 * l - 1)); let h = 0; if (dd) { if (mx === r) h = ((g - b) / dd) % 6; else if (mx === g) h = (b - r) / dd + 2; else h = (r - g) / dd + 4; } h = (h * 60 + 360) % 360; return [h, s, l]; };
      for (const el of document.querySelectorAll('body *')) {
        for (const ps of [null, '::before', '::after']) {
          const cs = getComputedStyle(el, ps); if (ps && (cs.content === 'none' || cs.content === 'normal')) continue;
          const tag = el.tagName.toLowerCase() + '.' + String(el.className && el.className.baseVal === undefined ? el.className : '').split(' ')[0] + (ps || '');
          const bi = cs.backgroundImage; if (bi !== 'none' && /gradient/.test(bi)) { const layers = bi.match(/(repeating-)?(linear|radial|conic)-gradient\((?:[^()]|\([^()]*\))*\)/g) || []; layers.forEach(Lr => { const cols = new Set(Lr.match(/rgba?\([^)]*\)/g) || []); const kk = Lr.match(/(repeating-)?(linear|radial|conic)-gradient/)[0]; if (kk.startsWith('repeating') || cols.size > 1) { const k = kk + (cols.size <= 1 ? '' : ''); out.gradients[(cols.size > 1 && !kk.startsWith('repeating') ? 'SMOOTH ' : '') + k + ' ' + tag] = 1; } else { out.flat = (out.flat || []).concat(kk + ' (single colour, flat) ' + tag); } }); }
          if (cs.boxShadow !== 'none') out.shadows.push(tag + ' ' + cs.boxShadow.slice(0, 40));
          if (cs.textShadow !== 'none') out.textShadow.push(tag);
          if (cs.backdropFilter && cs.backdropFilter !== 'none') out.backdrop.push(tag);
          if (!el.closest('svg')) { const r = parseFloat(cs.borderTopLeftRadius); if (r > 0) out.radius.push(tag + ' ' + cs.borderTopLeftRadius); }
          if (!ps) { [cs.color, cs.backgroundColor, cs.borderTopColor].forEach(c => { const m = c.match(/rgba?\(([^)]+)\)/); if (m) { const p = m[1].split(/[ ,\/]+/).map(Number); if (p.length > 3 && p[3] === 0) return; const k = `#${p.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('')}`; out.colors[k] = (out.colors[k] || 0) + 1; } }); const ff = cs.fontFamily.split(',')[0].replace(/"/g, ''); out.fonts[ff] = (out.fonts[ff] || 0) + 1; }
        }
      }
      out.neon = Object.keys(out.colors).filter(k => { const [r, g, b] = [1, 3, 5].map(i => parseInt(k.slice(i, i + 2), 16)); const [h, s, l] = rgbToHsl(r, g, b); return s > .85 && l > .4 && l < .7; });
      const hues = Object.keys(out.colors).map(k => { const [r, g, b] = [1, 3, 5].map(i => parseInt(k.slice(i, i + 2), 16)); const [h, s, l] = rgbToHsl(r, g, b); return { k, h: Math.round(h), s: +s.toFixed(2), l: +l.toFixed(2), n: out.colors[k] }; }).filter(x => x.s > .12);
      out.chromatic = hues; return out;
    });
    const grad = Object.keys(d.gradients);
    info('design', '9.gradients', 'CSS gradients in use (hazard stripes / halftone / punch holes are structural, soft colour gradients are not)', grad.join('\n'));
    const soft = grad.filter(g => /^SMOOTH/.test(g) && !/xerox|sheet/.test(g)).concat(grad.filter(g => /^(linear|radial)-gradient/.test(g) && !/xerox|sheet/.test(g)));
    check('design', '9.no-soft-gradients', 'no smooth decorative gradients on elements (hero/button/card)', soft.length === 0, soft.join('\n') || 'only repeating hazard stripes + punch-hole / halftone dots');
    check('design', '9.shadows', 'no box-shadow / text-shadow / backdrop-filter (no glass, no soft shadow cards)', d.shadows.length === 0 && d.textShadow.length === 0 && d.backdrop.length === 0, short({ shadows: d.shadows, text: d.textShadow, backdrop: d.backdrop }));
    const rr = d.radius.filter(r => !/\.legend|\.ltr|\.cl/.test(r));
    check('design', '9.rounded', 'no rounded cards/buttons (radius only on deliberate round legend badges / SVG)', rr.length === 0, rr.slice(0, 10).join('\n') || ('radius only on: ' + [...new Set(d.radius)].join(', ')));
    check('design', '9.no-neon', 'no neon (highly saturated mid-lightness) colours', d.neon.length === 0, d.neon.join(',') || 'none');
    check('design', '9.no-lorem', 'no lorem ipsum', !d.lorem, '');
    info('design', '9.palette', 'chromatic colours used (hue/sat/light)', d.chromatic.map(c => `${c.k} h${c.h} s${c.s} l${c.l} x${c.n}`).join('\n'));
    const hueSet = [...new Set(d.chromatic.filter(c => c.s > .3 && c.l < .8).map(c => Math.round(c.h / 20) * 20))];
    check('design', '9.red-only', 'accent palette is one hue family (red) on neutral paper', hueSet.every(h => h <= 30 || h >= 340), 'hue buckets: ' + hueSet.join(','));
    info('design', '9.fonts', 'first font family used per element', JSON.stringify(d.fonts));
    const scan = await page.evaluate(() => ({ scanlines: [...document.querySelectorAll('*')].filter(e => ['::before', '::after'].some(p => /repeating-linear-gradient\((0deg|180deg|90deg)/.test(getComputedStyle(e, p).backgroundImage))).length, keyframes: [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch (e) { return []; } }).filter(r => r.type === 7).map(r => r.name) }));
    check('design', '9.no-scanlines', 'no horizontal/vertical repeating line overlays (scanlines)', scan.scanlines === 0, JSON.stringify(scan));
    await page.close();
  });

  /* ===== 10: regression sweep for the fixes (hash links, caption wrap, stamp, matrix a11y, no-JS, nits) ===== */
  await G('regress', async () => {
    // --- hashchange with active filter / search
    {
      const p = await openPage(browser, { w: 1280, h: 800 }); await load(p);
      await p.click('#parts-filters button[data-f="B"]'); await p.type('#parts-q', 'swap');
      const before = await p.evaluate(PROBE.visibleRows);
      await p.evaluate(() => { location.hash = '#part-rotate'; }); await sleep(300);
      const st = await p.evaluate(() => { const tr = document.getElementById('part-rotate'); const r = tr.getBoundingClientRect(); return { vis: !tr.hidden, exp: tr.querySelector('.toggle').getAttribute('aria-expanded'), plate: !document.getElementById('plate-rotate').hidden, top: Math.round(r.top), vh: innerHeight, pressed: [...document.querySelectorAll('#parts-filters button')].map(b => b.dataset.f + '=' + b.getAttribute('aria-pressed')).join(','), q: document.getElementById('parts-q').value, count: document.getElementById('parts-count').textContent, rows: [...document.querySelectorAll('tr.part')].filter(t => !t.hidden).length }; });
      check('regress', '10.hash-filtered', 'hashchange to a row hidden by class filter B + search "swap": row is revealed, opened, scrolled into view, filter UI and count consistent', st.vis && st.exp === 'true' && st.plate && st.top >= 0 && st.top < st.vh && st.rows >= 1 && (st.pressed.includes('all=true') ? st.rows === 16 || st.q !== '' : true), `before: ${before.join(',')}; after ${JSON.stringify(st)}`);
      await p.evaluate(() => { location.hash = '#part-dvorak'; }); await sleep(250);
      await p.evaluate(() => history.back()); await sleep(300);
      const back = await p.evaluate(() => ({ h: location.hash, rot: document.querySelector('#part-rotate .toggle').getAttribute('aria-expanded'), dv: document.querySelector('#part-dvorak .toggle').getAttribute('aria-expanded') }));
      check('regress', '10.hash-history', 'back/forward between #part-dvorak and #part-rotate keeps both rows open, no error', back.h === '#part-rotate' && back.rot === 'true' && back.dv === 'true' && p._log.errors.length === 0, JSON.stringify(back) + ' errors ' + p._log.errors.length);
      await p.type('#parts-q', 'zzzz');
      await p.evaluate(() => { location.hash = '#part-oneko'; }); await sleep(250);
      const e2 = await p.evaluate(() => ({ vis: !document.getElementById('part-oneko').hidden, empty: !document.getElementById('parts-empty').hidden, q: document.getElementById('parts-q').value }));
      check('regress', '10.hash-empty-search', 'hashchange while the search is in empty-state still reveals the row and hides the empty message', e2.vis && !e2.empty, JSON.stringify(e2));
      await p.evaluate(() => { location.hash = '#part-nope'; }); await sleep(150);
      check('regress', '10.hash-unknown', 'unknown #part-x hash raises no error', p._log.errors.length === 0 && p._log.console.length === 0, short(p._log.errors));
      await p.close();
    }
    // --- caption code wrap
    for (const [w, h] of [[900, 700], [960, 540], [1000, 700], [1100, 700], [1280, 800], [1440, 900]]) {
      const p = await openPage(browser, { w, h }); await load(p, '#part-swap-apps'); await sleep(900);
      const r = await p.evaluate(() => {
        const cap = document.querySelector('#plate-swap-apps .plate-cap'), cr = cap.getBoundingClientRect();
        let textRight = 0; cap.querySelectorAll('code,p,b').forEach(e => { const rg = document.createRange(); rg.selectNodeContents(e); for (const q of rg.getClientRects()) textRight = Math.max(textRight, q.right); });
        const code = cap.querySelector('code');
        return { sw: cap.scrollWidth, cw: cap.clientWidth, capW: Math.round(cr.width), wrap: getComputedStyle(code).whiteSpace + '/' + getComputedStyle(code).overflowWrap, textRight: Math.round(textRight), capRight: Math.round(cr.right) };
      });
      check('regress', `10.caption.${w}x${h}`, `Fig. 2 caption: SWAP_APPS code wraps inside the caption column (nothing reaches the divider) at ${w}x${h}`, r.sw <= r.cw + 1 && r.textRight <= r.capRight - 8, JSON.stringify(r));
      if (w === 1000) await p.screenshot({ path: path.join(OUT, 'caption-1000.png') });
      await p.close();
    }
    // --- stamp
    for (const vp of [{ w: 1280, h: 800 }, { w: 768, h: 1024 }, { w: 360, h: 740 }, { w: 320, h: 640 }]) {
      const p = await openPage(browser, vp); await load(p); await sleep(900);
      const st = await p.evaluate(() => {
        const svg = document.querySelector('.stamp svg'), sr = svg.getBoundingClientRect(), sc = sr.width / 300;
        const texts = [...svg.querySelectorAll('text')].map(t => ({ s: t.textContent, px: +(parseFloat(getComputedStyle(t).fontSize) * sc).toFixed(1) }));
        const back = svg.querySelector('rect:not([fill="none"])'); const inv = back.getScreenCTM().inverse();
        const bx = +back.getAttribute('x'), by = +back.getAttribute('y'), bw = +back.getAttribute('width'), bh = +back.getAttribute('height');
        const covered = pt => { const q = new DOMPoint(pt.x, pt.y).matrixTransform(inv); return q.x >= bx && q.x <= bx + bw && q.y >= by && q.y <= by + bh; };
        const plan = document.querySelector('svg.plan'); const hid = {};
        plan.querySelectorAll('path,line,circle,rect,text').forEach(el => {
          if (el.closest('defs,pattern')) return; let n = 0, tot = 0; const m = el.getScreenCTM();
          if (el.tagName === 'text') { const b = el.getBBox(); [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height], [b.x + b.width / 2, b.y + b.height / 2]].forEach(([x, y]) => { tot++; if (covered(new DOMPoint(x, y).matrixTransform(m))) n++; }); }
          else if (el.getTotalLength) { const L = el.getTotalLength(); for (let t = 0; t <= L; t += Math.max(2, L / 60)) { tot++; if (covered(el.getPointAtLength(t).matrixTransform(m))) n++; } }
          if (n) { const label = el.tagName === 'text' ? 'text "' + el.textContent + '"' : el.tagName + '.' + (el.getAttribute('class') || '-').replace(/\s+/g, '.') + ' ' + (el.getAttribute('d') || (el.getAttribute('cx') + ',' + el.getAttribute('cy'))).slice(0, 24); hid[label] = Math.round(100 * n / tot) + '%'; }
        });
        return { w: Math.round(sr.width), scale: +sc.toFixed(2), texts, hid };
      });
      const c = await p.evaluate(PROBE.contrast); const sb = c.bad.filter(b => /CONTR|ANSE LEV|VERROU/.test(b.el));
      check('regress', `10.stamp-contrast.${vpName(vp)}`, `stamp text contrast >= 4.5:1 small / 3:1 large at ${vpName(vp)}`, sb.length === 0, sb.map(b => b.el + ' ' + b.ratio).join('; ') || `${c.tested} text elements, none failing; lowest ${c.min}:1`);
      const minPx = Math.min(...st.texts.map(t => t.px));
      (vp.w >= 360 ? check : (g, i, n, ok, ev) => (ok ? pass : warn)(g, i, n + ' (WARN only: 320 px is below the 360 px minimum of the brief)', ev))('regress', `10.stamp-legible.${vpName(vp)}`, `smallest stamp text renders >= 9 px at ${vpName(vp)}`, minPx >= 9, st.texts.map(t => `"${t.s}" ${t.px}px`).join(', ') + ` (stamp ${st.w}px wide)`);
      const keyHidden = Object.keys(st.hid).filter(k => /text "(A|B|C|JEU|LARGEUR)/.test(k) || /circle\.cb/.test(k));
      check('regress', `10.stamp-hides-callouts.${vpName(vp)}`, `stamp does not hide callout circles/labels A B C, "JEU" or "LARGEUR" at ${vpName(vp)}`, keyHidden.length === 0, keyHidden.join('; ') || 'none');
      info('regress', `10.stamp-covers.${vpName(vp)}`, 'plan elements under the stamp backing (opaque, so nothing crosses the stamp text)', JSON.stringify(st.hid));
      if (vp.w === 360 || vp.w === 1280) { const f = await p.$('.drawing'); await f.screenshot({ path: path.join(OUT, `stamp-${vpName(vp)}.png`) }); }
      await p.close();
    }
    // --- matrix accessibility tree
    {
      const p = await openPage(browser, { w: 1280, h: 800 }); await load(p);
      const th = await p.evaluate(() => { const t = document.querySelector('.matrix'); return { thNoScope: [...t.querySelectorAll('th')].filter(x => !x.getAttribute('scope')).length, colScopes: [...t.querySelectorAll('thead th')].map(x => x.getAttribute('scope')).join(','), rowScopes: [...t.querySelectorAll('tbody th')].map(x => x.getAttribute('scope')).join(','), caption: t.querySelector('caption').textContent.length > 20, cells: t.querySelectorAll('tbody td').length, dimsOk: [...t.querySelectorAll('tbody tr')].every(r => r.children.length === 17) && t.querySelectorAll('thead th').length === 17 }; });
      check('regress', '10.matrix-semantics', 'matrix is a real table: caption, scope=col on 17 header cells, scope=row on 11 row headers, 11x16 data cells, every th has scope', th.thNoScope === 0 && th.caption && th.cells === 176 && th.dimsOk && th.rowScopes.split(',').length === 11 && /^col(,col)*$/.test(th.colScopes), JSON.stringify(th));
      const tbl = await p.$('.matrix');
      const snap = await p.accessibility.snapshot({ root: tbl, interestingOnly: false });
      const flat = []; (function walk(n) { if (!n) return; flat.push(n); (n.children || []).forEach(walk); })(snap);
      const roles = {}; flat.forEach(n => roles[n.role] = (roles[n.role] || 0) + 1);
      const rh = flat.filter(n => n.role === 'rowheader').map(n => n.name), ch = flat.filter(n => n.role === 'columnheader').map(n => n.name);
      const req = flat.filter(n => n.role === 'cell' && /(^|\s)requis/.test(n.name || '') && !/non requis/.test(n.name || '')).length;
      const expReq = 1 + 2 + 4 + 4 + 4 + 1 + 3 + 1 + 1 + 1 + 1;
      check('regress', '10.matrix-axtree', 'accessibility tree: role table, 12 rows, 17 columnheaders named "NN name", 11 rowheaders, 176 cells, 24 filled cells announced "requis"', roles.table === 1 && roles.row === 12 && ch.length === 17 && rh.length === 11 && roles.cell === 176 && req === expReq && ch.slice(1).every((n, i) => n === String(i + 1).padStart(2, '0') + ' ' + SRC.rows[i].name), `roles ${JSON.stringify(roles)}; filled ${req} (expected ${expReq}); rowheaders ${rh.join(' | ')}; first columnheaders ${ch.slice(0, 3).join(' | ')}`);
      const empties = flat.filter(n => n.role === 'cell' && !(n.name || '').trim()).length;
      (empties ? warn : pass)('regress', '10.matrix-empty-cells', 'empty matrix cells have no text (screen readers say "blank"; only filled cells say "requis")', `${empties} empty cells`);
      await p.close();
    }
    // --- no-JS with scripting REALLY disabled via CDP
    for (const vp of [{ w: 1280, h: 800 }, { w: 360, h: 740 }]) {
      const p = await browser.newPage(); const log = []; p.on('pageerror', e => log.push(String(e))); p.on('console', m => { if (['error', 'warning'].includes(m.type())) log.push(m.text()); });
      const c = await p.createCDPSession(); await c.send('Emulation.setScriptExecutionDisabled', { value: true });
      await p.setViewport({ width: vp.w, height: vp.h }); await p.goto(INDEX_URL, { waitUntil: 'networkidle0' }); await sleep(300);
      const r = await p.evaluate(() => {
        const vis = e => !!e && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' && e.getBoundingClientRect().height > 0;
        const q = s => [...document.querySelectorAll(s)];
        const ns = document.querySelector('.noscript'); const de = document.documentElement;
        return { jsClass: /\bjs\b/.test(de.className), scriptsRan: document.querySelectorAll('tr.part').length > 0 || document.querySelectorAll('.matrix').length > 0,
          noscript: ns ? { vis: vis(ns), text: ns.textContent.slice(0, 70), link: !!ns.querySelector('a[href*="github.com/Nath-Lmn/i3-nuke"]'), before: (ns.compareDocumentPosition(document.querySelector('.sheet')) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 } : null,
          search: q('#parts-q').filter(vis).length, filters: q('#parts-filters button').filter(vis).length, copyBtns: q('.copy').filter(vis).length, count: q('#parts-count').filter(vis).length, jsOnly: q('.js-only').filter(vis).length, tools: q('.tools').filter(vis).length,
          fallbackRow: vis(document.querySelector('#parts-body td')) && /JavaScript/i.test(document.getElementById('parts-body').textContent), partsFallbackText: document.getElementById('parts-body').textContent.trim().slice(0, 90),
          deps: q('.deps tbody tr').filter(vis).length, trouble: q('.trouble tbody tr').filter(vis).length, cmdBlocks: q('[id^=cmd-]').filter(vis).length, h1: vis(document.querySelector('h1')), matrixVis: q('.matrix').length,
          sw: de.scrollWidth, cw: de.clientWidth, tabsVisible: q('.tabs a').filter(vis).length };
      });
      check('regress', `10.nojs-cdp.${vp.w}x${vp.h}`, `scripts really disabled (CDP Emulation.setScriptExecutionDisabled: no "js" class, no rows built) at ${vp.w}x${vp.h}`, !r.jsClass && !r.scriptsRan, JSON.stringify({ jsClass: r.jsClass, scriptsRan: r.scriptsRan }));
      check('regress', `10.nojs-notice.${vp.w}x${vp.h}`, '<noscript> notice is displayed, links to the README, placed before the content', !!r.noscript && r.noscript.vis && r.noscript.link && r.noscript.before && /JavaScript/.test(r.noscript.text), JSON.stringify(r.noscript));
      check('regress', `10.nojs-controls-hidden.${vp.w}x${vp.h}`, 'dead controls hidden without JS: search, 4 filter buttons, 6 copy buttons, count line, js-only text', r.search === 0 && r.filters === 0 && r.copyBtns === 0 && r.count === 0 && r.jsOnly === 0 && r.tools === 0, JSON.stringify({ search: r.search, filters: r.filters, copy: r.copyBtns, count: r.count, jsOnly: r.jsOnly, tools: r.tools }));
      check('regress', `10.nojs-content.${vp.w}x${vp.h}`, 'static content still readable without JS: h1, 6 command blocks, troubleshooting rows, dependency list, parts fallback message, 9 tab links, no overflow', r.h1 && r.cmdBlocks === 6 && r.trouble >= 12 && r.deps === 6 && r.fallbackRow && r.sw <= r.cw && r.tabsVisible === 9 && r.matrixVis === 0, JSON.stringify({ cmd: r.cmdBlocks, trouble: r.trouble, deps: r.deps, fallback: r.partsFallbackText, sw: r.sw, cw: r.cw, tabs: r.tabsVisible }));
      check('regress', `10.nojs-errors.${vp.w}x${vp.h}`, 'no console errors without JS', log.length === 0, log.join('; '));
      await p.screenshot({ path: path.join(OUT, `nojs-cdp-${vp.w}x${vp.h}-top.png`) });
      const pe = await p.$('#parts'); await pe.screenshot({ path: path.join(OUT, `nojs-cdp-${vp.w}x${vp.h}-parts.png`) }).catch(() => {});
      await p.close();
    }
    { // JS enabled: noscript content must not render, controls visible
      const p = await openPage(browser, { w: 1280, h: 800 }); await load(p);
      const r = await p.evaluate(() => ({ ns: document.querySelectorAll('.noscript').length, jsClass: /\bjs\b/.test(document.documentElement.className), search: getComputedStyle(document.getElementById('parts-q')).display, jsOnly: [...document.querySelectorAll('.js-only')].map(e => getComputedStyle(e).display) }));
      check('regress', '10.js-on-ui', 'with JS on: no noscript notice, search/filters/copy shown, js-only text shown', r.ns === 0 && r.jsClass && r.search !== 'none' && r.jsOnly.every(d => d !== 'none'), JSON.stringify(r));
      await p.close();
    }
    // --- matrix -> list switch exactly at 640 px
    for (const [w, shown] of [[639, false], [640, true], [641, true], [700, true], [719, true], [720, true]]) {
      const p = await openPage(browser, { w, h: 900 }); await load(p);
      const r = await p.evaluate(() => ({ matrix: getComputedStyle(document.getElementById('matrix-wrap')).display !== 'none', list: getComputedStyle(document.querySelector('.deps')).display !== 'none' && document.querySelector('.deps tbody tr').getBoundingClientRect().height > 0, scrolls: (() => { const m = document.getElementById('matrix-wrap'); return m.scrollWidth > m.clientWidth + 1; })(), sw: document.documentElement.scrollWidth }));
      check('regress', `10.matrix-switch.${w}`, `at ${w}px the matrix is ${shown ? 'shown' : 'hidden'}, the dependency list is shown, matrix does not scroll sideways, no page overflow`, r.matrix === shown && r.list && (!shown || !r.scrolls) && r.sw <= w, JSON.stringify(r));
      await p.close();
    }
    // --- mobile tab strip affordance
    for (const vp of [{ w: 360, h: 740, mobile: true }, { w: 320, h: 640, mobile: true }, { w: 768, h: 1024 }]) {
      const p = await openPage(browser, vp); await load(p);
      const r = await p.evaluate(() => { const t = document.querySelector('.tabs'), ol = t.querySelector('ol'); const a = getComputedStyle(t, '::after'); return { more: t.classList.contains('more'), overflows: ol.scrollWidth - ol.clientWidth > 2, after: a.content, disp: a.display, w: a.width, pe: a.pointerEvents, sw: ol.scrollWidth, cw: ol.clientWidth }; });
      check('regress', `10.strip-affordance.${vpName(vp)}`, `tab strip shows a "more" indicator exactly when it overflows (${vpName(vp)})`, r.more === r.overflows && (!r.overflows || (/→/.test(r.after) && r.disp !== 'none' && r.pe === 'none')), JSON.stringify(r));
      if (r.overflows) {
        await p.screenshot({ path: path.join(OUT, `strip-${vpName(vp)}.png`), clip: { x: 0, y: 0, width: vp.w, height: 80 } });
        await p.evaluate(() => { const ol = document.querySelector('.tabs ol'); ol.scrollLeft = ol.scrollWidth; }); await sleep(250);
        const e = await p.evaluate(() => ({ more: document.querySelector('.tabs').classList.contains('more') }));
        check('regress', `10.strip-affordance-end.${vpName(vp)}`, 'indicator disappears once the strip is scrolled to its end', e.more === false, JSON.stringify(e));
      }
      await p.close();
    }
    // --- h1 / kicker spacing: pixel diff of the kicker box with and without the h1
    for (const vp of [{ w: 1280, h: 800 }, { w: 768, h: 1024 }, { w: 360, h: 740 }, { w: 320, h: 640 }]) {
      const p = await openPage(browser, vp); await load(p); await sleep(500);
      const box = await p.evaluate(() => { const k = document.querySelector('.cover .kicker').getBoundingClientRect(); const h = document.querySelector('.cover h1').getBoundingClientRect(); return { x: Math.floor(k.left), y: Math.floor(k.top), w: Math.ceil(k.width), h: Math.ceil(k.height) + 3, gap: Math.round(h.top - k.bottom) }; });
      const clip = { x: box.x, y: box.y, width: box.w, height: box.h };
      if (vp.w === 1280 || vp.w === 360) await p.screenshot({ path: path.join(OUT, `h1-kicker-${vpName(vp)}.png`), clip: { x: 0, y: Math.max(0, box.y - 10), width: vp.w, height: 230 } });
      const a = await p.screenshot({ clip });
      await p.addStyleTag({ content: '.cover h1{visibility:hidden !important}' }); const b = await p.screenshot({ clip });
      check('regress', `10.h1-kicker.${vpName(vp)}`, `no h1 glyph (accent of E acute) enters the kicker line box (+3px) at ${vpName(vp)}`, Buffer.compare(a, b) === 0, `kicker to h1 box gap ${box.gap}px`);
      await p.close();
    }
    // --- print: compact cover, white
    {
      const p = await openPage(browser, { w: 703, h: 1017 }); await load(p); await p.emulateMediaType('print'); await sleep(300);
      const r = await p.evaluate(() => {
        const px2mm = 25.4 / 96; const cv = document.querySelector('.cover').getBoundingClientRect(), dr = document.querySelector('.drawing').getBoundingClientRect(); const big = [];
        for (const e of document.querySelectorAll('body *')) { const cs = getComputedStyle(e); const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/); if (!m) continue; const v = m[1].split(/[ ,\/]+/).map(Number); if (v.length > 3 && v[3] === 0) continue; const rr = e.getBoundingClientRect(); if (rr.width * rr.height > 4000 && !(v[0] === 255 && v[1] === 255 && v[2] === 255)) big.push((e.className && e.className.baseVal === undefined ? String(e.className).split(' ')[0] : e.tagName) + ' ' + cs.backgroundColor); }
        return { coverMM: Math.round(cv.height * px2mm), drawMM: Math.round(dr.width * px2mm), html: getComputedStyle(document.documentElement).backgroundColor, body: getComputedStyle(document.body).backgroundColor, drawingBg: getComputedStyle(document.querySelector('.drawing')).backgroundColor, xerox: getComputedStyle(document.querySelector('.xerox')).backgroundColor, tabs: getComputedStyle(document.querySelector('.tabs')).display, nonWhiteBackgrounds: [...new Set(big)].slice(0, 12) };
      });
      check('regress', '10.print-cover', 'print (printable A4 area 186x269 mm): cover fits on one page (<= 269 mm), drawing <= 131 mm wide, white page/drawing/annex backgrounds, tabs hidden', r.coverMM <= 269 && r.drawMM <= 131 && /255, 255, 255/.test(r.html) && /255, 255, 255/.test(r.body) && /255, 255, 255/.test(r.drawingBg) && /255, 255, 255/.test(r.xerox) && r.tabs === 'none', JSON.stringify(r));
      await p.screenshot({ path: path.join(OUT, 'print2-top.png') });
      const pdf = path.join(OUT, 'print2.pdf'); await p.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true });
      const buf = fs.readFileSync(pdf).toString('latin1'); const pages = (buf.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
      let per = []; try { per = JSON.parse(cp.execFileSync('python', ['-I', '-X', 'utf8', '-c', 'import sys,json\nfrom pypdf import PdfReader\nr=PdfReader(sys.argv[1])\nprint(json.dumps([(p.extract_text() or "") for p in r.pages]))', pdf], { encoding: 'utf8', timeout: 30000 })); } catch (e) { per = []; }
      if (per.length) {
        const all = per.join('\n').replace(/\s+/g, ' ').toLowerCase();
        const miss = ['unité de', 'sommaire', 'consignes de sécurité', 'mise en service', 'nomenclature des modules', 'matrice des dépendances', 'retour à la normale', 'pièce à conviction', 'bon confloose, avec modération', ...SRC.rows.map(x => x.name)].filter(n => !all.includes(n.toLowerCase()));
        const p1 = per[0].replace(/\s+/g, ' ').toLowerCase(), p2 = (per[1] || '').replace(/\s+/g, ' ').toLowerCase();
        check('regress', '10.print-cover-page', 'PDF page 1 holds the whole cover (ref block to last lead sentence) and page 2 starts with the contents', p1.includes('unité de') && p1.includes('y met des conditions') && p2.includes('sommaire'), `p1 tail: ...${p1.slice(-60)} | p2 head: ${p2.slice(0, 40)}`);
        check('regress', '10.print-pdf', `print PDF (A4): ${pages} pages, all headings and 16 prank names present, last colophon line present`, miss.length === 0 && pages >= 5, `pages ${pages}; missing ${miss.join(',') || 'none'}`);
        info('regress', '10.print-pages', 'first words of each PDF page', per.map((t, i) => `p${i + 1}: ${t.replace(/\s+/g, ' ').slice(0, 70)}`).join('\n'));
      } else warn('regress', '10.print-pdf', `PDF ${pages} pages but pypdf unavailable`, pdf);
      await p.close();
    }
    // --- regression: focus rings on tabs not clipped; sticky strip vs anchors
    for (const vp of [{ w: 1280, h: 800 }, { w: 1280, h: 400 }, { w: 360, h: 740, mobile: true }, { w: 768, h: 1024 }]) {
      const p = await openPage(browser, vp); await load(p); await p.bringToFront();
      const bad = []; const desktop = vp.w >= 900;
      for (let i = 0; i < 12; i++) {
        await p.keyboard.press('Tab'); await sleep(40);
        const f = await p.evaluate(() => {
          const e = document.activeElement; if (!e || !e.closest('.tabs')) return null; const cs = getComputedStyle(e), r = e.getBoundingClientRect(), ol = e.closest('ol').getBoundingClientRect();
          const ow = parseFloat(cs.outlineWidth), off = parseFloat(cs.outlineOffset);
          return { id: e.dataset.for, style: cs.outlineStyle, ow, off, inside: r.left >= ol.left - 0.5 && r.right <= ol.right + 0.5 && r.top >= Math.max(ol.top, 0) - 0.5 && r.bottom <= Math.min(ol.bottom, innerHeight) + 0.5, ringInside: off <= -ow, w: Math.round(r.width) };
        });
        if (!f) continue;
        if (f.style === 'none' || f.ow < 2 || !f.inside || !f.ringInside) bad.push(JSON.stringify(f));
        if (i === 3 || i === 8) await p.screenshot({ path: path.join(OUT, `tabfocus-${vpName(vp)}-${i}.png`), clip: desktop ? { x: vp.w - 150, y: 0, width: 150, height: vp.h } : { x: 0, y: 0, width: vp.w, height: 80 } });
      }
      check('regress', `10.tab-focus-ring.${vpName(vp)}`, `keyboard focus ring on binder tabs visible, >=2px, drawn inside the tab and the strip clip (not cut by overflow) at ${vpName(vp)}`, bad.length === 0, bad.join('\n') || 'ok for first tabs');
      await p.close();
    }
    for (const vp of [{ w: 360, h: 740, mobile: true }, { w: 768, h: 1024 }, { w: 640, h: 800 }]) {
      const p = await openPage(browser, vp); await load(p); const bad = [];
      for (const id of ['contents', 'safety', 'install', 'parts', 'matrix', 'recovery', 'annex']) {
        await p.$eval(`.tabs a[data-for="${id}"]`, e => e.click()); await sleep(350);
        const r = await p.evaluate(id => { const h = document.querySelector('#' + id + ' h2'), t = document.querySelector('.tabs'); return { top: Math.round(h.getBoundingClientRect().top), strip: Math.round(t.getBoundingClientRect().bottom) }; }, id);
        if (r.top < r.strip) bad.push(`${id}: heading top ${r.top} < strip bottom ${r.strip}`);
      }
      for (const href of ['#step-download', '#step-menu', '#step-undo', '#parts']) {
        await p.evaluate(h => { location.hash = ''; document.querySelector('.toc a[href="' + h + '"]').click(); }, href); await sleep(350);
        const r = await p.evaluate(h => ({ top: Math.round(document.querySelector(h).getBoundingClientRect().top), strip: Math.round(document.querySelector('.tabs').getBoundingClientRect().bottom) }), href);
        if (r.top < r.strip - 1) bad.push(`${href}: top ${r.top} < strip ${r.strip}`);
      }
      check('regress', `10.sticky-anchors.${vpName(vp)}`, `target headings/steps are not hidden under the sticky tab strip after tab or TOC clicks at ${vpName(vp)}`, bad.length === 0, bad.join('\n') || 'ok');
      await p.close();
    }
  });

  await browser.close();

  /* ------------------------------------------------------------ summary */
  const cnt = s => results.filter(r => r.status === s).length;
  console.log(`\n==== SUMMARY: ${cnt('PASS')} PASS, ${cnt('FAIL')} FAIL, ${cnt('WARN')} WARN, ${cnt('INFO')} INFO ====`);
  results.filter(r => r.status === 'FAIL').forEach(r => console.log('FAIL ' + r.id + ' ' + r.name));
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  console.log('results.json + screenshots in', OUT);
  process.exit(cnt('FAIL') ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
