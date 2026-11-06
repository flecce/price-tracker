// Build for GitHub Pages: copies the site into _site/ and stamps a version (the commit hash)
// on every asset URL, so each release forces browsers to download fresh files.
//
//   node scripts/build.js            → version = GITHUB_SHA (in CI) or a timestamp
//   node scripts/build.js abc123     → explicit version
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '_site');
const VERSION = (process.argv[2] || process.env.GITHUB_SHA || Date.now().toString(36)).slice(0, 8);
const INCLUDE = ['index.html', 'manifest.webmanifest', 'sw.js', '.nojekyll', 'css', 'js', 'icons'];

fs.rmSync(OUT, { recursive: true, force: true });
for (const item of INCLUDE) fs.cpSync(path.join(ROOT, item), path.join(OUT, item), { recursive: true });

const v = (url) => `${url}?v=${VERSION}`;
function edit(rel, fn) {
  const file = path.join(OUT, rel);
  const before = fs.readFileSync(file, 'utf8');
  const after = fn(before);
  if (after === before) throw new Error(`build: nothing stamped in ${rel}`);
  fs.writeFileSync(file, after);
}

// index.html → versioned stylesheet, entry module and manifest
edit('index.html', (s) =>
  s
    .replace('href="css/styles.css"', `href="${v('css/styles.css')}"`)
    .replace('src="js/app.js"', `src="${v('js/app.js')}"`)
    .replace('href="manifest.webmanifest"', `href="${v('manifest.webmanifest')}"`)
);

// every ES module import → versioned (modules are cached by full URL)
for (const f of fs.readdirSync(path.join(OUT, 'js'))) {
  const rel = `js/${f}`;
  const src = fs.readFileSync(path.join(OUT, rel), 'utf8');
  if (/from '\.\/[\w-]+\.js'/.test(src)) edit(rel, (s) => s.replace(/from '(\.\/[\w-]+\.js)'/g, (_, p) => `from '${v(p)}'`));
}

// build id shown in Settings
edit('js/config.js', (s) => s.replace("BUILD: 'dev'", `BUILD: '${VERSION}'`));

// service worker → new cache per release + versioned shell URLs
edit('sw.js', (s) =>
  s
    .replace(/const CACHE = '[^']*'/, `const CACHE = 'pt-${VERSION}'`)
    .replace(/'((?:js|css)\/[\w-]+\.(?:js|css))'/g, (_, p) => `'${v(p)}'`)
);

console.log(`Built _site/ — version ${VERSION}`);
