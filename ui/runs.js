'use strict';
// Facts about a run and the system it runs on. No DOM in here, so it is easy to test.

const Runs = (() => {
  const isWin = (os) => !os || /windows/i.test(os);

  // What the system calls the place freed files go. The browser version does
  // not know the system until rclone answers, so it starts with Windows' word.
  function binName(os) {
    return isWin(os) ? 'Recycle Bin' : 'Trash';
  }

  // An example folder for the source box, in the shape the system uses.
  function examplePath(os) {
    if (isWin(os)) return 'E:\\Videos';
    return /darwin/i.test(os) ? '/Users/you/Movies' : '/home/you/Videos';
  }

  // How to connect a cloud before sign-in works inside the app. Installing
  // Decant does not put its copy of rclone on the command line, so the
  // command names it by its full path. The browser version uses the rclone
  // the person installed, which is on the command line.
  function connect(os, path) {
    if (!path) return { where: 'a terminal', cmd: 'rclone config' };
    if (isWin(os)) return { where: 'PowerShell', cmd: '& "' + path + '" config' };
    return { where: 'a terminal', cmd: (path === '/usr/bin/decant-rclone' ? 'decant-rclone' : '"' + path + '"') + ' config' };
  }

  // What an upload really added to the cloud: the files now there at the same
  // size as on this computer, less those that already were before it started.
  // rclone's own byte count includes every byte it had to send again.
  function arrived(src, dst, before) {
    const there = new Map(dst.map((f) => [f.path, f.size]));
    let files = 0, bytes = 0;
    for (const f of src) if (there.get(f.path) === f.size) { files++; bytes += f.size; }
    return { files: Math.max(0, files - before.files), bytes: Math.max(0, bytes - before.bytes) };
  }

  // rclone sends a file again by itself when the cloud asks it to, and a
  // retry is not an error until rclone gives up, so it never shows in the
  // error count. Two signs give it away: more bytes sent since the last file
  // finished than the files in flight hold, or every file in flight sitting
  // at 100% with none finishing for a minute. `memo` carries state between
  // polls; the warning stays until the next file finishes.
  function retrying(memo, stats, now) {
    const done = stats.transfers || 0, sent = stats.bytes || 0;
    if (memo.done !== done) { memo.done = done; memo.at = now; memo.sent = sent; memo.seen = false; }
    const flying = stats.transferring || [];
    const holds = flying.reduce((a, t) => a + (t.size || 0), 0);
    const resent = flying.length > 0 && sent - memo.sent > holds * 1.05 + 1024 ** 2;
    const stuck = flying.length > 0 && flying.every((t) => (t.percentage || 0) >= 99) && now - memo.at >= 60000;
    if (resent || stuck) memo.seen = true;
    return memo.seen;
  }

  return { binName, examplePath, connect, arrived, retrying };
})();
