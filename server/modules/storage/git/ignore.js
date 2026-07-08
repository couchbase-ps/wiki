const fs = require('fs-extra')
const path = require('path')
const ignore = require('ignore')

const WIKIIGNORE_FILE = '.wikiignore'
// Always kept out of the wiki, regardless of .wikiignore contents.
const ALWAYS_IGNORE = ['.git', '.git/**', WIKIIGNORE_FILE]

/**
 * Build a path-ignore predicate from .wikiignore contents.
 * Operates on repo-relative POSIX paths (no leading slash).
 *
 * @param {string} wikiignoreContent Raw .wikiignore contents ('' if none)
 * @returns {(relPath: string) => boolean} true if the path must be skipped
 */
function createIgnoreMatcher (wikiignoreContent) {
  const ig = ignore().add(ALWAYS_IGNORE)
  if (wikiignoreContent) {
    ig.add(wikiignoreContent)
  }
  return (relPath) => {
    if (!relPath) { return false }
    const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!normalized) { return false }
    // Hard guarantee: these are always ignored and no user rule can negate them.
    if (normalized === WIKIIGNORE_FILE || normalized === '.git' || normalized.startsWith('.git/')) {
      return true
    }
    return ig.ignores(normalized) || ig.ignores(normalized + '/')
  }
}

/**
 * Read .wikiignore from a repo root and build the matcher.
 * Missing file → matcher that ignores only ALWAYS_IGNORE.
 *
 * @param {string} repoPath Absolute path to the git repo root
 * @returns {Promise<(relPath: string) => boolean>}
 */
async function loadIgnoreMatcher (repoPath) {
  let content = ''
  try {
    content = await fs.readFile(path.join(repoPath, WIKIIGNORE_FILE), 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') { throw err }
  }
  return createIgnoreMatcher(content)
}

module.exports = { createIgnoreMatcher, loadIgnoreMatcher, WIKIIGNORE_FILE }
