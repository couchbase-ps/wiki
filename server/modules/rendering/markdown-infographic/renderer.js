// ------------------------------------
// Markdown - AntV Infographic Preprocessor
// ------------------------------------

const infographicPlugin = require('../../../../shared/markdown/infographic-plugin')

module.exports = {
  init (mdinst, conf) {
    mdinst.use(infographicPlugin)
  }
}
