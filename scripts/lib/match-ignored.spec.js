const { createPageMatcher } = require('./match-ignored')

const content = ['.github/', 'system/', 'docs/', 'AGENTS.md', '.gitignore', '.DS_Store'].join('\n')
const match = createPageMatcher(content)

test('matches pages under dot-stripped internal dirs', () => {
  expect(match('github/skills/foo')).toBe(true)
  expect(match('system/prompts/bar')).toBe(true)
  expect(match('docs/whatever')).toBe(true)
})
test('matches the AGENTS page (extension stripped, lowercased)', () => {
  expect(match('agents')).toBe(true)
})
test('is case-insensitive', () => {
  expect(match('System/Prompts/Bar')).toBe(true)
})
test('leaves public pages alone', () => {
  expect(match('clients/acme/2024-01-01')).toBe(false)
  expect(match('wiki/server/backup')).toBe(false)
  expect(match('home')).toBe(false)
})
test('does not match a partial path segment', () => {
  expect(match('systematic/notes')).toBe(false)
})
test('asset-only dotfile rules do not produce page matches', () => {
  expect(match('gitignore')).toBe(false)
  expect(match('ds_store')).toBe(false)
})

const { parseWikiignore } = require('./match-ignored')
test('flags glob and negation patterns as unsupported', () => {
  const p = parseWikiignore(['system/', 'ps-reports-review-baseline*.md', '!keep.md', 'AGENTS.md'].join('\n'))
  expect(p.unsupported).toContain('ps-reports-review-baseline*.md')
  expect(p.unsupported).toContain('!keep.md')
  expect(p.unsupported).not.toContain('system/')
  expect(p.unsupported).not.toContain('AGENTS.md')
})
