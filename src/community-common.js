import { ApplicationCommandOptionType as Option, ChannelType, InteractionContextType, MessageFlags,
  PermissionFlagsBits as Permissions, RESTJSONErrorCodes } from 'discord.js';
import { assertSafeText, SafetyError } from './safety.js';
import { cleanLanguageRequired, containsProfanity } from './server-language.js';

export class CommunityInputError extends Error {}

export const quiet = Object.freeze({ parse: [], repliedUser: false });
export const textChannelTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
export const privateReply = { flags: MessageFlags.Ephemeral, allowedMentions: quiet };
export const publicMessage = { flags: MessageFlags.SuppressEmbeds, allowedMentions: quiet };

export function command(name, description, options, permission) {
  return { name, description, contexts: [InteractionContextType.Guild], options,
    ...(permission === undefined ? {} : { default_member_permissions: permission.toString() }) };
}

export function subcommand(name, description, options = []) {
  return { type: Option.Subcommand, name, description, options };
}

export function stringOption(name, description, maxLength, required = false) {
  return { type: Option.String, name, description, max_length: maxLength, required };
}

export function channelOption(name, description, required = false, types = textChannelTypes) {
  return { type: Option.Channel, name, description, channel_types: types, required };
}

export function roleOption(name, description, required = false) {
  return { type: Option.Role, name, description, required };
}

export function reply(interaction, content) {
  const payload = { content, allowedMentions: quiet };
  return interaction.deferred
    ? interaction.editReply(payload)
    : interaction.reply({ ...payload, ...privateReply });
}

export function requirePermission(interaction, permission, name) {
  if (!interaction.memberPermissions?.has(permission)) {
    throw new CommunityInputError(`You need the ${name} permission to do this.`);
  }
}

export function safeCommunityText(text, guildId) {
  if (!text?.trim()) throw new CommunityInputError('Enter a message with some text.');
  assertSafeText(text);
  if (cleanLanguageRequired(guildId) && containsProfanity(text)) {
    throw new CommunityInputError('Choose wording that follows this server’s language policy.');
  }
  return text.trim();
}

export async function lookupChannel(guild, channelId, { force = false } = {}) {
  try { return await guild.channels.fetch(channelId, { force }); }
  catch (error) {
    if (error.code === RESTJSONErrorCodes.UnknownChannel) return null;
    throw error;
  }
}

export async function destination(interaction, option = 'channel', fallbackId = interaction.channelId) {
  const guild = interaction.guild;
  const channel = await lookupChannel(guild, interaction.options.getChannel(option)?.id ?? fallbackId, { force: true });
  if (!channel || !textChannelTypes.includes(channel.type)) {
    throw new CommunityInputError('Choose a text or announcement channel in this server.');
  }
  if (!channel.permissionsFor(interaction.member)?.has(Permissions.ViewChannel)) {
    throw new CommunityInputError('You need access to the selected channel.');
  }
  const me = guild.members.me ?? await guild.members.fetchMe();
  if (!channel.permissionsFor(me)?.has([Permissions.ViewChannel, Permissions.SendMessages])) {
    throw new CommunityInputError('Owaua needs View Channel and Send Messages in the selected channel.');
  }
  return channel;
}

export async function removeMessage(guild, channelId, messageId) {
  const channel = await lookupChannel(guild, channelId);
  if (!channel?.isTextBased()) return;
  try { await channel.messages.delete(messageId); }
  catch (error) { if (error.code !== RESTJSONErrorCodes.UnknownMessage) throw error; }
}

export function communityError(error) {
  if (error instanceof CommunityInputError || error instanceof SafetyError) return error.message;
  if ([RESTJSONErrorCodes.MissingAccess, RESTJSONErrorCodes.MissingPermissions].includes(error.code)) {
    return 'Owaua needs more permissions to do that. Check its role and channel permissions.';
  }
  return 'I couldn’t finish that Discord action. Please try again.';
}

export function serializeByKey() {
  const inProgress = new Map();
  return async (key, run) => {
    const previous = inProgress.get(key);
    const task = previous ? previous.catch(() => {}).then(run) : Promise.resolve().then(run);
    inProgress.set(key, task);
    try { return await task; }
    finally { if (inProgress.get(key) === task) inProgress.delete(key); }
  };
}
