'use strict';
// Turning numbers into words people read. No DOM in here, so it is easy to test.

const Fmt = (() => {
  const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

  // Sizes count in 1024s and are labelled GB, the way Windows Explorer and
  // Google Drive show them, so a figure here matches the one people see there.
  function bytes(n) {
    if (n == null || !isFinite(n) || n < 0) return '–';
    if (n < 1024) return Math.round(n) + ' B';
    let v = n, i = 0;
    while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
    return v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0) + ' ' + UNITS[i];
  }

  function speed(bps) {
    return bps > 0 ? bytes(bps) + '/s' : '–';
  }

  // Internet plans are sold in megabits, so say that too.
  function mbit(bps) {
    if (!(bps > 0)) return '';
    const m = bps * 8 / 1e6;
    return (m < 10 ? m.toFixed(1) : Math.round(m)) + ' Mbit/s';
  }

  function duration(sec) {
    if (sec == null || !isFinite(sec) || sec < 0) return '–';
    sec = Math.round(sec);
    if (sec < 60) return sec + ' s';
    const m = Math.floor(sec / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d) return d + ' d ' + (h % 24) + ' h';
    if (h) return h + ' h ' + (m % 60) + ' min';
    return m + ' min';
  }

  function count(n, one, many) {
    return n.toLocaleString() + ' ' + (n === 1 ? one : (many || one + 's'));
  }

  function ago(ms) {
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    const d = new Date(ms), today = new Date();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === today.toDateString()) return 'today ' + time;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
  }

  // "64M", "1.5G", "800k" -> bytes. Matches what rclone accepts for --bwlimit.
  function parseRate(text) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?\s*$/i.exec(text || '');
    if (!m) return null;
    const pow = { '': 0, k: 1, m: 2, g: 3, t: 4 }[m[2].toLowerCase()];
    return parseFloat(m[1]) * Math.pow(1024, m[2] ? pow : 1);
  }

  // Last part of a path, for the slash style of either side.
  function base(p) {
    const parts = String(p).split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(p);
  }

  return { bytes, speed, mbit, duration, count, ago, parseRate, base };
})();
