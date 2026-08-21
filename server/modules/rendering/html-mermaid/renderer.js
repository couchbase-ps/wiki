module.exports = {
  init($, config) {
    $('pre > code.language-mermaid').each((i, elm) => {
      const mermaidContent = $(elm).html()
      $(elm).parent().replaceWith(`<div class="mermaid">${mermaidContent}</div>`)
    })
  }
}
