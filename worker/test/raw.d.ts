// Vite's `?raw` imports: a file's text as a string (used to check the committed configs).
declare module '*?raw' {
  const text: string;
  export default text;
}
