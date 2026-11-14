import { randomUUID } from 'node:crypto';
import { ButtonStyle, ChannelType, ComponentType, OverwriteType,
  PermissionFlagsBits as Permissions, RESTJSONErrorCodes } from 'discord.js';
import { channelOption, command, CommunityInputError, destination, lookupChannel, privateReply, publicMessage,
  reply, requirePermission, roleOption, safeCommunityText, serializeByKey, stringOption, subcommand } from './community-common.js';

export const ticketCommand = command('ticket', 'Open or manage a private support ticket', [
  subcommand('setup', 'Choose a support role and post an Open Ticket button', [
    roleOption('staff', 'Role allowed into every ticket'),
    channelOption('channel', 'Channel for the ticket panel (default is here)'),
    channelOption('category', 'Optional category for private ticket channels', false, [ChannelType.GuildCategory]),
  ]),
  subcommand('disable', 'Turn off new tickets and remove the setup panel'),
  subcommand('open', 'Open a private support channel', [stringOption('subject', 'What you need help with', 400)]),
  subcommand('close', 'Close this ticket and make it read-only for its creator'),
  subcommand('reopen', 'Reopen this ticket (support staff only)'),
  subcommand('delete', 'Delete this closed ticket channel (support staff only)'),
]);

const openId = 'community:ticket:open';
const ticketAction = /^community:ticket:(close|reopen)$/;
const ticketTopic = id => `Owaua support ticket ${id}`;
const ticketButton = (custom_id, label, style) => ({ type: ComponentType.Button, custom_id, label, style });
const row = (...components) => [{ type: ComponentType.ActionRow, components }];
const readerPermissions = [Permissions.ViewChannel, Permissions.ReadMessageHistory];
const writerPermissions = [...readerPermissions, Permissions.SendMessages, Permissions.AttachFiles,
  Permissions.EmbedLinks, Permissions.AddReactions];
const ownerThreadRestrictions = [Permissions.CreatePublicThreads, Permissions.CreatePrivateThreads, Permissions.SendMessagesInThreads];

export function ticketOverwrites({ guildId, userId, botId, staffRoleId }) {
  const overwrites = [
    { id: guildId, type: OverwriteType.Role, deny: [Permissions.ViewChannel] },
    { id: userId, type: OverwriteType.Member, allow: writerPermissions, deny: ownerThreadRestrictions },
    { id: botId, type: OverwriteType.Member, allow: writerPermissions },
  ];
  if (staffRoleId) overwrites.push({ id: staffRoleId, type: OverwriteType.Role, allow: writerPermissions });
  return overwrites;
}

