// Builds the one-glyph icon font used by `contributes.icons` (status bar `$(sovran-logo)`).
// Source: assets/icon-font/*.svg (not shipped). Output: media/brand/sovran-icons.woff (shipped).
module.exports = {
  inputDir: './assets/icon-font',
  outputDir: './media/brand',
  name: 'sovran-icons',
  fontTypes: ['woff'],
  assetTypes: [],
  normalize: true,
  codepoints: { 'sovran-logo': 0xe900 },
};
