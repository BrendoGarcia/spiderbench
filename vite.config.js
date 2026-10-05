export default {
  base: '/spider/',

  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 2500
  },

  plugins: [
    {
      name: 'fix-absolute-assets',

      transformIndexHtml(html) {
        return html.replace(
          /(["'(])\/(assets|images|fonts|audio|video)\//g,
          `$1/spider/$2/`
        );
      }
    }
  ]
};
