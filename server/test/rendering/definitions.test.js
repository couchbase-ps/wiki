const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

// Wiki.js loads every rendering module's definition.yml at boot with js-yaml, which
// throws on duplicate mapping keys. Nothing else in the suite reads these files, so a
// malformed one passes every other test and only fails at render time, where it
// surfaces as "Error when running job render-page" and the renderer silently stops
// applying. Editing a props block by hand is exactly how that happens.
describe('rendering module definitions', () => {
  const modulesDir = path.join(__dirname, '..', '..', 'modules', 'rendering')
  const modules = fs.readdirSync(modulesDir).filter(d =>
    fs.existsSync(path.join(modulesDir, d, 'definition.yml'))
  )

  test('at least one module is discovered', () => {
    expect(modules.length).toBeGreaterThan(0)
  })

  test.each(modules)('%s/definition.yml parses and is well formed', name => {
    const file = path.join(modulesDir, name, 'definition.yml')
    const raw = fs.readFileSync(file, 'utf8')

    let def
    expect(() => { def = yaml.load(raw) }).not.toThrow()

    expect(typeof def.key).toBe('string')
    expect(def.key.length).toBeGreaterThan(0)

    // Every declared prop needs a type, or the admin area cannot render a control.
    for (const [prop, spec] of Object.entries(def.props || {})) {
      expect(typeof spec).toBe('object')
      expect(`${name}.${prop}.type=${spec.type}`).toMatch(/=(String|Boolean|Number)$/)
    }
  })
})
