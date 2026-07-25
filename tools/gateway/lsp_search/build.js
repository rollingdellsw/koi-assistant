const esbuild = require('esbuild');
const {readFileSync} = require('fs');

// Read dependencies to externalize them (critical for tree-sitter/native
// modules)
const packageJson = JSON.parse(readFileSync('./package.json', 'utf8'));
const dependencies = Object.keys(packageJson.dependencies || {});

esbuild
    .build({
      entryPoints: ['src/index.ts', 'src/inlay-hints.ts'],
      bundle: true,
      outdir: 'dist',
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      sourcemap: true,
      minify: true,
      external: dependencies,
    })
    .then(() => console.log('✅ Built dist/index.js and dist/inlay-hints.js'))
    .catch(() => process.exit(1));
