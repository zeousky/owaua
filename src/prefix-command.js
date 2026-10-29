import { commands } from './commands.js';
import { isDocumentAttachment } from './files.js';
import { isAudioAttachment } from './voice.js';
import { card } from './ui.js';

export class PrefixCommandError extends Error {}
export class PrefixPrivateReplyError extends Error {}

// Preserve quoted strings and JSON objects, including whitespace inside them.
// Apostrophes inside ordinary words (what's, don't) remain literal.
function tokens(input) {
  const result = [];
  let start = 0, quote = '', depth = 0;
  for (let i = 0; i <= input.length; i++) {
    const char = input[i];
    if (quote) {
      if (char === '\\') { i++; continue; }
      if (char === quote) quote = '';
    } else if ((char === '"' || char === "'") && (depth || i === start || /[:=]/.test(input[i - 1]))) quote = char;
    else if ((char === '{' || char === '[') && (depth || /^(?:--)?(?:schema|payload)[:=]$/i.test(input.slice(start, i)))) depth++;
    else if ((char === '}' || char === ']') && depth) depth--;
    else if ((char === undefined || /\s/.test(char)) && !depth) {
      if (i > start) {
        const previous = result.at(-1);
        result.push({ text: input.slice(start, i), gap: previous ? input.slice(previous.end, start) : '', end: i });
      }
      start = i + 1;
    }
  }
  if (quote || depth) throw new PrefixCommandError('Close the quotes or JSON brackets in your command.');
  return result;
}

const joinTokens = parts => parts.map((part, index) => (index ? part.gap : '') + part.text).join('');

function unquote(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { throw new PrefixCommandError('Use valid double-quoted text, or single quotes around your value.'); }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/\\'/g, "'");
  return value;
}

function convert(option, raw, attachments) {
  const value = unquote(raw);
  const invalid = () => { throw new PrefixCommandError(`Check the ${option.name} option. Use .help for command examples.`); };
  if (option.type === 3) {
    if (!value.length || value.length < (option.min_length ?? 0) || value.length > (option.max_length ?? Infinity)) invalid();
    if (option.choices && !option.choices.some(choice => choice.value === value)) invalid();
    return value;
  }
  if (option.type === 5) {
    if (!/^(true|false)$/i.test(value)) invalid();
    return value.toLowerCase() === 'true';
  }
  if (option.type === 4 || option.type === 10) {
    const number = Number(value);
    if (!value.trim() || !Number.isFinite(number) || (option.type === 4 && !Number.isSafeInteger(number)) ||
        number < (option.min_value ?? -Infinity) || number > (option.max_value ?? Infinity)) invalid();
    return number;
  }
  if (option.type === 6) {
    const id = /^(?:<@!?(\d{17,20})>|(\d{17,20}))$/.exec(value);
    if (!id) invalid();
    return { id: id[1] ?? id[2] };
  }
  if (option.type === 11) {
    // Only select attachments on this message; a typed URL is never trusted.
    const attachment = attachments.find(a => a.name === value || a.id === value) ??
      (/^[1-9]\d*$/.test(value) ? attachments[Number(value) - 1] : undefined);
    if (!attachment) throw new PrefixCommandError(`Attach the ${option.name} file to your command. Select it by filename or attachment number.`);
    return attachment;
  }
  invalid();
}

function matchesAttachment(name, attachment) {
  if (name === 'image') return /^image\//.test(attachment.contentType ?? '');
  if (name === 'video') return attachment.contentType === 'video/mp4';
  if (name === 'audio') return isAudioAttachment(attachment);
  return isDocumentAttachment(attachment);
}

