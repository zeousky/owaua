import { ApplicationCommandOptionType as Option, PermissionFlagsBits as Permissions, RESTJSONErrorCodes } from 'discord.js';
import { channelOption, command, CommunityInputError, destination, lookupChannel, privateReply, publicMessage,
  reply, requirePermission, serializeByKey, subcommand, textChannelTypes } from './community-common.js';

const star = '⭐';

export const starboardCommand = command('starboard', 'Highlight messages that get enough star reactions', [
  subcommand('setup', 'Choose the starboard channel and number of reactions required', [
    channelOption('channel', 'Channel where highlighted messages appear', true),
    { type: Option.Integer, name: 'threshold', description: 'Star reactions required (default 3)', min_value: 1, max_value: 25 },
  ]),
  subcommand('disable', 'Turn off new starboard updates'),
], Permissions.ManageGuild);

export function eligibleStarboardSource(channel, guild) {
  return !!channel && textChannelTypes.includes(channel.type) && !channel.nsfw &&
    !!channel.permissionsFor(guild.roles.everyone, false)?.has(Permissions.ViewChannel);
}

export function createStarboard({ store, allowed, removeMessage, signal, logError }) {
  const { db } = store;
  const serialize = serializeByKey();
  const processing = new Map();
  const find = db.prepare('SELECT * FROM starboard_posts WHERE source_id=? AND guild_id=?');
  const forget = db.prepare('DELETE FROM starboard_posts WHERE source_id=? AND guild_id=? AND message_id=?');

  async function handleStarboard(interaction) {
    requirePermission(interaction, Permissions.ManageGuild, 'Manage Server');
    if (interaction.options.getSubcommand() === 'disable') {
      const changed = store.clear(interaction.guildId, 'starboard');
      return reply(interaction, changed ? 'Starboard is disabled.' : 'Starboard is already disabled.');
    }
    await interaction.deferReply(privateReply);
    const channel = await destination(interaction);
    const threshold = interaction.options.getInteger('threshold') ?? 3;
    store.set(interaction.guildId, 'starboard', { channelId: channel.id, threshold });
    return reply(interaction, `Starboard will post in <#${channel.id}> at ${threshold} ⭐ reactions. It highlights messages in public text and announcement channels.`);
  }

  async function deletePost(guild, post) {
    await removeMessage(guild, post.channel_id, post.message_id);
    forget.run(post.source_id, guild.id, post.message_id);
  }

  async function sync(message) {
    const { guild, guildId, channelId, id } = message;
    const settings = store.get(guildId, 'starboard');
    if (!settings || settings.channelId === channelId || !guild) return;
    const existing = find.get(id, guildId);
    const channel = await lookupChannel(guild, channelId);
    if (!eligibleStarboardSource(channel, guild)) {
      if (existing) await deletePost(guild, existing);
      return;
    }
    let source;
    try { source = await channel.messages.fetch({ message: id, force: true, cache: false }); }
    catch (error) {
      if (error.code !== RESTJSONErrorCodes.UnknownMessage) throw error;
      if (existing) await deletePost(guild, existing);
      return;
    }
    if (signal?.aborted) return;
    const latest = store.get(guildId, 'starboard');
    if (!latest || latest.channelId === channelId) return;
    const reaction = source.reactions.cache.get(star);
    // Count standard stars, one per Discord member. Super Reactions are separate.
    const count = reaction?.countDetails.normal ?? 0;
    if (count < latest.threshold) {
      if (existing) await deletePost(guild, existing);
      return;
    }
    const target = await lookupChannel(guild, latest.channelId);
    if (!target || !textChannelTypes.includes(target.type)) return;
    if (store.get(guildId, 'starboard')?.channelId !== target.id || signal?.aborted) return;
    const content = `⭐ **${count}** · [Jump to message](https://discord.com/channels/${guildId}/${channelId}/${id})`;
    if (existing) {
      if (existing.channel_id === target.id) {
        try {
          await target.messages.edit(existing.message_id, { ...publicMessage, content });
          return;
        } catch (error) { if (error.code !== RESTJSONErrorCodes.UnknownMessage) throw error; }
        forget.run(existing.source_id, guildId, existing.message_id);
      } else {
        await deletePost(guild, existing);
      }
    }
    const post = await target.send({ ...publicMessage, content });
    try {
      db.prepare('INSERT INTO starboard_posts(source_id,guild_id,source_channel_id,channel_id,message_id) VALUES(?,?,?,?,?)')
        .run(id, guildId, channelId, target.id, post.id);
    } catch (error) {
      await post.delete().catch(cleanupError => logError('starboard_cleanup_error', cleanupError));
      throw error;
    }
  }

  async function queue(message) {
    if (!message.guildId || !allowed(message.guildId) || signal?.aborted ||
      !store.get(message.guildId, 'starboard')) return;
    const state = processing.get(message.id);
    if (state) {
      state.dirty = true;
      return;
    }
    if (processing.size >= 100) return;
    const update = { dirty: true };
    processing.set(message.id, update);
    try {
      await serialize(message.id, async () => {
        while (update.dirty && !signal?.aborted) {
          update.dirty = false;
          await sync(message);
        }
      });
    } finally { processing.delete(message.id); }
  }

  function onStarReaction(reaction) {
    if (reaction.emoji.id || reaction.emoji.name !== star) return;
    return queue(reaction.message);
  }

  function onReactionClear(value) {
    return value.emoji ? onStarReaction(value) : queue(value);
  }

  async function onMessageDelete(message) {
    return serialize(message.id, async () => {
      db.prepare('DELETE FROM starboard_posts WHERE guild_id=? AND message_id=?').run(message.guildId, message.id);
      const post = find.get(message.id, message.guildId);
      if (post && message.guild) await deletePost(message.guild, post);
    });
  }

  async function onChannelDelete(channel) {
    for (const post of db.prepare('SELECT * FROM starboard_posts WHERE guild_id=? AND source_channel_id=?').all(channel.guildId, channel.id)) {
      if (signal?.aborted) return;
      await serialize(post.source_id, async () => {
        const existing = find.get(post.source_id, channel.guildId);
        if (existing) await deletePost(channel.guild, existing);
      });
    }
    db.prepare('DELETE FROM starboard_posts WHERE guild_id=? AND channel_id=?').run(channel.guildId, channel.id);
  }

  return { handleStarboard, onStarReaction, onReactionClear, onMessageDelete, onChannelDelete };
}
