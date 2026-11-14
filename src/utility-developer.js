import { createHash } from 'node:crypto';
import QRCode from 'qrcode';
import { ApplicationCommandOptionType as Option } from 'discord.js';
import { assertSafeChatInput, assertSafeText, assertSafeValue } from './safety.js';
import { cleanLanguageRequired, containsProfanity } from './server-language.js';
import { UtilityInputError } from './utility-input.js';

const styles = {
  f: 'Date and time',
  F: 'Full date and time',
  R: 'Relative time',
  t: 'Short time',
  T: 'Time with seconds',
  d: 'Short date',
  D: 'Long date',
};
const hashAlgorithms = ['sha256', 'sha384', 'sha512'];
const string = (name, description, options = {}) => ({ type: Option.String, name, description, ...options });
const choices = entries => entries.map(([value, name]) => ({ name, value }));

export const developerCommands = [
  { name: 'timestamp', description: 'Create a Discord timestamp', options: [
    string('date', 'Unix seconds, YYYY-MM-DD (UTC), or ISO 8601 with an explicit timezone', { required: true, max_length: 40 }),
    string('style', 'Display format', { choices: choices(Object.entries(styles)) }),
  ] },
  { name: 'color', description: 'Convert a color between HEX, RGB, and HSL', options: [
    string('value', 'A HEX, RGB, or HSL color (examples: #336699, 51, 102, 153, hsl(210, 50%, 40%))', { required: true, max_length: 40 }),
  ] },
  { name: 'qr', description: 'Generate a QR code PNG from text or a link', options: [
    string('text', 'Text or URL to encode', { required: true, max_length: 1000 }),
  ] },
  { name: 'json', description: 'Format or minify JSON and download it as a file', options: [
    string('text', 'JSON to format', { required: true, max_length: 4000 }),
    string('style', 'Formatting style', { choices: choices([['pretty', 'Indented'], ['compact', 'Compact']]) }),
  ] },
  { name: 'hash', description: 'Calculate a cryptographic hash of text', options: [
    string('text', 'Text to hash with UTF-8 encoding', { required: true, max_length: 4000 }),
    string('algorithm', 'Hash algorithm (default SHA-256)', {
      choices: choices(hashAlgorithms.map(value => [value, value.replace('sha', 'SHA-')])),
    }),
  ] },
];

const calendar = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/u;

export function timestampSeconds(input) {
  const value = input.trim();
  let seconds;
  if (/^-?\d{1,12}$/u.test(value)) {
    seconds = Number(value);
  } else {
    const match = calendar.exec(value);
    if (match) {
      const [, year, month, day, hour = '0', minute = '0', second = '0', zone] = match;
      const dayInUtc = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
      if (+year > 0 && dayInUtc.getUTCDate() === +day && +hour < 24 && +minute < 60 && +second < 60 &&
          (!zone || zone === 'Z' || +zone.slice(1, 3) < 24 && +zone.slice(4, 6) < 60)) {
        seconds = Math.floor(Date.parse(zone ? value : `${value}T00:00:00Z`) / 1000);
      }
    }
  }
  if (!Number.isSafeInteger(seconds) || seconds < -62135596800 || seconds > 253402300799) {
    throw new UtilityInputError('Enter Unix seconds, a UTC date like 2026-11-20, or a date and time like 2026-11-20T14:00+01:00.');
  }
  return seconds;
}

function rgbFromHsl(input) {
  const match = /^hsl\(\s*(-?\d+(?:\.\d+)?)(?:deg)?\s*,\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%\s*\)$/iu.exec(input.trim());
  if (!match) return;
  const [hue, saturation, lightness] = match.slice(1).map(Number);
  if (!Number.isFinite(hue) || saturation > 100 || lightness > 100) {
    throw new UtilityInputError('Use percentages between 0% and 100% for HSL saturation and lightness.');
  }
  const light = lightness / 100;
  const amplitude = saturation / 100 * Math.min(light, 1 - light);
  const h = ((hue % 360) + 360) % 360;
  return [0, 8, 4].map(offset => {
    const channel = (offset + h / 30) % 12;
    return Math.round(255 * (light - amplitude * Math.max(-1, Math.min(channel - 3, 9 - channel, 1))));
  });
}

