const topologyUi = require('@couchbaselabs/topology-ui')

function wrapRenderedTopology(html) {
  return `<div class="cb-topology-renderer-host">${html}</div>`
}

module.exports = {
  init(mdinst, conf) {
    mdinst.use((md, opts) => {
      const openMarker = opts.openMarker || '```couchbase-topology'
      const openChar = openMarker.charCodeAt(0)
      const closeMarker = opts.closeMarker || '```'
      const closeChar = closeMarker.charCodeAt(0)
      const assetRoot = opts.assetRoot || '/_assets/topology-ui/images'
      const allowJavaScript = opts.allowJavaScript !== false

      md.block.ruler.before('fence', 'couchbase_topology', (state, startLine, endLine, silent) => {
        let nextLine
        let markup
        let token
        let i
        let autoClosed = false
        let start = state.bMarks[startLine] + state.tShift[startLine]
        let max = state.eMarks[startLine]

        if (openChar !== state.src.charCodeAt(start)) { return false }

        for (i = 0; i < openMarker.length; ++i) {
          if (openMarker[i] !== state.src[start + i]) { return false }
        }

        markup = state.src.slice(start, start + i)

        if (silent) { return true }

        nextLine = startLine

        for (;;) {
          nextLine++
          if (nextLine >= endLine) {
            break
          }

          start = state.bMarks[nextLine] + state.tShift[nextLine]
          max = state.eMarks[nextLine]

          if (start < max && state.sCount[nextLine] < state.blkIndent) {
            break
          }

          if (closeChar !== state.src.charCodeAt(start)) {
            continue
          }

          if (state.sCount[nextLine] > state.sCount[startLine]) {
            continue
          }

          let closeMarkerMatched = true
          for (i = 0; i < closeMarker.length; ++i) {
            if (closeMarker[i] !== state.src[start + i]) {
              closeMarkerMatched = false
              break
            }
          }

          if (!closeMarkerMatched) {
            continue
          }

          if (state.skipSpaces(start + i) < max) {
            continue
          }

          autoClosed = true
          break
        }

        const source = state.src
          .split('\n')
          .slice(startLine + 1, nextLine)
          .join('\n')

        token = state.push('couchbase_topology', '', 0)
        token.block = true
        token.content = renderTopologyBlock(md, source, {
          allowJavaScript,
          assetRoot
        })
        token.map = [startLine, nextLine]
        token.markup = markup

        state.line = nextLine + (autoClosed ? 1 : 0)

        return true
      }, {
        alt: ['paragraph', 'reference', 'blockquote', 'list']
      })

      md.renderer.rules.couchbase_topology = (tokens, idx) => tokens[idx].content
    }, {
      allowJavaScript: conf.allowJavaScript,
      assetRoot: conf.assetRoot,
      openMarker: conf.openMarker,
      closeMarker: conf.closeMarker
    })
  }
}

function renderTopologyBlock(md, source, options) {
  try {
    const data = topologyUi.parseTopologySource(source, {
      allowJavaScript: options.allowJavaScript
    })
    return wrapRenderedTopology(topologyUi.renderTopology(data, {
      assetRoot: options.assetRoot
    }))
  } catch (err) {
    return wrapRenderedTopology([
      '<div class="cb-topology-renderer cb-topology-renderer--error">',
      '<pre><code>',
      md.utils.escapeHtml(err.message),
      '</code></pre>',
      '</div>'
    ].join(''))
  }
}
