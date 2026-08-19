// Records which npm packages the renderer bundle actually contains.
//
// The rollup module graph is the one authority that sees every way a package
// can enter the bundle — direct imports, deep imports, CSS `@import`, asset
// url() chains — so the licensing and audit closure is checked against this
// file instead of trusting a hand-maintained list to stay complete. The JSON
// ships inside `dist-renderer`, which lets the release verifier judge the
// packaged artifact by the artifact's own record.
export function bundledNpmPackagesPlugin() {
  return {
    name: 'maka-bundled-npm-packages',
    apply: 'build',
    generateBundle(_options, bundle) {
      const packages = new Set();
      const collect = (id) => {
        // Virtual modules (\0-prefixed) are build-tool internals, not packages.
        if (typeof id !== 'string' || id.startsWith('\0')) return;
        // The last node_modules segment names the package that owns the file,
        // even for nested installs (node_modules/a/node_modules/b/...).
        const matches = [...id.matchAll(/[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)(?=[\\/])/g)];
        if (matches.length === 0) return;
        const name = matches[matches.length - 1][1].replaceAll('\\', '/');
        if (name === '.vite') return;
        packages.add(name);
      };
      for (const id of this.getModuleIds()) collect(id);
      // CSS `@import` chains are inlined by the CSS pipeline and never become
      // rollup modules, but the files they pull in (fonts, images) are emitted
      // as assets that remember their source paths — that is how a package
      // reachable only through CSS (Fontsource) still lands in this record.
      for (const output of Object.values(bundle)) {
        if (output.type !== 'asset') continue;
        for (const original of output.originalFileNames ?? []) collect(original);
      }
      this.emitFile({
        type: 'asset',
        fileName: 'bundled-npm-packages.json',
        source: `${JSON.stringify([...packages].sort(), null, 2)}\n`,
      });
    },
  };
}
