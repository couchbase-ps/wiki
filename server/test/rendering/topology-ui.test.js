const MarkdownIt = require('markdown-it')

let hasTopologyUi = true
try {
  require.resolve('@couchbaselabs/topology-ui')
} catch (err) {
  hasTopologyUi = false
}

const describeIfTopologyUi = hasTopologyUi ? describe : describe.skip

describeIfTopologyUi('markdown couchbase topology renderer', () => {
  const renderer = require('../../modules/rendering/markdown-couchbase-topology/renderer')

  test('renders a fenced topology block as html', () => {
    const md = new MarkdownIt({ html: true, breaks: true, linkify: true })
    renderer.init(md, {
      assetRoot: '/_assets/topology-ui/images',
      openMarker: '```couchbase-topology',
      closeMarker: '```'
    })

    const html = md.render(`
\`\`\`couchbase-topology
{
  "name": "cb-demo",
  "version": "7.2.0",
  "serverGroups": [
    {
      "name": "sg1",
      "nodes": [
        {
          "name": "cb-demo0001",
          "services": ["Data", "Query"],
          "status": "HEALTHY"
        }
      ]
    }
  ]
}
\`\`\`
`)

    expect(html).toContain('cb-topology-renderer-host')
    expect(html).toContain('cb-topology-renderer')
    expect(html).toContain('cb-demo')
    expect(html).toContain('/_assets/topology-ui/images/nodebg.png')
  })

  test('supports alignment attrs on the fence closing line', () => {
    const md = new MarkdownIt({ html: true, breaks: true, linkify: true })
    renderer.init(md, {
      assetRoot: '/_assets/topology-ui/images',
      openMarker: '```couchbase-topology',
      closeMarker: '```'
    })

    const html = md.render(`
\`\`\`couchbase-topology
{
  "name": "cb-demo",
  "version": "7.2.0",
  "serverGroups": []
}
\`\`\` {.align-center #demo-topology}
`)

    expect(html).toContain('class="cb-topology-renderer-host align-center"')
    expect(html).toContain('id="demo-topology"')
  })

  test('supports alignment attrs on the line after the fence', () => {
    const md = new MarkdownIt({ html: true, breaks: true, linkify: true })
    renderer.init(md, {
      assetRoot: '/_assets/topology-ui/images',
      openMarker: '```couchbase-topology',
      closeMarker: '```'
    })

    const html = md.render(`
\`\`\`couchbase-topology
{
  "name": "cb-demo",
  "version": "7.2.0",
  "serverGroups": []
}
\`\`\`
{.align-right}
`)

    expect(html).toContain('class="cb-topology-renderer-host align-right"')
    expect(html).not.toContain('<p class="align-right"></p>')
  })

  test('returns an error block for invalid payloads', () => {
    const md = new MarkdownIt({ html: true, breaks: true, linkify: true })
    renderer.init(md, {
      assetRoot: '/_assets/topology-ui/images',
      openMarker: '```couchbase-topology',
      closeMarker: '```'
    })

    const html = md.render(`
\`\`\`couchbase-topology
{ name: "broken" }
\`\`\`
`)

    expect(html).toContain('cb-topology-renderer-host')
    expect(html).toContain('cb-topology-renderer--error')
    expect(html).toContain('Topology source is not valid JSON')
  })

  // #92 / #123: a non-JSON topology block used to be EXECUTED rather than rejected.
  // Server side that ran through `vm.runInNewContext`, whose 1s timeout stops a loop but
  // not memory exhaustion (#123); in the editor's browser preview it ran via `Function()`
  // in the page origin (#92).
  //
  // Flipping the `allowJavaScript` default was NOT sufficient: Wiki.js persists renderer
  // config in the `renderers` table, and definition.yml defaults only seed NEW rows, so
  // every existing install kept `allowJavaScript: true` and stayed vulnerable. The option
  // is therefore gone and the parser is called with `allowJavaScript: false` explicitly,
  // which also guards against the upstream package defaulting it back to true.
  describe('JavaScript object literals are never executed', () => {
    const defaultConf = {
      assetRoot: '/_assets/topology-ui/images',
      openMarker: '```couchbase-topology',
      closeMarker: '```'
    }

    test('rejects a JavaScript object literal instead of executing it', () => {
      const md = new MarkdownIt({ html: true, breaks: true, linkify: true })
      renderer.init(md, defaultConf)

      // Unquoted key and single quotes: valid JS, invalid JSON. Previously evaluated.
      const html = md.render('```couchbase-topology\n{ name: \'cb\', version: \'7.6.0\' }\n```')

      expect(html).toContain('Topology source is not valid JSON')
      // The outer host div wraps every token, including the error case, so assert on
      // the error class rather than its absence.
      expect(html).toContain('cb-topology-renderer--error')
    })

    test('rejects an immediately invoked function expression', () => {
      const md = new MarkdownIt({ html: true, breaks: true, linkify: true })
      renderer.init(md, defaultConf)

      const html = md.render('```couchbase-topology\n(function () { return { name: \'x\' } })()\n```')

      expect(html).toContain('Topology source is not valid JSON')
    })

    test('stays rejected even when a stored config says allowJavaScript true', () => {
      const md = new MarkdownIt({ html: true, breaks: true, linkify: true })
      // This is what every pre-existing install actually has in its `renderers` row.
      // Flipping the definition.yml default did nothing for them, which is why the
      // option had to be removed rather than defaulted off.
      renderer.init(md, { ...defaultConf, allowJavaScript: true })

      const html = md.render('```couchbase-topology\n{ name: \'cb\' }\n```')

      expect(html).toContain('Topology source is not valid JSON')
      expect(html).toContain('cb-topology-renderer--error')
    })

    test('still renders a strict JSON topology block', () => {
      const md = new MarkdownIt({ html: true, breaks: true, linkify: true })
      renderer.init(md, defaultConf)

      const html = md.render('```couchbase-topology\n{"name":"cb-demo","version":"7.6.0"}\n```')

      expect(html).toContain('cb-topology-renderer-host')
      expect(html).not.toContain('Topology source is not valid JSON')
    })
  })
})