export function createTickets({ store, configure, removeMessage, logError }) {
  const { db } = store;
  const serialize = serializeByKey();
  const forOwner = (guild, ownerId, action) => serialize(`${guild.id}:${ownerId}`, action);
  const active = db.prepare("SELECT * FROM tickets WHERE guild_id=? AND owner_id=? AND status<>'closed'");
  const find = db.prepare('SELECT * FROM tickets WHERE guild_id=? AND channel_id=?');
  const remove = db.prepare('DELETE FROM tickets WHERE id=?');

  async function ticketManager(guild, categoryId) {
    const me = guild.members.me ?? await guild.members.fetchMe();
    const required = [Permissions.ManageChannels, Permissions.ManageRoles, ...writerPermissions, ...ownerThreadRestrictions];
    const category = categoryId ? await lookupChannel(guild, categoryId) : undefined;
    if (categoryId && category?.type !== ChannelType.GuildCategory) {
      throw new CommunityInputError('The ticket category was removed. Ask a moderator to run /ticket setup again.');
    }
    if (!me.permissions.has(required) || (category && !category.permissionsFor(me)?.has(required))) {
      throw new CommunityInputError('Owaua needs Manage Channels, Manage Roles, and messaging permissions in the ticket category.');
    }
    return { me, category };
  }

  async function handleSetup(interaction, action) {
    requirePermission(interaction, Permissions.ManageGuild, 'Manage Server');
    requirePermission(interaction, Permissions.ManageChannels, 'Manage Channels');
    requirePermission(interaction, Permissions.ManageRoles, 'Manage Roles');
    await interaction.deferReply(privateReply);
    const { guild, options } = interaction;
    return configure(guild.id, async () => {
      const previous = store.get(guild.id, 'ticket');
      if (action === 'disable') {
        store.clear(guild.id, 'ticket');
        if (previous) await removeMessage(guild, previous.panelChannelId, previous.panelId)
          .catch(error => logError('ticket_panel_cleanup_error', error));
        return reply(interaction, previous
          ? 'New tickets are disabled. Existing tickets can still be closed or reopened.'
          : 'New tickets are already disabled.');
      }
      const panelChannel = await destination(interaction);
      const categoryId = options.getChannel('category')?.id ?? null;
      const { category } = await ticketManager(guild, categoryId);
      const actor = await guild.members.fetch(interaction.user.id);
      if (category && !category.permissionsFor(actor)?.has([Permissions.ViewChannel, Permissions.ManageChannels])) {
        throw new CommunityInputError('You need access and Manage Channels in the selected category.');
      }
      const staffRoleId = options.getRole('staff')?.id ?? null;
      const role = staffRoleId && await guild.roles.fetch(staffRoleId);
      if (staffRoleId && (!role || role.id === guild.id || role.managed || role.tags?.availableForPurchase ||
          role.tags?.guildConnections || store.isMemberRole(guild.id, role.id) ||
          (actor.id !== guild.ownerId && actor.roles.highest.comparePositionTo(role) <= 0))) {
        throw new CommunityInputError('Choose a dedicated support role below your highest role that members cannot self-assign.');
      }
      // Publish the panel before updating settings, so a failed send leaves the previous panel intact.
      const panel = await panelChannel.send({ ...publicMessage,
        content: 'Need help? Open a private support ticket.',
        components: row(ticketButton(openId, 'Open ticket', ButtonStyle.Primary)) });
      try { store.set(guild.id, 'ticket', { staffRoleId, categoryId, panelChannelId: panelChannel.id, panelId: panel.id }); }
      catch (error) {
        await panel.delete().catch(cleanupError => logError('ticket_panel_cleanup_error', cleanupError));
        throw error;
      }
      if (previous) await removeMessage(guild, previous.panelChannelId, previous.panelId)
        .catch(error => logError('ticket_panel_cleanup_error', error));
      return reply(interaction, `Posted the ticket panel in <#${panelChannel.id}>.${staffRoleId ? '' : ' Server administrators can access tickets.'}`);
    });
  }

  async function openTicket(interaction, fromPanel) {
    const { guild, user } = interaction;
    await interaction.deferReply(privateReply);
    return forOwner(guild, user.id, async () => {
      const settings = store.get(guild.id, 'ticket');
      if (!settings || (fromPanel && (settings.panelId !== interaction.message.id ||
        settings.panelChannelId !== interaction.channelId))) {
        throw new CommunityInputError('This ticket panel is unavailable. Ask a moderator to set it up.');
      }
      const member = await guild.members.fetch({ user: user.id, force: true });
      if (member.pending) throw new CommunityInputError('Finish the server’s membership screening first.');
      const subject = fromPanel ? null : interaction.options.getString('subject');
      const content = subject === null ? 'Share what you need help with here.'
        : `**Support request**\n${safeCommunityText(subject, guild.id)}`;

      let ticket = active.get(guild.id, user.id);
      if (ticket?.channel_id) {
        const channel = await lookupChannel(guild, ticket.channel_id);
        if (channel) return reply(interaction, `You already have an open ticket in <#${channel.id}>.`);
        remove.run(ticket.id);
        ticket = undefined;
      }
      // A process restart between the Discord response and the SQLite update can
      // leave an opening record. Recover its channel from the unique topic.
      let channel;
      if (ticket) {
        channel = (await guild.channels.fetch()).find(item => item?.type === ChannelType.GuildText &&
          item.topic === ticketTopic(ticket.id));
      }
      if (!channel) {
        const { me, category } = await ticketManager(guild, settings.categoryId);
        if (settings.staffRoleId) {
          const staff = await guild.roles.fetch(settings.staffRoleId, { force: true });
          if (!staff || staff.managed || staff.tags?.availableForPurchase || staff.tags?.guildConnections ||
            store.isMemberRole(guild.id, staff.id)) {
            throw new CommunityInputError('The support role is no longer available. Ask a moderator to run /ticket setup again.');
          }
        }
        if (store.get(guild.id, 'ticket')?.panelId !== settings.panelId) {
          throw new CommunityInputError('Ticket setup changed. Try opening the ticket again.');
        }
        if (!ticket) {
          const retained = db.prepare('SELECT COUNT(*) AS count FROM tickets WHERE guild_id=? AND owner_id=?').get(guild.id, user.id).count;
          if (retained >= 5) throw new CommunityInputError('You have five tickets. Ask the support team to delete a closed ticket before opening another.');
          const total = db.prepare('SELECT COUNT(*) AS count FROM tickets WHERE guild_id=?').get(guild.id).count;
          if (total >= 100) throw new CommunityInputError('This server has 100 tickets. Ask the support team to delete closed tickets.');
        }
        const id = ticket?.id ?? randomUUID();
        db.prepare(`INSERT INTO tickets(id,guild_id,owner_id,staff_role_id,category_id,status) VALUES(?,?,?,?,?,'opening')
            ON CONFLICT(id) DO UPDATE SET staff_role_id=excluded.staff_role_id, category_id=excluded.category_id`)
          .run(id, guild.id, user.id, settings.staffRoleId, category?.id ?? null);
        ticket = active.get(guild.id, user.id);
        try {
          channel = await guild.channels.create({
            name: `ticket-${id.slice(0, 8)}`, topic: ticketTopic(id), type: ChannelType.GuildText,
            ...(category ? { parent: category.id } : {}),
            permissionOverwrites: ticketOverwrites({
              guildId: guild.id, userId: user.id, botId: me.id, staffRoleId: settings.staffRoleId,
            }),
            reason: 'Owaua support ticket',
          });
        } catch (error) {
          // A definitive client-side rejection did not create a channel.
          if (error.status >= 400 && error.status < 500 && error.status !== 429) remove.run(id);
          throw error;
        }
      }
      db.prepare("UPDATE tickets SET channel_id=?,status='open' WHERE id=?").run(channel.id, ticket.id);
      await channel.send({ ...publicMessage, content,
        components: row(ticketButton('community:ticket:close', 'Close ticket', ButtonStyle.Danger),
          ticketButton('community:ticket:reopen', 'Reopen ticket', ButtonStyle.Secondary)) })
        .catch(error => logError('ticket_message_error', error));
      return reply(interaction, `Your private ticket is ready in <#${channel.id}>.`);
    });
  }

  async function changeTicket(interaction, action) {
    const { guild, channelId, user } = interaction;
    const record = find.get(guild.id, channelId);
    if (!record) throw new CommunityInputError('Use this action inside an Owaua ticket channel.');
    await interaction.deferReply(privateReply);
    return forOwner(guild, record.owner_id, async () => {
      // Reread after waiting for any earlier close, reopen or deletion.
      const ticket = find.get(guild.id, channelId);
      if (!ticket) throw new CommunityInputError('This ticket is no longer available.');
      const me = await guild.members.fetchMe();
      const member = await guild.members.fetch({ user: user.id, force: true });
      const channel = await lookupChannel(guild, channelId, { force: true });
      if (!channel || channel.type !== ChannelType.GuildText ||
        !channel.permissionsFor(member)?.has(Permissions.ViewChannel)) {
        throw new CommunityInputError('This ticket is no longer available.');
      }
      const isStaff = member.permissions.has(Permissions.ManageGuild) ||
        !!(ticket.staff_role_id && member.roles.cache.has(ticket.staff_role_id));
      if (member.pending || (!isStaff && (action !== 'close' || ticket.owner_id !== user.id))) {
        throw new CommunityInputError('Only support staff can do that.');
      }
      if (action === 'delete') {
        if (ticket.status !== 'closed') throw new CommunityInputError('Close this ticket before deleting it.');
        if (!channel.permissionsFor(me)?.has(Permissions.ManageChannels)) {
          throw new CommunityInputError('Owaua needs Manage Channels in this ticket.');
        }
        await reply(interaction, 'Deleting this closed ticket…');
        await channel.delete('Closed support ticket removed');
        remove.run(ticket.id);
        return;
      }
      const open = action === 'reopen';
      if (ticket.status === (open ? 'open' : 'closed')) return reply(interaction, `This ticket is already ${ticket.status}.`);
      if (open && active.get(guild.id, ticket.owner_id)) {
        throw new CommunityInputError('Close the creator’s other open ticket first.');
      }
      if (!channel.permissionsFor(me)?.has(Permissions.ManageRoles)) {
        throw new CommunityInputError('Owaua needs Manage Roles in this ticket to change access.');
      }
      try {
        await channel.permissionOverwrites.edit(ticket.owner_id, { SendMessages: open, AddReactions: open },
          { type: OverwriteType.Member, reason: open ? 'Support ticket reopened' : 'Support ticket closed' });
      } catch (error) {
        // Discord can reject an overwrite for a member who left the server.
        if (open || error.code !== RESTJSONErrorCodes.UnknownMember) throw error;
      }
      db.prepare('UPDATE tickets SET status=? WHERE id=?').run(open ? 'open' : 'closed', ticket.id);
      await channel.send({ ...publicMessage, content: open ? 'This ticket was reopened.' : 'This ticket was closed.' })
        .catch(error => logError('ticket_message_error', error));
      return reply(interaction, open ? 'Reopened this ticket.' : 'Closed this ticket.');
    });
  }

  function handleTickets(interaction) {
    const action = interaction.options.getSubcommand();
    if (action === 'setup' || action === 'disable') return handleSetup(interaction, action);
    if (action === 'open') return openTicket(interaction, false);
    return changeTicket(interaction, action);
  }

  function handleTicketComponent(interaction) {
    if (!interaction.isButton()) return;
    if (interaction.customId === openId) return openTicket(interaction, true);
    const action = ticketAction.exec(interaction.customId)?.[1];
    if (action && interaction.message.author?.id === interaction.client.user.id) return changeTicket(interaction, action);
  }

  return { handleTickets, handleTicketComponent };
}
