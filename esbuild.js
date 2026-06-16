const esbuild = require('esbuild');
const fs = require('fs');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Two build targets:
 *  - extension host: Node/CJS bundle at dist/extension.js. `vscode` and the
 *    native/data-backed packages stay external (shipped in node_modules).
 *  - webview: a browser/IIFE bundle at media/webview.js (Toast UI editor, etc.).
 *    Only built once src/webview/main.ts exists (added in the WYSIWYG milestone).
 */
async function main() {
  const extensionCtx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    external: ['vscode', 'nspell', 'dictionary-en', 'wordpos', 'docx', 'pdfkit'],
    sourcemap: !production,
    minify: production,
    logLevel: 'info'
  });

  const contexts = [extensionCtx];

  if (fs.existsSync('src/webview/main.ts')) {
    const webviewCtx = await esbuild.context({
      entryPoints: ['src/webview/main.ts'],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2020',
      outfile: 'media/webview.js',
      sourcemap: !production,
      minify: production,
      logLevel: 'info'
    });
    contexts.push(webviewCtx);
  }

  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
    console.log('[esbuild] watching…');
  } else {
    await Promise.all(contexts.map((c) => c.rebuild()));
    await Promise.all(contexts.map((c) => c.dispose()));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
