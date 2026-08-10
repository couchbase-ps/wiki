<template lang='pug'>
  v-card.editor-modal-wellarchitected.animated.fadeIn(flat, tile)
    iframe(
      ref='review'
      :src='iframeSrc'
      frameborder='0'
    )
</template>

<script>
import { sync } from 'vuex-pathify'

export default {
  computed: {
    activeModal: sync('editor/activeModal'),
    iframeSrc () {
      return `/_assets/well-architected/index.html?v=${Date.now()}`
    }
  },
  methods: {
    close () {
      this.activeModal = ''
    },
    send (msg) {
      if (this.$refs.review && this.$refs.review.contentWindow) {
        this.$refs.review.contentWindow.postMessage(msg, '*')
      }
    },
    receive (evt) {
      if (!this.$refs.review || evt.source !== this.$refs.review.contentWindow) {
        return
      }
      const msg = evt.data
      if (!msg || typeof msg !== 'object') {
        return
      }
      switch (msg.event) {
        case 'ready': {
          this.send({ action: 'init', markdown: this.$store.get('editor/activeModalData') })
          this.$store.set('editor/activeModalData', null)
          break
        }
        case 'save': {
          this.$root.$emit('editorInsert', {
            kind: 'WELL_ARCHITECTED',
            markdown: msg.markdown
          })
          this.close()
          break
        }
        case 'exit': {
          this.close()
          break
        }
      }
    }
  },
  mounted () {
    window.addEventListener('message', this.receive)
  },
  beforeDestroy () {
    window.removeEventListener('message', this.receive)
  }
}
</script>

<style lang='scss'>
.editor-modal-wellarchitected {
  position: fixed !important;
  top: 0;
  left: 0;
  z-index: 10;
  width: 100%;
  height: 100vh;
  background-color: rgba(255,255,255, 1) !important;
  overflow: hidden;

  > iframe {
    width: 100%;
    height: 100vh;
    border: 0;
    padding: 0;
    background-color: #FFF;
  }
}
</style>
