import { withServerLanguage } from './server-language.js';
import { withRequestUser } from './safety.js';
import { communityError, removeMessage, reply, serializeByKey } from './community-common.js';
import { openCommunityStore } from './community-store.js';
import { createMemberFeatures, memberCommands } from './community-members.js';
import { createStarboard, starboardCommand } from './community-starboard.js';
import { createTickets, ticketCommand } from './community-tickets.js';

export const communityCommands = [...memberCommands, starboardCommand, ticketCommand];

export function createCommunityFeatures({ directory, client, allowed, signal, logError }) {
  const store = openCommunityStore(directory);
  const configure = serializeByKey();
  const members = createMemberFeatures({ store, client, configure, removeMessage, logError });
  const stars = createStarboard({ store, allowed, removeMessage, signal, logError });
  const tickets = createTickets({ store, configure, removeMessage, logError });
  const handlers = {
    roles: members.handleRoles, welcome: members.handleWelcome,
    starboard: stars.handleStarboard, ticket: tickets.handleTickets,
  };
  const active = new Set();
  let stopping = false;

  function track(guildId, action, onError) {
    if (!guildId || !allowed(guildId) || stopping || signal?.aborted) return;
    const task = withServerLanguage(guildId, async () => {
      try { await action(); }
      catch (error) { await onError(error); }
    });
    active.add(task);
    void task.finally(() => active.delete(task)).catch(error => logError('community_handler_error', error));
    return task;
  }

  function interactionAction(interaction, run) {
    return track(interaction.guildId, () => withRequestUser(interaction.user.id, () => run(interaction)), async error => {
      if (!error.message || communityError(error) !== error.message) logError('community_interaction_error', error);
      if (!interaction.replied || interaction.deferred) await reply(interaction, communityError(error))
        .catch(replyError => logError('community_reply_error', replyError));
    });
  }
  function handleCommand(interaction) {
    if (!Object.hasOwn(handlers, interaction.commandName) || !interaction.guild) return;
    return interactionAction(interaction, handlers[interaction.commandName]);
  }
  function handleComponent(interaction) {
    if (!interaction.guild || !interaction.customId?.startsWith('community:')) return;
    if (interaction.customId.startsWith('community:roles:')) return interactionAction(interaction, members.handleRoleToggle);
    if (interaction.customId.startsWith('community:ticket:')) return interactionAction(interaction, tickets.handleTicketComponent);
  }
  function onMessageDelete(message) {
    return track(message.guildId, async () => {
      store.db.prepare('DELETE FROM role_panels WHERE guild_id=? AND message_id=?').run(message.guildId, message.id);
      await stars.onMessageDelete(message);
    }, error => logError('community_message_delete_error', error));
  }
  function onChannelDelete(channel) {
    return track(channel.guildId, async () => {
      store.db.prepare('DELETE FROM role_panels WHERE guild_id=? AND channel_id=?').run(channel.guildId, channel.id);
      store.db.prepare('DELETE FROM tickets WHERE guild_id=? AND channel_id=?').run(channel.guildId, channel.id);
      for (const feature of ['starboard', 'welcome']) {
        if (store.get(channel.guildId, feature)?.channelId === channel.id) store.clear(channel.guildId, feature);
      }
      const ticket = store.get(channel.guildId, 'ticket');
      if (ticket?.panelChannelId === channel.id || ticket?.categoryId === channel.id) store.clear(channel.guildId, 'ticket');
      await stars.onChannelDelete(channel);
    }, error => logError('community_channel_delete_error', error));
  }

  const memberEvent = run => member => track(member.guild.id, () => run(member),
    error => logError('community_member_event_error', error));
  const reactionEvent = run => value => track((value.message ?? value).guildId, () => run(value),
    error => logError('starboard_update_error', error));

  const updateMember = memberEvent(members.onMemberUpdate);
  return {
    handleCommand, handleComponent,
    onMemberAdd: memberEvent(members.onMemberAdd), onMemberRemove: memberEvent(members.onMemberRemove),
    onMemberUpdate: (_oldMember, newMember) => updateMember(newMember),
    onReactionAdd: reactionEvent(stars.onStarReaction), onReactionRemove: reactionEvent(stars.onStarReaction),
    onReactionClear: reactionEvent(stars.onReactionClear),
    onMessageDelete, onChannelDelete,
    onMessagesDelete: messages => Promise.allSettled([...messages.values()].map(onMessageDelete)),
    async close() {
      stopping = true;
      await Promise.allSettled(active);
      store.db.close();
    },
  };
}
