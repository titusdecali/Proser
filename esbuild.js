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
    external: ['vscode', 'nspell', 'dictionary-en', 'dictionary-en-gb', 'wordpos', 'docx', 'pdfkit'],
    sourcemap: !production,
    minify: production,
    logLevel: 'info'
  });

  const contexts = [extensionCtx];

  // Browser/IIFE bundles for each webview. Each entry maps to a media/*.js file.
  const webviewEntries = [
    { src: 'src/webview/main.ts', out: 'media/webview.js' },
    { src: 'src/webview/manuscriptPanel.ts', out: 'media/manuscript.js' },
    { src: 'src/webview/spellingPanel.ts', out: 'media/spelling.js' }
  ];
  for (const { src, out } of webviewEntries) {
    if (fs.existsSync(src)) {
      const ctx = await esbuild.context({
        entryPoints: [src],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: 'es2020',
        outfile: out,
        sourcemap: !production,
        minify: production,
        logLevel: 'info'
      });
      contexts.push(ctx);
    }
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
