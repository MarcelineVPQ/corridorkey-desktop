// Vite's ?raw imports (a file's text, bundled at build time) for the main process: farm export's templates (farm/).
declare module "*?raw" {
  const text: string;
  export default text;
}
