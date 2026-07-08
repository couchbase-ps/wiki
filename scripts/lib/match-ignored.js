'use strict'

/**
 * Parse .wikiignore into wiki-page-path matchers.
 *
 * Wiki page paths are lowercased with the leading dot and extension stripped
 * (server/helpers/page.js getPagePath). So `.github/` → pages under `github/`,
 * and `AGENTS.md` → the page path `agents`. Only directory rules and top-level
 * *.md file rules map to *pages*; asset-only rules (.DS_Store, *.csv) are
 * skipped here — assets are handled by the git-storage skip, not this script.
 *
 * Glob patterns (`*`, `?`, `[`) and negations (`!...`) are NOT honored — only
 * plain directory rules and plain top-level `*.md` file rules are matched.
 * Such lines are reported back in `unsupported` so callers can warn instead
 * of silently mis-handling them.
 *
 * @param {string} content Raw .wikiignore contents
 * @returns {{ dirPrefixes: string[], fileStems: string[], unsupported: string[] }}
 */
function parseWikiignore (content) {
  const dirPrefixes = []
  const fileStems = []
  const unsupported = []
  for (const raw of String(content).split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) { continue }
    if (line.startsWith('!') || /[*?[]/.test(line)) {
      unsupported.push(line)
      continue
    }
    const noSlash = line.replace(/\/+$/, '')
    const base = noSlash.split('/').pop()
    const isDir = line.endsWith('/') || !base.includes('.') // dotless basename = dir
    const stem = noSlash.replace(/^\.+/, '').toLowerCase() // strip leading dots
    if (!stem) { continue }
    if (isDir) {
      dirPrefixes.push(stem) // directory rule
    } else if (stem.endsWith('.md')) {
      fileStems.push(stem.replace(/\.md$/, '')) // top-level markdown page
    }
    // other file rules (.DS_Store, .gitignore, *.csv, *.sh) → assets, skipped
  }
  return { dirPrefixes, fileStems, unsupported }
}

/**
 * @param {string} content Raw .wikiignore contents
 * @returns {(pagePath: string) => boolean}
 */
function createPageMatcher (content) {
  const { dirPrefixes, fileStems } = parseWikiignore(content)
  return (pagePath) => {
    const p = String(pagePath).toLowerCase().replace(/^\/+/, '')
    if (fileStems.includes(p)) { return true }
    return dirPrefixes.some(prefix => p === prefix || p.startsWith(prefix + '/'))
  }
}

module.exports = { parseWikiignore, createPageMatcher }
