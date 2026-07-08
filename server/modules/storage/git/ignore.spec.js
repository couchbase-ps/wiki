const { createIgnoreMatcher } = require('./ignore')

describe('createIgnoreMatcher', () => {
  const wikiignore = ['.github/', 'system/', 'docs/', 'AGENTS.md'].join('\n')
  const isIgnored = createIgnoreMatcher(wikiignore)

  test('ignores files under a denied directory', () => {
    expect(isIgnored('.github/skills/foo.md')).toBe(true)
    expect(isIgnored('system/prompts/bar.md')).toBe(true)
  })

  test('ignores the denied directory itself', () => {
    expect(isIgnored('system')).toBe(true)
  })

  test('ignores a denied top-level file', () => {
    expect(isIgnored('AGENTS.md')).toBe(true)
  })

  test('does not ignore public content', () => {
    expect(isIgnored('clients/acme/2024-01-01.md')).toBe(false)
    expect(isIgnored('wiki/server/backup.md')).toBe(false)
    expect(isIgnored('home.md')).toBe(false)
  })

  test('always ignores .git and .wikiignore even with empty rules', () => {
    const noRules = createIgnoreMatcher('')
    expect(noRules('.git/config')).toBe(true)
    expect(noRules('.wikiignore')).toBe(true)
  })

  test('empty .wikiignore ignores nothing else', () => {
    const noRules = createIgnoreMatcher('')
    expect(noRules('system/prompts/bar.md')).toBe(false)
    expect(noRules('AGENTS.md')).toBe(false)
  })

  test('normalizes windows separators and leading slashes', () => {
    expect(isIgnored('system\\prompts\\bar.md')).toBe(true)
    expect(isIgnored('/system/prompts/bar.md')).toBe(true)
  })

  test('supports gitignore negation', () => {
    const ig = createIgnoreMatcher(['*.tmp', '!keep.tmp'].join('\n'))
    expect(ig('keep.tmp')).toBe(false)
    expect(ig('scratch.tmp')).toBe(true)
  })

  test('always-ignore cannot be negated by .wikiignore content', () => {
    const ig = createIgnoreMatcher(['!.wikiignore', '!.git', '!.git/**'].join('\n'))
    expect(ig('.wikiignore')).toBe(true)
    expect(ig('.git')).toBe(true)
    expect(ig('.git/config')).toBe(true)
  })
})
