/** Render untrusted journal prose literally: no links, images, HTML or fence breakout. */
export function literalText(text: string): string {
  const width = Math.max(3, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length + 1));
  const fence = "`".repeat(width);
  return `${fence}text\n${text}\n${fence}`;
}