export function convertColor(input) {
  const hex = /^#?([\da-f]{3}|[\da-f]{6})$/iu.exec(input.trim());
  let rgb = rgbFromHsl(input);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map(digit => digit.repeat(2)).join('') : hex[1];
    rgb = digits.match(/../g).map(digits => Number.parseInt(digits, 16));
  } else if (!rgb) {
    const channels = input.trim().replace(/^rgb\((.+)\)$/iu, '$1').split(',').map(channel => channel.trim());
    if (channels.length !== 3 || channels.some(channel => !/^\d{1,3}$/u.test(channel) || Number(channel) > 255)) {
      throw new UtilityInputError('Enter #336699, RGB channels like 51, 102, 153, or HSL like hsl(210, 50%, 40%).');
    }
    rgb = channels.map(Number);
  }
  const [red, green, blue] = rgb.map(value => value / 255);
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue), delta = max - min;
  const light = (max + min) / 2;
  let hue = 0, saturation = 0;
  if (delta) {
    if (max === red) hue = (green - blue) / delta;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    saturation = delta / (1 - Math.abs(2 * light - 1));
  }
  return {
    hex: `#${rgb.map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`,
    rgb,
    hsl: [Math.round(((hue + 6) % 6) * 60) % 360, Math.round(saturation * 100), Math.round(light * 100)],
  };
}

export function formatJson(input, style = 'pretty', { clean = false } = {}) {
  try { JSON.parse(input); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new UtilityInputError('That text is not valid JSON.');
  }
  const tokens = input.match(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/gu);
  // Check every decoded string, including keys and duplicate values that the
  // JSON parser would otherwise discard, while leaving the original tokens intact.
  const decoded = tokens.map(token => token.startsWith('"') ? JSON.parse(token) : null);
  const strings = decoded.filter(value => value !== null);
  const stringEntries = decoded.flatMap((key, index) => key !== null && tokens[index + 1] === ':' &&
    decoded[index + 2] !== null ? [{ [key]: decoded[index + 2] }] : []);
  for (const entry of stringEntries) assertSafeValue(entry);
  for (const text of strings) assertSafeText(text);
  if (clean && strings.some(containsProfanity)) {
    throw new UtilityInputError('Use clean language in JSON files for this server.');
  }
  let depth = 0;
  const newline = () => `\n${'  '.repeat(depth)}`;
  const compact = style === 'compact';
  const output = tokens.map((token, index) => {
    if (token === '{' || token === '[') {
      if (++depth > 32) throw new UtilityInputError('Use JSON with at most 32 levels of nesting.');
      return token + (compact || tokens[index + 1] === '}' || tokens[index + 1] === ']' ? '' : newline());
    }
    if (token === '}' || token === ']') {
      depth--;
      return (compact || tokens[index - 1] === '{' || tokens[index - 1] === '[' ? '' : newline()) + token;
    }
    if (compact) return token;
    if (token === ',') return token + newline();
    return token === ':' ? ': ' : token;
  }).join('');
  return compact ? output : output + '\n';
}

const developerHandlers = {
  timestamp({ options }) {
    const seconds = timestampSeconds(options.getString('date', true));
    const style = options.getString('style') ?? 'f';
    const stamp = `<t:${seconds}:${style}>`;
    return { content: `${stamp}\nCopy: \`${stamp}\`` };
  },
  color({ options }) {
    const { hex, rgb, hsl: [hue, saturation, light] } = convertColor(options.getString('value', true));
    return { content: `HEX \`${hex}\`\nRGB \`rgb(${rgb.join(', ')})\`\nHSL \`hsl(${hue}, ${saturation}%, ${light}%)\`` };
  },
  async qr({ options, guildId }) {
    const input = options.getString('text', true);
    if (!input.trim() || Buffer.byteLength(input) > 1200) {
      throw new UtilityInputError('Enter nonempty text or a URL using at most 1,200 UTF-8 bytes.');
    }
    assertSafeText(input);
    if (cleanLanguageRequired(guildId) && containsProfanity(input)) {
      throw new UtilityInputError('Use clean language in QR codes for this server.');
    }
    const image = await QRCode.toBuffer(input, { width: 512, margin: 4, errorCorrectionLevel: 'M' });
    return { files: [{ attachment: image, name: 'qr.png' }] };
  },
  json({ options, guildId }) {
    const output = formatJson(options.getString('text', true), options.getString('style') ?? 'pretty',
      { clean: cleanLanguageRequired(guildId) });
    assertSafeText(output);
    return { files: [{ attachment: Buffer.from(output, 'utf8'), name: 'formatted.json' }] };
  },
  hash({ options }) {
    const input = options.getString('text', true);
    const algorithm = options.getString('algorithm') ?? 'sha256';
    if (!hashAlgorithms.includes(algorithm)) throw new UtilityInputError('Choose SHA-256, SHA-384, or SHA-512.');
    assertSafeChatInput(input);
    const digest = createHash(algorithm).update(input, 'utf8').digest('hex');
    return { content: `${algorithm.replace('sha', 'SHA-')} \`${digest}\`` };
  },
};

export function handleDeveloperCommand(interaction) {
  return developerHandlers[interaction.commandName](interaction);
}
