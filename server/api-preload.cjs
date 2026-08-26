// Runtime polyfills for upstream KuGou API without modifying upstream source files
try {
  const path = require('path');
  const fs = require('fs');

  const possiblePaths = [
    path.join(__dirname, '../../MoeKoeMusic/api/util/util.js'),
    path.join(__dirname, '../../KuGouMusicApi/util/util.js'),
    path.join(process.cwd(), 'api/util/util.js'),
    path.join(process.cwd(), 'util/util.js')
  ];

  let utilFound = false;
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      const util = require(p);
      if (util && typeof util.generateWebGLHash === 'function') {
        global.generateWebGLHash = util.generateWebGLHash;
        utilFound = true;
        break;
      }
    }
  }

  if (!utilFound) {
    const crypto = require('crypto');
    global.generateWebGLHash = () => crypto.randomBytes(8).toString('hex');
  }
} catch (_err) {
  // best-effort
}
