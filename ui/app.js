'use strict';
// Decant's page. Everything it does goes through rclone's remote-control API
// (rc.js): listing folders, copying, live progress, checksum checks, deleting.
// There is no other back end.

(() => {
  const $ = (id) => document.getElementById(id);

  // ---- small helpers -------------------------------------------------------

  // Element builder. Text is always set as text, never as HTML, because file
  // names can contain anything.
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : String(c));
    return n;
  }
  const svg = (markup) => { const t = document.createElement('template'); t.innerHTML = markup.trim(); return t.content.firstChild; };
  const FOLDER = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  const DISK = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v12H4zM4 14h16M16 16.5h1"/></svg>';

  // localStorage holds only conveniences: the last folders, settings, recent
  // runs. A page that cannot store (private window) still works.
  const store = {
    get(k, d) { try { const v = localStorage.getItem('decant.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('decant.' + k, JSON.stringify(v)); } catch (e) { /* fine */ } },
  };

  let toastTimer = 0;
  function toast(text) {
    const t = $('toast');
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3800);
  }

  function ask(title, text, yes) {
    const d = $('dlg-ask');
    $('ask-h').textContent = title;
    $('ask-text').textContent = text;
    $('ask-yes').textContent = yes || 'OK';
    d.returnValue = '';
    d.showModal();
    return new Promise((res) => d.addEventListener('close', () => res(d.returnValue === 'yes'), { once: true }));
  }

  function noteBox(kind, title, detail) {
    return el('div', { class: 'note ' + kind }, el('b', { text: title }), detail ? el('p', { text: detail }) : null);
  }

  // ---- state ---------------------------------------------------------------

  const KIND = {
    drive: 'Google Drive', onedrive: 'OneDrive', dropbox: 'Dropbox', box: 'Box', pcloud: 'pCloud',
    mega: 'MEGA', protondrive: 'Proton Drive', s3: 'S3', b2: 'Backblaze B2', sftp: 'SFTP',
    webdav: 'WebDAV', ftp: 'FTP', local: 'Folder on this computer', alias: 'Alias', crypt: 'Encrypted',
    smb: 'Network share', azureblob: 'Azure Blob', gcs: 'Google Cloud Storage', iclouddrive: 'iCloud Drive',
    yandex: 'Yandex Disk', koofr: 'Koofr', jottacloud: 'Jottacloud', union: 'Union',
  };
  // Remotes that only wrap another one. Where their files really live is not
  // something this page can be sure of, so freeing space is not offered.
  const WRAPPERS = new Set(['crypt', 'union', 'combine', 'chunker', 'compress', 'hasher', 'cache']);
  const DRIVE_DAILY = 750 * 1024 ** 3;

  const state = {
    os: '', version: '',
    remotes: [],                 // { name, type, target }
    src: '', srcDisk: null, srcFiles: null, srcErr: null,
    dst: { remote: '', path: '' }, dstAbout: null, dstFiles: null, dstErr: null, dstNew: false,
    opts: Object.assign({ transfers: 4, chunk: '256M', limit: true, bw: '' }, store.get('opts', {})),
    job: null,                   // the copy or check being watched
    check: null,                 // last check result for the current pair
    online: true,
  };

  const remoteOf = (name) => state.remotes.find((r) => r.name === name);
  const isDrive = () => { const r = remoteOf(state.dst.remote); return !!r && r.type === 'drive'; };
  const dstFs = () => state.dst.remote ? state.dst.remote + ':' + state.dst.path : '';
  const dstLabel = () => state.dst.remote + ':' + (state.dst.path ? state.dst.path : '');
  const pairKey = () => state.src + '\n' + dstFs();

  // ---- connection ----------------------------------------------------------

  function setConn(kind, text) {
    $('conn').className = 'pill ' + kind;
    $('conn-text').textContent = text;
  }

  function gate(detail) {
    $('app').hidden = true;
    $('gate').hidden = false;
    $('gate-detail').textContent = detail || '';
  }

  // A cheap request every few seconds, so the page notices if the server is
  // stopped from elsewhere.
  async function heartbeat() {
    try {
      await RC.call('core/version', null, { timeout: 4000 });
      if (!state.online) { state.online = true; setConn('ok', 'rclone ' + state.version); renderAll(); }
    } catch (e) {
      if (e.status === 0 && state.online) {
        state.online = false;
        setConn('bad', 'Server stopped');
        renderAll();
      }
    }
    setTimeout(heartbeat, 5000);
  }

  // ---- remotes -------------------------------------------------------------

  async function loadRemotes() {
    const r = await RC.call('config/listremotes');
    const names = (r.remotes || []).slice().sort((a, b) => a.localeCompare(b));
    state.remotes = await Promise.all(names.map(async (name) => {
      try {
        // config/get returns the whole section, sign-in token included. Keep
        // only what the page needs and let the rest go.
        const c = await RC.call('config/get', { name });
        return { name, type: c.type || '', target: c.type === 'alias' ? (c.remote || '') : '' };
      } catch (e) {
        return { name, type: '', target: '' };
      }
    }));
    const sel = $('dst-remote');
    sel.replaceChildren();
    if (!state.remotes.length) {
      sel.append(el('option', { value: '', text: 'No cloud set up in rclone yet' }));
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    for (const r of state.remotes) {
      sel.append(el('option', { value: r.name, text: r.name + (KIND[r.type] ? ' · ' + KIND[r.type] : r.type ? ' · ' + r.type : '') }));
    }
  }

  // ---- the source folder ---------------------------------------------------

  let srcSeq = 0;
  async function setSource(path) {
    // Explorer's "Copy as path" wraps the path in quotes.
    path = (path || '').trim().replace(/^"(.*)"$/, '$1').trim();
    if (path.length > 3) path = path.replace(/[\\/]+$/, '');
    state.src = path;
    $('src-path').value = path;
    store.set('src', path);
    state.srcFiles = null; state.srcErr = null; state.srcDisk = null;
    loadCheck();
    renderSource(); renderPlan(); renderVerify();
    if (!path) return;
    const seq = ++srcSeq;
    const [du, list] = await Promise.allSettled([
      RC.call('core/du', { dir: path }),
      RC.call('operations/list', { fs: path, remote: '', opt: { recurse: true, filesOnly: true } }, { timeout: 180000 }),
    ]);
    if (seq !== srcSeq) return;
    state.srcDisk = du.status === 'fulfilled' ? du.value.info : null;
    if (list.status === 'fulfilled') {
      state.srcFiles = (list.value.list || []).map((f) => ({ path: f.Path, size: f.Size, mod: f.ModTime }));
    } else {
      state.srcErr = list.reason;
    }
    renderSource(); renderPlan(); renderVerify();
  }

  function renderSource() {
    const sum = $('src-sum');
    sum.className = 'sum';
    if (!state.src) { sum.textContent = 'Pick the folder whose files you want in the cloud.'; $('src-disk').hidden = true; return; }
    if (state.srcErr) {
      const x = RC.explain(state.srcErr);
      sum.className = 'sum bad'; sum.textContent = x.title + '. ' + x.detail;
    } else if (!state.srcFiles) {
      sum.textContent = 'Looking inside…';
    } else {
      const total = state.srcFiles.reduce((a, f) => a + f.size, 0);
      sum.textContent = state.srcFiles.length
        ? Fmt.count(state.srcFiles.length, 'file') + ', ' + Fmt.bytes(total) + ' in all.'
        : 'This folder is empty.';
    }
    const d = state.srcDisk;
    meter($('src-disk'), d ? { total: d.Total, free: d.Available != null ? d.Available : d.Free } : null, 'This disk', 0);
  }

  // A bar for a disk or a cloud: used, then what an action adds or frees.
  function meter(box, space, label, adds, frees) {
    if (!space || !(space.total > 0)) { box.hidden = true; return; }
    const used = space.total - space.free;
    const pct = (n) => Math.max(0, Math.min(100, n / space.total * 100)) + '%';
    box.hidden = false;
    box.className = 'meter' + (space.free / space.total < 0.05 ? ' tight' : '');
    const bar = el('div', { class: 'bar' },
      el('div', { class: 'used' }),
      adds ? el('div', { class: 'adds' }) : null);
    bar.children[0].style.width = pct(used - (frees || 0));
    if (frees) { const f = el('div', { class: 'frees' }); f.style.width = pct(frees); bar.append(f); }
    if (adds) bar.children[1].style.width = pct(Math.min(adds, space.free));
    const right = adds
      ? Fmt.bytes(Math.max(0, space.free - adds)) + ' free after'
      : frees ? Fmt.bytes(space.free + frees) + ' free after'
      : Fmt.bytes(space.total) + ' in all';
    box.replaceChildren(bar, el('div', { class: 'lbl' },
      el('span', { text: label + ': ' + Fmt.bytes(space.free) + ' free' }), el('span', { text: right })));
  }

  // ---- the destination -----------------------------------------------------

  const aboutCache = new Map();   // remote -> { at, value }; `about` costs an API call
  let dstSeq = 0;
  async function setDest(remote, path) {
    path = (path || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    state.dst = { remote, path };
    $('dst-remote').value = remote;
    $('dst-path').value = path;
    store.set('dst', state.dst);
    state.dstFiles = null; state.dstErr = null; state.dstNew = false;
    loadCheck();
    syncDriveOnly();
    renderDest(); renderPlan(); renderVerify();
    if (!remote) return;
    const seq = ++dstSeq;
    const [about, list] = await Promise.allSettled([
      remoteAbout(remote),
      RC.call('operations/list', { fs: dstFs(), remote: '', opt: { recurse: true, filesOnly: true } }, { timeout: 180000 }),
    ]);
    if (seq !== dstSeq) return;
    state.dstAbout = about.status === 'fulfilled' ? about.value : null;
    if (list.status === 'fulfilled') {
      state.dstFiles = (list.value.list || []).map((f) => ({ path: f.Path, size: f.Size }));
    } else if (/directory not found/i.test(list.reason.message)) {
      state.dstFiles = []; state.dstNew = true;
    } else {
      state.dstErr = list.reason;
    }
    renderDest(); renderPlan(); renderVerify();
  }

  async function remoteAbout(remote, fresh) {
    const hit = aboutCache.get(remote);
    if (hit && !fresh && Date.now() - hit.at < 60000) return hit.value;
    let v = null;
    for (let i = 0; i < 2 && !v; i++) {
      try { v = await RC.call('operations/about', { fs: remote + ':' }); }
      catch (e) {
        // A first request can be turned away for a moment; one quiet retry.
        if (i === 0 && /rate|quota/i.test(e.message)) await new Promise((r) => setTimeout(r, 1500));
        else break;
      }
    }
    if (v) aboutCache.set(remote, { at: Date.now(), value: v });
    return v;
  }

  function renderDest() {
    const sum = $('dst-sum');
    sum.className = 'sum';
    if (!state.remotes.length) {
      sum.replaceChildren('Connect a cloud once in a terminal with ', el('code', { text: 'rclone config' }), ', then reopen Decant.');
      $('dst-disk').hidden = true; return;
    }
    if (state.dstErr) {
      const x = RC.explain(state.dstErr);
      sum.className = 'sum bad'; sum.textContent = x.title + '. ' + x.detail;
    } else if (!state.dstFiles) {
      sum.textContent = 'Looking inside…';
    } else if (state.dstNew) {
      sum.textContent = 'A new folder. It is made when the upload starts.';
    } else {
      sum.textContent = state.dstFiles.length
        ? Fmt.count(state.dstFiles.length, 'file') + ' already in this folder.'
        : 'This folder is empty.';
    }
    const a = state.dstAbout;
    const plan = computePlan();
    meter($('dst-disk'), a && a.total ? { total: a.total, free: a.free != null ? a.free : a.total - (a.used || 0) } : null,
      KIND[(remoteOf(state.dst.remote) || {}).type] || 'Cloud', plan ? plan.sendBytes : 0);
  }

  function syncDriveOnly() {
    for (const n of document.querySelectorAll('[data-only="drive"]')) n.hidden = !isDrive();
  }

  // ---- the plan ------------------------------------------------------------

  function computePlan() {
    if (!state.srcFiles || !state.dstFiles) return null;
    const there = new Map(state.dstFiles.map((f) => [f.path, f]));
    const rows = state.srcFiles.map((f) => {
      const d = there.get(f.path);
      return Object.assign({ status: !d ? 'new' : d.size === f.size ? 'there' : 'differs' }, f);
    });
    const of = (s) => rows.filter((r) => r.status === s);
    const sum = (list) => list.reduce((a, r) => a + r.size, 0);
    const fresh = of('new'), same = of('there'), diff = of('differs');
    return {
      rows,
      newCount: fresh.length, newBytes: sum(fresh),
      thereCount: same.length, thereBytes: sum(same),
      diffCount: diff.length, diffBytes: sum(diff),
      sendCount: fresh.length + diff.length, sendBytes: sum(fresh) + sum(diff),
    };
  }

  // A speed from earlier runs makes the time estimate honest before starting.
  function knownSpeed() {
    const runs = store.get('history', []).filter((h) => h.kind === 'copy' && h.bytes > 50 * 1024 ** 2 && h.secs > 20);
    if (!runs.length) return 0;
    const recent = runs.slice(0, 5);
    return recent.reduce((a, h) => a + h.bytes, 0) / recent.reduce((a, h) => a + h.secs, 0);
  }

  function todayBytes(remote) {
    const t = store.get('today', {});
    return t.date === new Date().toDateString() ? (t.bytes && t.bytes[remote]) || 0 : 0;
  }
  function addToday(remote, n) {
    if (!(n > 0)) return;
    const day = new Date().toDateString();
    let t = store.get('today', {});
    if (t.date !== day) t = { date: day, bytes: {} };
    t.bytes[remote] = (t.bytes[remote] || 0) + n;
    store.set('today', t);
  }

  function renderPlan() {
    const body = $('plan-body');
    const start = $('btn-start');
    const busy = !!state.job && !state.job.finished;
    start.disabled = true;
    if (!state.src || !state.dst.remote) {
      body.replaceChildren(el('p', { class: 'empty', text: 'Pick a folder on each side and the plan appears here.' }));
      return;
    }
    if (state.srcErr || state.dstErr) {
      body.replaceChildren(el('p', { class: 'empty', text: 'Fix the folder above first.' }));
      return;
    }
    const plan = computePlan();
    if (!plan) {
      body.replaceChildren(el('p', { class: 'empty', text: 'Comparing the two sides…' }));
      return;
    }

    const chips = el('div', { class: 'chips' },
      el('div', { class: 'chip main' }, el('b', { text: plan.sendCount.toLocaleString() }), el('span', { text: (plan.sendCount === 1 ? 'file' : 'files') + ' to upload, ' + Fmt.bytes(plan.sendBytes) })),
      plan.thereCount ? el('div', { class: 'chip' }, el('b', { text: plan.thereCount.toLocaleString() }), el('span', { text: 'already there, skipped' })) : null,
      plan.diffCount ? el('div', { class: 'chip' }, el('b', { text: plan.diffCount.toLocaleString() }), el('span', { text: 'different size, replaced' })) : null);

    const warns = el('ul', { class: 'warns' });
    const a = state.dstAbout;
    if (a && a.free != null && plan.sendBytes > a.free) {
      warns.append(el('li', { class: 'bad', text: 'That is ' + Fmt.bytes(plan.sendBytes) + ' and the cloud has ' + Fmt.bytes(a.free) + ' free. It will not all fit.' }));
    }
    if (isDrive()) {
      const left = DRIVE_DAILY - todayBytes(state.dst.remote);
      if (plan.sendBytes > left) {
        warns.append(el('li', { text: 'More than can go up today (about ' + Fmt.bytes(Math.max(0, left)) + ' left today from this computer). ' +
          (state.opts.limit ? 'It stops cleanly when today\'s allowance is used; start it again tomorrow to finish.' : 'Turn on "Stop cleanly at the daily upload allowance" so the run ends neatly.') }));
      }
    }
    const sp = knownSpeed();
    if (plan.sendBytes && sp) {
      warns.append(el('li', { class: 'info', text: 'About ' + Fmt.duration(plan.sendBytes / sp) + ' at your recent speed of ' + Fmt.speed(sp) + ' (' + Fmt.mbit(sp) + ').' }));
    }
    if (!plan.sendCount && plan.rows.length) {
      warns.append(el('li', { class: 'info', text: 'Everything is already in the cloud. Check the copies below.' }));
    }

    const order = { new: 0, differs: 1, there: 2 };
    const rows = plan.rows.slice().sort((x, y) => order[x.status] - order[y.status] || y.size - x.size);
    const label = { new: 'New', there: 'Already there', differs: 'Replaced' };
    const table = el('table', null, el('tbody', null, rows.slice(0, 500).map((r) =>
      el('tr', null,
        el('td', { class: 'name', text: r.path }),
        el('td', { class: 'size', text: Fmt.bytes(r.size) }),
        el('td', null, el('span', { class: 'badge ' + r.status, text: label[r.status] }))))));
    const files = plan.rows.length ? el('details', { class: 'files', open: plan.rows.length <= 8 },
      el('summary', { text: 'The files (' + plan.rows.length.toLocaleString() + ')' + (plan.rows.length > 500 ? ', first 500 shown' : '') }),
      el('div', { class: 'scroll' }, table)) : null;

    body.replaceChildren(chips, warns.children.length ? warns : '', files || '');
    start.disabled = busy || !state.online || !plan.sendCount;
    start.textContent = plan.thereCount && plan.sendCount ? 'Upload the rest' : 'Start upload';
  }

  // ---- settings ------------------------------------------------------------

  function initOptions() {
    const t = $('opt-transfers');
    for (let i = 1; i <= 8; i++) t.append(el('option', { value: String(i), text: String(i) }));
    t.value = String(state.opts.transfers);
    $('opt-chunk').value = state.opts.chunk;
    $('opt-limit').checked = !!state.opts.limit;
    $('opt-bw').value = state.opts.bw || '';
    const save = () => {
      const bw = $('opt-bw').value.trim();
      $('opt-bw').setCustomValidity(bw && Fmt.parseRate(bw) == null ? 'Like 5M or 800k' : '');
      state.opts = { transfers: +t.value, chunk: $('opt-chunk').value, limit: $('opt-limit').checked, bw };
      store.set('opts', state.opts);
      renderPlan();
    };
    for (const id of ['opt-transfers', 'opt-chunk', 'opt-limit']) $(id).addEventListener('change', save);
    $('opt-bw').addEventListener('change', save);
  }

  // ---- jobs: copy and check ------------------------------------------------

  // Backend options go in the remote's name ("Drive,chunk_size=256M:folder"),
  // rclone's connection-string syntax, so they apply to this run only.
  function copyDstFs() {
    if (!isDrive()) return dstFs();
    const extra = ',chunk_size=' + state.opts.chunk + (state.opts.limit ? ',stop_on_upload_limit=true' : '');
    return state.dst.remote + extra + ':' + state.dst.path;
  }

  async function startCopy() {
    const plan = computePlan();
    if (!plan || !plan.sendCount) return;
    try {
      const bw = state.opts.bw && Fmt.parseRate(state.opts.bw) != null ? state.opts.bw : 'off';
      await RC.call('core/bwlimit', { rate: bw });
      const r = await RC.call('sync/copy', {
        srcFs: state.src,
        dstFs: copyDstFs(),
        _config: { Transfers: state.opts.transfers },
        _async: true,
      });
      watch({ kind: 'copy', id: r.jobid, exec: r.executeId, src: state.src, dst: dstFs(), remote: state.dst.remote,
        label: dstLabel(), started: Date.now(), hintBytes: plan.sendBytes, hintFiles: plan.sendCount });
    } catch (e) {
      const x = RC.explain(e);
      toast(x.title + '. ' + x.detail);
    }
  }

  async function startCheck() {
    try {
      // The files as they are now, so freeing space can refuse any file that
      // changes between this check and the delete.
      const snap = await RC.call('operations/list', { fs: state.src, remote: '', opt: { recurse: true, filesOnly: true } }, { timeout: 180000 });
      const r = await RC.call('operations/check', {
        srcFs: state.src, dstFs: dstFs(), oneWay: true,
        match: true, differ: true, missingOnDst: true, error: true,
        _async: true,
      });
      const files = snap.list || [];
      watch({ kind: 'check', id: r.jobid, exec: r.executeId, src: state.src, dst: dstFs(), remote: state.dst.remote,
        label: dstLabel(), started: Date.now(), hintBytes: files.reduce((a, f) => a + f.Size, 0),
        snap: files.map((f) => [f.Path, f.Size, f.ModTime]) });
    } catch (e) {
      const x = RC.explain(e);
      toast(x.title + '. ' + x.detail);
    }
  }

  let pollTimer = 0;
  const speeds = [];

  function watch(job) {
    state.job = job;
    store.set('job', job);
    speeds.length = 0;
    $('run').hidden = false;
    $('run-note').hidden = true;
    renderPlan(); renderVerify();
    clearTimeout(pollTimer);
    poll();
    $('run').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function poll() {
    const job = state.job;
    if (!job || job.finished) return;
    let st, stats;
    try {
      [st, stats] = await Promise.all([
        RC.call('job/status', { jobid: job.id }),
        RC.call('core/stats', { group: 'job/' + job.id }),
      ]);
    } catch (e) {
      if (e.status && /job not found/i.test(e.message)) { forget(); return; }
      pollTimer = setTimeout(poll, 2000);   // server gone for now; heartbeat says so
      return;
    }
    if (job.kind === 'copy' && job.remote && remoteOf(job.remote) && remoteOf(job.remote).type === 'drive') {
      addToday(job.remote, (stats.bytes || 0) - (job.seen || 0));
      job.seen = stats.bytes || 0;
      store.set('job', job);
    }
    renderRun(job, st, stats);
    if (st.finished) { finish(job, st, stats); return; }
    pollTimer = setTimeout(poll, 1000);
  }

  function renderRun(job, st, stats) {
    const copy = job.kind === 'copy';
    const stopped = st.finished && /canceled/i.test(st.error || '');
    $('run-h').textContent = !st.finished
      ? (copy ? 'Uploading to ' + job.label : 'Checking against ' + job.label)
      : (copy ? 'Upload ' : 'Check ') + (stopped ? 'stopped' : st.success ? 'finished' : 'failed');
    $('btn-stop').hidden = !!st.finished;

    const bar = $('run-bar');
    const fill = $('run-fill');
    let frac;
    if (copy) {
      const total = Math.max(stats.totalBytes || 0, job.hintBytes || 0);
      frac = total ? (stats.bytes || 0) / total : 0;
      $('run-done').textContent = Fmt.bytes(stats.bytes || 0);
      $('run-of').textContent = 'of ' + Fmt.bytes(total);
      $('run-speed').textContent = Fmt.speed(stats.speed);
      $('run-mbit').textContent = Fmt.mbit(stats.speed) || 'speed';
      const eta = stats.eta != null ? stats.eta : stats.speed > 0 ? (total - stats.bytes) / stats.speed : null;
      $('run-eta').textContent = st.finished ? Fmt.duration(st.duration) : Fmt.duration(eta);
      $('run-eta-l').textContent = st.finished ? 'took' : 'left';
      $('run-files').textContent = (stats.transfers || 0).toLocaleString() + ' / ' + Math.max(stats.totalTransfers || 0, job.hintFiles || 0).toLocaleString();
      $('run-files-l').textContent = 'files';
      if (!st.finished) { speeds.push(stats.speed || 0); if (speeds.length > 180) speeds.shift(); }
    } else {
      const total = stats.totalChecks || 0;
      frac = total ? (stats.checks || 0) / total : 0;
      $('run-done').textContent = (stats.checks || 0).toLocaleString();
      $('run-of').textContent = 'of ' + (total ? total.toLocaleString() : '…') + ' checked';
      // rclone does not count the bytes it reads to hash local files, so show
      // how much is being compared instead.
      $('run-speed').textContent = Fmt.bytes(job.hintBytes || 0);
      $('run-mbit').textContent = 'compared';
      $('run-eta').textContent = Fmt.duration(st.finished ? st.duration : stats.elapsedTime);
      $('run-eta-l').textContent = st.finished ? 'took' : 'so far';
      $('run-files').textContent = (stats.errors || 0).toLocaleString();
      $('run-files-l').textContent = 'problems';
    }
    const known = frac > 0 || st.finished;
    bar.classList.toggle('busy', !known);
    bar.classList.toggle('done', !!st.finished && !!st.success);
    bar.classList.toggle('failed', !!st.finished && !st.success);
    fill.style.transform = known ? 'scaleX(' + (st.finished && st.success ? 1 : Math.min(1, frac)) + ')' : '';
    bar.setAttribute('aria-valuenow', String(Math.round(frac * 100)));

    // speed over the last few minutes
    const line = $('run-spark').firstElementChild;
    // SVG elements have no `hidden` property, only the attribute.
    $('run-spark').toggleAttribute('hidden', !copy || speeds.length < 2);
    if (copy && speeds.length > 1) {
      const max = Math.max(...speeds) || 1;
      line.setAttribute('points', speeds.map((v, i) => (i / (speeds.length - 1) * 300).toFixed(1) + ',' + (34 - v / max * 32).toFixed(1)).join(' '));
    }

    const list = $('run-xfers');
    const items = (copy ? stats.transferring : stats.checking) || [];
    list.replaceChildren(...(st.finished ? [] : items.slice(0, 8).map((t) => {
      if (!copy || typeof t === 'string') return el('li', null, el('span', { class: 'n', text: typeof t === 'string' ? t : t.name }), el('span', { class: 'r', text: 'checking' }));
      const mini = el('i');
      mini.style.transform = 'scaleX(' + ((t.percentage || 0) / 100) + ')';
      return el('li', null,
        el('span', { class: 'n', text: t.name }),
        el('span', { class: 'r', text: (t.percentage || 0) + '% of ' + Fmt.bytes(t.size) + (t.speed ? ' · ' + Fmt.speed(t.speed) : '') }),
        el('span', { class: 'mini' }, mini));
    })));

    // problems while still running: the latest one, explained
    const note = $('run-note');
    if (!st.finished && stats.errors && stats.lastError) {
      const x = RC.explain(stats.lastError);
      note.replaceWith(Object.assign(noteBox('warn', x.title, x.detail + ' (' + Fmt.count(stats.errors, 'problem') + ' so far)'), { id: 'run-note' }));
    } else if (!st.finished) {
      note.hidden = true;
    }
  }

  function finish(job, st, stats) {
    job.finished = true;
    store.set('job', null);
    const copy = job.kind === 'copy';
    const out = st.output || {};
    let ok = !!st.success;
    let note;
    if (copy) {
      if (ok && stats.errors) ok = false;
      if (ok) {
        note = noteBox('ok', 'All uploaded',
          Fmt.count(stats.transfers || 0, 'file') + ', ' + Fmt.bytes(stats.bytes || 0) + ' in ' + Fmt.duration(st.duration) + '. Check the copies next, then you can free up the space.');
      } else {
        const x = RC.explain(st.error || stats.lastError || 'unknown');
        note = noteBox(/canceled/i.test(st.error || '') ? 'warn' : 'bad', x.title, x.detail);
      }
      addHistory({ kind: 'copy', ok, src: job.src, dst: job.label, bytes: stats.bytes || 0, files: stats.transfers || 0,
        secs: st.duration || 0, err: ok ? '' : RC.explain(st.error || stats.lastError || '').title });
      aboutCache.delete(job.remote);
      setDest(state.dst.remote, state.dst.path);
    } else {
      if (!st.success) {
        const x = RC.explain(st.error || 'unknown');
        note = noteBox('bad', x.title, x.detail);
      } else {
        // With no hash in common rclone compares sizes only and reports the
        // hash as the word "none", which must not read as a real checksum.
        const hash = out.hashType && out.hashType !== 'none' ? out.hashType : '';
        const result = {
          key: job.src + '\n' + job.dst, at: Date.now(), hash,
          match: out.match || [], differ: out.differ || [], missing: out.missingOnDst || [], errors: out.error || [],
          snap: job.snap || [],
        };
        store.set('check', result);
        loadCheck();
        ok = !result.differ.length && !result.missing.length && !result.errors.length;
        note = ok && result.hash
          ? noteBox('ok', 'Every file matches', Fmt.count(result.match.length, 'file') + ' compared by ' + result.hash.toUpperCase() + ' checksum.')
          : ok
          ? noteBox('warn', 'The sizes match', 'This cloud and your disk have no checksum in common, so only sizes could be compared. That is not proof the contents are the same.')
          : noteBox('warn', 'Some files do not match', 'See below. Uploading again sends whatever is missing or different.');
        addHistory({ kind: 'check', ok, src: job.src, dst: job.label, files: result.match.length, secs: st.duration || 0,
          err: ok ? '' : (result.differ.length + result.missing.length + result.errors.length) + ' not matching' });
      }
      $('verify').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    note.id = 'run-note';
    $('run-note').replaceWith(note);
    renderPlan(); renderVerify();
  }

  function forget() {
    store.set('job', null);
    state.job = null;
    $('run').hidden = true;
    renderPlan(); renderVerify();
  }

  async function stopJob() {
    const job = state.job;
    if (!job || job.finished) return;
    if (job.kind === 'copy' && !await ask('Stop the upload?', 'Files already uploaded stay in the cloud. Starting again later skips them and carries on.', 'Stop')) return;
    try { await RC.call('job/stop', { jobid: job.id }); } catch (e) { toast(RC.explain(e).title); }
  }

  // A job keeps running in rclone when the page is closed. Pick it back up.
  async function resume() {
    const saved = store.get('job', null);
    if (!saved) return;
    try {
      const list = await RC.call('job/list');
      if (list.executeId !== saved.exec || !(list.jobids || []).includes(saved.id)) { store.set('job', null); return; }
      watch(saved);
    } catch (e) { /* server just started; nothing to resume */ }
  }

  // ---- verify and free up space ------------------------------------------

  function loadCheck() {
    const c = store.get('check', null);
    state.check = c && c.key === pairKey() ? c : null;
  }

  // Where a destination's files physically are, when they are on this
  // computer. Deleting the source is only safe when the copy is elsewhere.
  function localHome(remoteName, path, depth) {
    const r = remoteOf(remoteName);
    if (!r || depth > 3) return { unsure: true };
    if (r.type === 'local') return { path: path };
    if (r.type === 'alias') {
      const t = r.target;
      const m = /^([^:\\/]{2,}):(.*)$/.exec(t);   // another remote ("drive:x"), not "C:\x"
      const joined = (p, q) => q ? p.replace(/[\\/]+$/, '') + '/' + q : p;
      if (m) return localHome(m[1], joined(m[2], path), (depth || 0) + 1);
      return { path: joined(t, path) };
    }
    if (WRAPPERS.has(r.type)) return { unsure: true };
    return {};   // a real cloud
  }

  function freeBlocker() {
    const c = state.check;
    if (!c || !c.match.length) return 'Check the copies first.';
    if (!c.hash || c.hash === 'none') return 'This cloud and your disk share no checksum, so the copies could only be compared by size. Decant only frees space when every byte has been compared.';
    const home = localHome(state.dst.remote, state.dst.path, 0);
    if (home.unsure) return 'Decant cannot tell where this remote keeps its files, so it will not delete anything for it.';
    if (home.path != null) {
      const norm = (p) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() + '\\';
      const a = norm(state.src), b = norm(home.path);
      if (a.startsWith(b) || b.startsWith(a)) return 'The copy is inside the same folder, so there is nothing to free.';
      if (/^[a-z]:/.test(a) && a.slice(0, 2) === b.slice(0, 2)) return 'The copy is on the same disk, so deleting the originals would not free any space.';
    }
    return '';
  }

  function renderVerify() {
    const body = $('verify-body');
    const c = state.check;
    const ready = state.online && state.src && state.dst.remote && !state.srcErr && !state.dstErr && state.srcFiles && state.srcFiles.length;
    const busy = !!state.job && !state.job.finished;
    $('btn-verify').disabled = !ready || busy;
    $('btn-free').disabled = busy || !state.online || !!freeBlocker();
    if (!c) { body.replaceChildren(); return; }
    const list = (items) => el('ul', null, items.slice(0, 300).map((p) => el('li', { text: p })));
    const hashed = c.hash && c.hash !== 'none';
    const rows = [
      el('div', { class: 'row' },
        el('span', { class: 'badge ' + (hashed ? 'there' : 'differs'), text: (hashed ? '✓ ' : '') + c.match.length.toLocaleString() + (hashed ? ' match' : ' same size') }),
        el('span', { class: 'muted', text: 'Checked ' + Fmt.ago(c.at) + (hashed ? ', by ' + c.hash.toUpperCase() + ' checksum' : ', by size only') })),
    ];
    if (c.differ.length) rows.push(el('details', null, el('summary', null, el('span', { class: 'badge bad', text: c.differ.length + ' differ' }), ' the cloud copy is not the same'), list(c.differ)));
    if (c.missing.length) rows.push(el('details', null, el('summary', null, el('span', { class: 'badge differs', text: c.missing.length + ' missing' }), ' not in the cloud yet'), list(c.missing)));
    if (c.errors.length) rows.push(el('details', null, el('summary', null, el('span', { class: 'badge bad', text: c.errors.length + ' could not be read' })), list(c.errors)));
    const block = freeBlocker();
    if (block && c.match.length) rows.push(el('p', { class: 'muted', text: block }));
    body.replaceChildren(el('div', { class: 'result' }, rows));
  }

  function openFree() {
    const c = state.check;
    if (!c || freeBlocker()) return;
    const sizes = new Map((state.srcFiles || []).map((f) => [f.path, f.size]));
    const items = c.match.filter((p) => sizes.has(p)).map((p) => ({ path: p, size: sizes.get(p) }))
      .sort((a, b) => b.size - a.size);
    const dlg = $('dlg-free');
    const listEl = $('free-list');
    listEl.replaceChildren(...items.map((it) => el('li', null,
      el('label', null, el('input', { type: 'checkbox', checked: true, 'data-path': it.path, 'data-size': String(it.size) }), el('span', { text: it.path })),
      el('span', { class: 's', text: Fmt.bytes(it.size) }),
      el('span', { class: 'st' }))));
    $('free-lead').textContent = 'These files are in ' + c.key.split('\n')[1] + ' and match their copies exactly. Remove them from ' + state.src + '?';
    $('free-mode').hidden = !RC.desktop;
    $('free-ok').checked = false;
    $('free-all').checked = true;
    $('free-progress').hidden = true;
    $('free-cancel').textContent = 'Cancel';
    const update = () => {
      const bin = freeMode() === 'bin';
      const picked = [...listEl.querySelectorAll('input:checked')];
      const bytes = picked.reduce((a, i) => a + +i.dataset.size, 0);
      $('free-total').textContent = Fmt.count(picked.length, 'file') + (bin ? ', ' + Fmt.bytes(bytes) + ' to the Recycle Bin' : ', frees ' + Fmt.bytes(bytes));
      $('free-warn').textContent = (bin
        ? 'They move to the Recycle Bin, so they can be restored. The space comes back once you empty it.'
        : 'They are deleted for good and do not go to the Recycle Bin.') +
        ' The cloud copies stay as they are. Any file that has changed since it was checked (' + Fmt.ago(c.at) + ') is skipped.';
      $('free-ok-text').textContent = bin
        ? 'I understand these files are removed from this computer'
        : 'I understand these files are deleted from this computer for good';
      const verb = bin ? 'Move ' : 'Delete ';
      $('free-go').textContent = picked.length ? verb + Fmt.count(picked.length, 'file') : verb.trim();
      $('free-go').disabled = !picked.length || !$('free-ok').checked || dlg.dataset.busy === '1';
    };
    listEl.onchange = update;
    $('free-ok').onchange = update;
    for (const r of document.querySelectorAll('input[name="free-mode"]')) r.onchange = update;
    $('free-all').onchange = () => { for (const i of listEl.querySelectorAll('input')) i.checked = $('free-all').checked; update(); };
    dlg.dataset.busy = '';
    update();
    dlg.showModal();
  }

  // In the desktop app freed files go to the Recycle Bin unless the dialog
  // says otherwise. The browser version can only delete outright.
  function freeMode() {
    if (!RC.desktop) return 'permanent';
    const r = document.querySelector('input[name="free-mode"]:checked');
    return r ? r.value : 'bin';
  }

  async function doFree() {
    const dlg = $('dlg-free');
    const c = state.check;
    const picked = [...$('free-list').querySelectorAll('input:checked')];
    if (!picked.length || !$('free-ok').checked || !c) return;
    const bin = freeMode() === 'bin';
    dlg.dataset.busy = '1';
    $('free-go').disabled = true;
    for (const i of $('free-list').querySelectorAll('input')) i.disabled = true;
    for (const r of document.querySelectorAll('input[name="free-mode"]')) r.disabled = true;
    $('free-all').disabled = true; $('free-ok').disabled = true;
    $('free-cancel').disabled = true; $('free-x').disabled = true;
    $('free-progress').hidden = false;
    const snap = new Map(c.snap.map(([p, size, mod]) => [p, { size, mod }]));
    let freed = 0, done = 0, skipped = 0, failed = 0;
    for (const box of picked) {
      const path = box.dataset.path;
      const st = box.closest('li').querySelector('.st');
      try {
        // Same size and time as when it was checked, or it is not touched.
        const now = await RC.call('operations/stat', { fs: state.src, remote: path });
        const was = snap.get(path);
        const item = now && now.item;
        if (!item || !was || item.Size !== was.size || item.ModTime !== was.mod) {
          skipped++; st.textContent = 'changed, kept'; st.className = 'st badge differs';
        } else {
          if (RC.desktop) await RC.free(state.src, path, !bin);
          else await RC.call('operations/deletefile', { fs: state.src, remote: path });
          done++; freed += item.Size; st.textContent = bin ? 'in Recycle Bin' : 'deleted'; st.className = 'st badge there';
        }
      } catch (e) {
        failed++; st.textContent = RC.explain(e).title; st.className = 'st badge bad';
      }
      $('free-fill').style.transform = 'scaleX(' + ((done + skipped + failed) / picked.length) + ')';
      $('free-status').textContent = (bin ? 'Moved ' : 'Freed ') + Fmt.bytes(freed) + ' · ' + (done + skipped + failed) + ' of ' + picked.length;
    }
    dlg.dataset.busy = '';
    $('free-all').disabled = false; $('free-ok').disabled = false;
    $('free-cancel').disabled = false; $('free-x').disabled = false;
    for (const r of document.querySelectorAll('input[name="free-mode"]')) r.disabled = false;
    $('free-cancel').textContent = 'Close';
    addHistory({ kind: 'free', bin, ok: !failed, src: state.src, dst: dstLabel(), bytes: freed, files: done,
      err: failed ? failed + ' could not be removed' : skipped ? skipped + ' changed and were kept' : '' });
    // What was removed cannot be freed again, and what changed needs checking
    // again before it can be.
    const gone = new Set(picked.filter((b) => /deleted|Recycle Bin|changed/.test(b.closest('li').querySelector('.st').textContent)).map((b) => b.dataset.path));
    c.match = c.match.filter((p) => !gone.has(p));
    store.set('check', c);
    toast(bin ? 'Moved ' + Fmt.bytes(freed) + ' to the Recycle Bin. Empty it to get the space back.' : 'Freed ' + Fmt.bytes(freed) + ' on this computer.');
    setSource(state.src);
  }

  // ---- history -------------------------------------------------------------

  function addHistory(entry) {
    const list = store.get('history', []);
    list.unshift(Object.assign({ at: Date.now() }, entry));
    store.set('history', list.slice(0, 30));
    renderHistory();
  }

  function renderHistory() {
    const list = store.get('history', []);
    $('history').hidden = !list.length;
    const verb = { copy: 'Uploaded', check: 'Checked', free: 'Freed' };
    $('hist-list').replaceChildren(...list.slice(0, 10).map((h) => {
      const what = h.kind === 'check'
        ? Fmt.count(h.files || 0, 'file') + ' against ' + h.dst
        : h.kind === 'free'
          ? Fmt.bytes(h.bytes) + ' from ' + Fmt.base(h.src) + (h.bin ? ' to the Recycle Bin' : '') + ' (' + Fmt.count(h.files || 0, 'file') + ')'
          : Fmt.bytes(h.bytes) + ' from ' + Fmt.base(h.src) + ' to ' + h.dst + (h.secs ? ' in ' + Fmt.duration(h.secs) : '');
      const word = h.kind === 'free' && h.bin ? 'Moved' : verb[h.kind];
      return el('li', null,
        el('span', { class: 'i ' + (h.ok ? 'ok' : 'bad'), text: h.ok ? '✓' : '!' }),
        el('span', { class: 'w', text: word + ' ' + what + (h.err ? ' · ' + h.err : '') }),
        el('span', { class: 't', text: Fmt.ago(h.at) }));
    }));
  }

  // ---- folder browser --------------------------------------------------------

  // One dialog for both sides. Local folders are listed through rclone too,
  // since a web page cannot see real paths on disk.
  const browse = { side: 'src', remote: '', path: '', seq: 0 };
  const isWin = () => /windows/i.test(state.os);

  function openBrowse(side) {
    browse.side = side;
    if (side === 'src') {
      browse.remote = '';
      browse.path = state.src || '';
      $('browse-h').textContent = 'Choose a folder on this computer';
    } else {
      browse.remote = state.dst.remote;
      browse.path = state.dst.path;
      $('browse-h').textContent = 'Choose a folder in ' + browse.remote;
    }
    const d = $('dlg-browse');
    d.returnValue = '';
    d.showModal();
    showDir();
  }

  const splitLocal = (p) => {
    if (!p) return [];
    if (isWin()) { const parts = p.split(/[\\/]+/).filter(Boolean); if (parts[0]) parts[0] = parts[0].toUpperCase(); return parts; }
    return p.split('/').filter(Boolean);
  };
  const joinLocal = (parts) => !parts.length ? '' : isWin() ? (parts.length === 1 ? parts[0] + '\\' : parts.join('\\')) : '/' + parts.join('/');

  async function showDir() {
    const seq = ++browse.seq;
    const local = browse.side === 'src';
    const list = $('browse-list');
    const crumbs = $('browse-crumbs');
    const parts = local ? splitLocal(browse.path) : browse.path.split('/').filter(Boolean);

    crumbs.replaceChildren();
    const rootName = local ? (isWin() ? 'This PC' : '/') : browse.remote + ':';
    const go = (n) => () => { browse.path = local ? joinLocal(parts.slice(0, n)) : parts.slice(0, n).join('/'); showDir(); };
    crumbs.append(el('button', { type: 'button', text: rootName, onclick: go(0) }));
    parts.forEach((p, i) => crumbs.append(el('span', { text: '›' }), el('button', { type: 'button', text: p, onclick: go(i + 1) })));

    $('browse-pick').disabled = local && isWin() && !parts.length;
    $('browse-note').textContent = '';
    list.replaceChildren(el('li', null, el('div', { class: 'msg', text: 'Loading…' })));

    try {
      let rows;
      if (local && isWin() && !parts.length) {
        rows = await drives();
      } else {
        const fs = local ? (browse.path || '/') : browse.remote + ':' + browse.path;
        const r = await RC.call('operations/list', { fs, remote: '', opt: { dirsOnly: true } }, { timeout: 60000 });
        rows = (r.list || [])
          .filter((d) => !(local && isWin() && (/^\$/.test(d.Name) || d.Name === 'System Volume Information')))
          .sort((a, b) => a.Name.localeCompare(b.Name, undefined, { numeric: true, sensitivity: 'base' }))
          .map((d) => ({ name: d.Name, icon: FOLDER, open: () => { browse.path = local ? joinLocal(parts.concat(d.Name)) : parts.concat(d.Name).join('/'); showDir(); } }));
      }
      if (seq !== browse.seq) return;
      list.replaceChildren(...(rows.length ? rows.map((r) => el('li', null,
        el('button', { type: 'button', onclick: r.open }, svg(r.icon), el('span', { text: r.name }), r.sub ? el('span', { class: 'sub', text: r.sub }) : null)))
        : [el('li', null, el('div', { class: 'msg', text: 'No folders in here.' }))]));
    } catch (e) {
      if (seq !== browse.seq) return;
      // A path typed by hand that does not exist: open the nearest one that does.
      if (/directory not found|cannot find/i.test(e.message) && parts.length > (local ? 1 : 0)) {
        browse.path = local ? joinLocal(parts.slice(0, -1)) : parts.slice(0, -1).join('/');
        showDir();
        return;
      }
      $('browse-pick').disabled = true;
      const x = RC.explain(e);
      list.replaceChildren(el('li', null, el('div', { class: 'msg', text: x.title + '.' })));
    }
  }

  // Drive letters, found by asking each one for its free space.
  async function drives() {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const found = await Promise.all(letters.map(async (l) => {
      try { const r = await RC.call('core/du', { dir: l + ':\\' }, { timeout: 5000 }); return { l, info: r.info }; }
      catch (e) { return null; }
    }));
    return found.filter(Boolean).map(({ l, info }) => ({
      name: l + ':', icon: DISK, sub: Fmt.bytes(info.Available != null ? info.Available : info.Free) + ' free of ' + Fmt.bytes(info.Total),
      open: () => { browse.path = l + ':\\'; showDir(); },
    }));
  }

  // ---- wiring ----------------------------------------------------------------

  function renderAll() {
    renderSource(); renderDest(); renderPlan(); renderVerify(); renderHistory();
  }

  function wire() {
    const srcIn = $('src-path');
    srcIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') setSource(srcIn.value); });
    srcIn.addEventListener('change', () => { if (srcIn.value.trim() !== state.src) setSource(srcIn.value); });
    $('src-browse').addEventListener('click', () => openBrowse('src'));

    $('dst-remote').addEventListener('change', (e) => setDest(e.target.value, ''));
    const dstIn = $('dst-path');
    dstIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') setDest(state.dst.remote, dstIn.value); });
    dstIn.addEventListener('change', () => setDest(state.dst.remote, dstIn.value));
    $('dst-browse').addEventListener('click', () => { if (state.dst.remote) openBrowse('dst'); });

    $('dlg-browse').addEventListener('close', () => {
      if ($('dlg-browse').returnValue !== 'pick') return;
      if (browse.side === 'src') setSource(browse.path);
      else setDest(browse.remote, browse.path);
    });

    $('btn-start').addEventListener('click', startCopy);
    $('btn-stop').addEventListener('click', stopJob);
    $('btn-verify').addEventListener('click', startCheck);
    $('btn-free').addEventListener('click', openFree);
    $('free-go').addEventListener('click', doFree);
    $('dlg-free').addEventListener('cancel', (e) => { if ($('dlg-free').dataset.busy === '1') e.preventDefault(); });

    $('btn-quit').addEventListener('click', async () => {
      const running = state.job && !state.job.finished;
      const ok = await ask('Stop Decant\'s server?',
        running ? 'An upload or check is still running, and it stops too. Files already uploaded stay in the cloud.'
                : 'This page stops working until you open Decant again.', 'Stop server');
      if (!ok) return;
      try { await RC.call('core/quit', null, { timeout: 3000 }); } catch (e) { /* it is gone either way */ }
      gate('The server was stopped. Open Decant again to carry on.');
    });
    $('gate-retry').addEventListener('click', () => location.reload());

    // Polling pauses with the tab hidden would leave the numbers stale on
    // return, so catch up as soon as it is visible again.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.job && !state.job.finished) { clearTimeout(pollTimer); poll(); }
    });
  }

  async function boot() {
    if (RC.desktop) {
      // The app owns rclone's lifetime, so there is no server to stop by hand.
      $('btn-quit').hidden = true;
      $('gate-text').textContent = 'Decant could not start its copy of rclone, so it cannot do anything yet.';
      const info = await RC.info();
      if (info.error) { gate(info.error); return; }
    }
    if (!RC.has) { gate('No session from the launcher was found next to this page.'); return; }
    try {
      const v = await RC.call('core/version', null, { timeout: 4000 });
      state.version = v.version; state.os = v.os || '';
    } catch (e) {
      gate(e.status === 0 && !RC.desktop ? 'The server from the last launch is no longer running.' : RC.explain(e).detail);
      return;
    }
    $('app').hidden = false;
    setConn('ok', 'rclone ' + state.version);
    wire();
    initOptions();
    try { await loadRemotes(); } catch (e) { toast(RC.explain(e).title); }

    const savedDst = store.get('dst', null);
    const remote = savedDst && remoteOf(savedDst.remote) ? savedDst.remote : (state.remotes[0] || {}).name || '';
    renderHistory();
    await Promise.all([
      setSource(store.get('src', '')),
      setDest(remote, remote && savedDst && savedDst.remote === remote ? savedDst.path : ''),
    ]);
    await resume();
    setTimeout(heartbeat, 5000);
  }

  boot();
})();
