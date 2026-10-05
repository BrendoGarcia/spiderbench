export default {
  base: '/spider/',

  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 2500,

    rollupOptions: {
      output: {
        // transformação dos arquivos gerados
      }
    }
  }
}
