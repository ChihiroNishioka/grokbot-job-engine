const redacted = '[REDACTED]';

function maskPart(value: string): string {
  return value
    .replace(/[A-Za-z0-9_-]{32,}/g, redacted)
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi, redacted)
    .replace(/\b(?:[a-z0-9-]+\.)+ts\.net\b/gi, redacted)
    .replace(/\b100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (match, second: string, third: string, fourth: string) => Number(second) >= 64 && Number(second) <= 127 && Number(third) <= 255 && Number(fourth) <= 255 ? redacted : match)
    .replace(/\+?\d[\d -]{8,}\d/g, match => match.replace(/\D/g, '').length >= 10 ? redacted : match);
}

export function mask(value: string): string {
  value = value.replace(/\bBearer\s+\S+/gi, redacted)
    .replace(/\b(password|secret|token)=[^\s&;,]+/gi, `$1=${redacted}`);
  const protectedPattern = /\bJ-\d{6,}\b|\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
  let output = '';
  let offset = 0;
  for (const match of value.matchAll(protectedPattern)) {
    output += maskPart(value.slice(offset, match.index)) + match[0];
    offset = match.index + match[0].length;
  }
  return output + maskPart(value.slice(offset));
}
