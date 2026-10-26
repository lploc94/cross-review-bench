/**
 * `Content-Disposition: attachment` with the original file name. The quoted `filename` parameter
 * only carries printable ASCII safely, so every other character, and `"` and `\` (which would end
 * or escape the quoted string), becomes `_`. An empty name becomes `download`.
 */
export function contentDisposition(originalName: string): string {
  let safe = "";
  for (const char of originalName) {
    const code = char.codePointAt(0) ?? 0;
    const printable = code >= 0x20 && code <= 0x7e;
    safe += printable && char !== '"' && char !== "\\" ? char : "_";
  }
  return `attachment; filename="${safe === "" ? "download" : safe}"`;
}
