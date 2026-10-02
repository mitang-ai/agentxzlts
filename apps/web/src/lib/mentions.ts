export function mentionAt(text: string, caret: number) {
  const prefix = text.slice(0, caret),
    match = /(^|\s)@([^\s@]*)$/.exec(prefix);
  return match
    ? { start: match.index + match[1].length, end: caret, query: match[2] }
    : null;
}
export function insertMention(
  text: string,
  range: { start: number; end: number },
  name: string,
) {
  const token = `@${name} `;
  return {
    text: text.slice(0, range.start) + token + text.slice(range.end),
    caret: range.start + token.length,
  };
}
