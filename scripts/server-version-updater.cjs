// DAR-963: commit-and-tag-version updater for src/server/server.ts.
//
// commit-and-tag-version walks every entry in `bumpFiles` and either uses a
// built-in type ("json", "plain-text") or a custom `updater` module that
// exports `readVersion(contents)` and `writeVersion(contents, newVersion)`.
//
// For `src/server/server.ts` we need a scoped find/replace: ONLY the
// `SERVER_VERSION` constant should change, not any other string that
// happens to look like a version. The built-in `plain-text` updater would
// rewrite every occurrence of the current version anywhere in the file --
// brittle. A 6-line custom updater is the right shape.

const SERVER_VERSION_RE = /(export const SERVER_VERSION = ')([^']+)(';)/;

module.exports.readVersion = (contents) => {
  const m = contents.match(SERVER_VERSION_RE);
  if (!m) {
    throw new Error(
      'src/server/server.ts: could not find `export const SERVER_VERSION = ' +
        "'...';` line. The commit-and-tag-version updater regex needs to be " +
        'kept in sync with the source-of-truth declaration.',
    );
  }
  return m[2];
};

module.exports.writeVersion = (contents, version) => {
  return contents.replace(SERVER_VERSION_RE, `$1${version}$3`);
};
