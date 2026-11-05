// pdfjs-dist ships types for its display layer only. Sovran loads the parser module just to register it in-thread.
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
