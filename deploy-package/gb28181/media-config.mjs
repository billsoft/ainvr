// Preserve source PS audio/video timing and administrator configuration.
// Per-track timestamp smoothing changes A/V offset; synthetic AAC can turn a
// video-only source into a false "audio available". Neither is a copy policy.
export function sourceMediaConfig(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const headers = lines.flatMap((line, i) => /^\s*\[protocol\]\s*$/i.test(line) ? [i] : []);
  if (headers.length > 1) throw new Error('Duplicate media protocol sections require manual reconciliation');
  if (!headers.length) return text.trimEnd() + '\n[protocol]\nenable_audio=1\nadd_mute_audio=0\nmodify_stamp=0\n';
  const start = headers[0];
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const content = lines.slice(start + 1, end).filter(line => !/^\s*(enable_audio|add_mute_audio|modify_stamp)\s*=/i.test(line));
  while (content.length && !content.at(-1).trim()) content.pop();
  lines.splice(start + 1, end - start - 1, ...content, 'enable_audio=1', 'add_mute_audio=0', 'modify_stamp=0');
  return lines.join('\n').trimEnd() + '\n';
}