export function parsePrefixCommand(content, { attachments = new Map() } = {}) {
  const match = /^\.([a-z]+)(?:\s+([\s\S]*))?$/i.exec(content?.trim() ?? '');
  if (!match) return null;
  const command = commands.find(command => command.name === match[1].toLowerCase());
  if (!command) return null;
  const args = tokens(match[2] ?? '');
  let options = command.options ?? [], subcommand = null;
  if (options.some(option => option.type === 1)) {
    subcommand = args.shift()?.text.toLowerCase();
    const selected = options.find(option => option.name === subcommand);
    if (!selected) throw new PrefixCommandError(`Use .${command.name} followed by ${options.map(option => option.name).join(', ')}.`);
    options = selected.options ?? [];
  }
  const values = new Map(), positional = [];
  let named = null;
  for (const token of args) {
    const field = /^(?:--)?([a-z_]+)(?::|=)([\s\S]*)$/i.exec(token.text);
    const option = field && options.find(option => option.name === field[1].toLowerCase());
    if (option) {
      if (values.has(option.name)) throw new PrefixCommandError(`Specify ${option.name} only once.`);
      named = option.name;
      values.set(named, field[2] ? [{ ...token, text: field[2] }] : []);
    } else {
      if (token.text.startsWith('--')) throw new PrefixCommandError('Unknown option. Use option:value, for example voice:eve or library:true.');
      (named ? values.get(named) : positional).push(token);
    }
  }
  // Positional values follow the slash option order. The last text option takes
  // the remaining words, so .ask, .speak and .memory remember feel natural.
  const positionalOptions = options.filter(option => option.type !== 11 && !values.has(option.name));
  while (positional.length) {
    const option = positionalOptions.shift();
    if (!option) throw new PrefixCommandError(`Unexpected arguments for .${command.name}. Use .help for examples.`);
    const rest = option.type === 3 && !positionalOptions.some(next => next.required) &&
      !(command.name === 'mistral' && option.name === 'operation');
    values.set(option.name, rest ? positional.splice(0) : [positional.shift()]);
  }
  const supplied = [...attachments.values()];
  for (const option of options) {
    if (values.has(option.name)) values.set(option.name, convert(option, joinTokens(values.get(option.name)), supplied));
    else if (option.type === 11) {
      const attachment = supplied.find(attachment => (command.name === 'mistral' && option.name === 'file') || matchesAttachment(option.name, attachment));
      if (attachment) values.set(option.name, attachment);
    }
    if (option.required && !values.has(option.name)) throw new PrefixCommandError(
      option.type === 11 ? `Attach the ${option.name} file to .${command.name}${subcommand ? ` ${subcommand}` : ''}.` :
        `Include ${option.name} in .${command.name}, for example ${option.name}:"your text".`);
  }
  return { commandName: command.name, subcommand, values };
}

// Discord messages cannot be ephemeral. Send every ephemeral result to the
// actor's DMs while keeping the original guild/channel for data and permissions.
export function createPrefixInteraction(message, command) {
  let response, privateReply = false;
  const payloadForMessage = payload => {
    const { flags, ...rest } = payload;
    const publicFlags = Number(flags ?? 0) & ~64;
    return { ...rest, ...(publicFlags ? { flags: publicFlags } : {}) };
  };
  const send = async payload => {
    if ((Number(payload.flags ?? 0) & 64) !== 0 && !privateReply) {
      privateReply = true;
      response = undefined;
    }
    const outgoing = payloadForMessage(payload);
    try {
      if (response) return await response.edit(outgoing);
      response = await (privateReply && message.guildId ? message.author.send(outgoing) : message.reply(outgoing));
      return response;
    } catch (error) {
      if (privateReply) throw new PrefixPrivateReplyError('Private reply unavailable', { cause: error });
      throw error;
    }
  };
  const read = (name, required) => {
    const value = command.values.get(name) ?? null;
    if (required && value === null) throw new PrefixCommandError(`Missing ${name}.`);
    return value;
  };
  return {
    sourceMessage: message, commandName: command.commandName,
    user: message.author, guild: message.guild, guildId: message.guildId,
    channel: message.channel, channelId: message.channelId,
    options: { getSubcommand: () => command.subcommand,
      getString: read, getBoolean: read, getInteger: read, getNumber: read, getAttachment: read, getUser: read },
    reply: send, editReply: send,
    deferReply: async (options = {}) => { await send({ ...card('', 'Working on it…'), ...options }); },
  };
}
