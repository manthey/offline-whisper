const esbuild = require('esbuild');
const coverage = process.argv.includes('--coverage');

esbuild
  .build({
    entryPoints: ['src/main.js'],
    bundle: true,
    outfile: 'main.js',
    format: 'cjs',
    platform: 'browser',
    target: 'es2020',
    external: ['obsidian'],
    minify: false,
    sourcemap: coverage ? 'inline' : false,
    sourcesContent: true,
  })
  .then(() => {
    console.log(`Build complete`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
