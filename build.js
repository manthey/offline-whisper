const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['src/main.js'],
  bundle: true,
  outfile: 'main.js',
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  external: ['obsidian'],
  minify: false,
  sourcemap: false,
}).then(() => {
  console.log(`Build complete`);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
