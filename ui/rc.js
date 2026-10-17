'use strict';
// Talking to rclone's remote-control server, and explaining what it says.
//
// The launcher writes window.OFFLOAD_SESSION (port, user, password) into
// session.js. Every request carries that password in an Authorization header.
// A header like that cannot be added to a request from another website
// without the server agreeing to it, and the server only agrees for this page.

const RC = (() => {
  const s = window.OFFLOAD_SESSION || null;
  const base = s ? 'http://127.0.0.1:' + s.port + '/' : '';
  const auth = s ? 'Basic ' + btoa(s.user + ':' + s.pass) : '';

  class RcError extends Error {
    constructor(message, status, body) {
      super(message);
      this.status = status;   // 0 when the server could not be reached
      this.body = body;
    }
  }

  async function call(path, params, opts) {
    if (!s) throw new RcError('no session', 0);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), (opts && opts.timeout) || 30000);
    let res;
    try {
      res = await fetch(base + path, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(params || {}),
        signal: ctl.signal,
        cache: 'no-store',
      });
    } catch (e) {
      throw new RcError(e.name === 'AbortError' ? 'timed out' : 'unreachable', 0);
    } finally {
      clearTimeout(timer);
    }
    let body = null;
    try { body = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok) throw new RcError((body && body.error) || 'HTTP ' + res.status, res.status, body);
    return body;
  }

  // rclone's errors are written for people who know rclone. Each rule turns
  // one into what happened and what to do about it. The first match wins,
  // so the specific ones come before the general.
  const RULES = [
    [/^unreachable$/,
      'Offload\'s server has stopped',
      'This page cannot reach it. Start Offload again with Offload.cmd (or start.sh), and any upload still running carries on.'],
    [/^timed out$/,
      'No answer in time',
      'rclone is busy or the connection is slow. It will be tried again.'],
    [/upload ?limit|uploadLimitExceeded|Daily limit/i,
      'Today\'s upload limit is reached',
      'Google lets each account upload 750 GB a day. Start the same upload again tomorrow: files already up are skipped.'],
    [/storageQuotaExceeded|storage quota|quota has been exceeded|insufficient.*(space|storage)/i,
      'The cloud is full',
      'There is no room left on the cloud account. Free some space there, or pick fewer files.'],
    [/rateLimitExceeded|RATE_LIMIT|Quota exceeded for quota metric|too many requests|429/i,
      'The cloud is asking rclone to slow down',
      'rclone waits and tries again by itself. With Google Drive, this usually means rclone\'s shared sign-in is busy. If it keeps happening, make your own client ID (see the README).'],
    [/invalid_grant|Invalid Credentials|token.*(expired|revoked)|unauthenticated|401/i,
      'The cloud sign-in no longer works',
      'Access was removed or has expired. In a terminal, run rclone config reconnect followed by the remote\'s name and a colon, then try again.'],
    // rclone says "didn't find section in config file", so this goes before
    // the broken-settings rule, which matches "config file".
    [/didn't find section in config|unknown remote|not found in config/i,
      'That cloud isn\'t set up in rclone',
      'Pick another one, or set it up once with rclone config.'],
    [/failed to decrypt password|is it obscured|couldn't (read|parse) config|config file/i,
      'That cloud\'s settings in rclone are broken',
      'rclone could not read them. Fix or recreate it with rclone config.'],
    [/directory not found|cannot find the path|no such file or directory|cannot find the file/i,
      'That folder doesn\'t exist',
      'Check the spelling, or use Browse to pick it.'],
    [/access is denied|permission denied|forbidden|403/i,
      'Not allowed',
      'This account or folder does not allow that. Check you picked the right one.'],
    [/context canceled/i,
      'Stopped',
      'You stopped this. Starting it again skips whatever is already done.'],
    [/no such host|dial tcp|connection (refused|reset)|i\/o timeout|TLS handshake|network is unreachable|EOF$/i,
      'Network trouble',
      'The connection to the cloud dropped. rclone retries by itself; if it keeps failing, check the internet connection.'],
  ];

  function explain(err) {
    const raw = err == null ? '' : typeof err === 'string' ? err : (err.message || String(err));
    for (const [re, title, detail] of RULES) {
      if (re.test(raw)) return { title, detail, raw };
    }
    return { title: 'Something went wrong', detail: raw, raw };
  }

  return { call, explain, RcError, session: s, has: !!s };
})();
