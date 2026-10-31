// Regression test: mobile Obsidian evaluates the plugin bundle without a Node
// module wrapper, so any module-load-time reference to Node globals like
// __dirname crashes the plugin with "Plugin failure". The bundle is built
// exactly as the plugin ships and evaluated in a context that has require but
// deliberately no __dirname, mimicking mobile plugin loading end to end.
globalThis.require = require;

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const { execFileSync } = require('child_process');

test('the shipped plugin bundle evaluates without __dirname (mobile-style loading)', () => {
  const rootDir = path.join(__dirname, '..');
  // The embedded worker source and main.js are build outputs; produce them
  // when a build has not run yet (the desktop CI job runs jest unbuilt).
  if (!fs.existsSync(path.join(rootDir, 'main.js'))) {
    execFileSync(process.execPath, ['build.js'], { cwd: rootDir, stdio: 'pipe' });
  }
  const source = fs.readFileSync(path.join(rootDir, 'main.js'), 'utf8');
  const sandbox = {
    require: (name) => Module.createRequire(path.join(rootDir, 'main.js'))(name),
    module: { exports: {} },
    console,
    // Deliberately omitted: __dirname, __filename, process, navigator, and
    // every other global that only exists in a Node module wrapper.
  };
  expect(() => vm.runInNewContext(source, sandbox, { filename: 'main.js' })).not.toThrow();
  // esbuild may rename the export binding inside the bundle; match on the
  // class name instead of exact identity.
  expect(String(sandbox.module.exports.name)).toContain('WhisperTranscriptionPlugin');
});
