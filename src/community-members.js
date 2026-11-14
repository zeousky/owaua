import { ApplicationCommandOptionType as Option, ButtonStyle, ComponentType, GatewayIntentBits,
  PermissionFlagsBits as Permissions } from 'discord.js';
import { channelOption, command, CommunityInputError, destination, lookupChannel, privateReply, publicMessage,
  quiet, reply, requirePermission, roleOption, safeCommunityText, serializeByKey, stringOption, subcommand,
  textChannelTypes } from './community-common.js';

const roleOptionNames = ['role', 'role_2', 'role_3', 'role_4', 'role_5'];
const ordinaryRolePermissions = [
  'CreateInstantInvite', 'AddReactions', 'Stream', 'ViewChannel', 'SendMessages', 'EmbedLinks',
  'AttachFiles', 'ReadMessageHistory', 'UseExternalEmojis', 'Connect', 'Speak', 'UseVAD',
  'ChangeNickname', 'UseApplicationCommands', 'RequestToSpeak', 'CreatePublicThreads',
  'UseExternalStickers', 'SendMessagesInThreads', 'UseEmbeddedActivities', 'UseSoundboard',
  'UseExternalSounds', 'SendVoiceMessages', 'SendPolls', 'UseExternalApps',
].reduce((bits, name) => bits | Permissions[name], 0n);

export const memberCommands = [
  command('roles', 'Create or remove self-assignable role panels', [
    subcommand('create', 'Post a panel allowing members to toggle the selected roles', [
      roleOption(roleOptionNames[0], 'First assignable role', true),
      ...roleOptionNames.slice(1).map((name, i) => roleOption(name, `Assignable role ${i + 2}`)),
      channelOption('channel', 'Channel to post the panel in (default is here)'),
      { type: Option.String, name: 'style', description: 'How members choose roles', choices: [
        { name: 'Buttons', value: 'buttons' }, { name: 'Dropdown', value: 'dropdown' },
      ] },
      stringOption('message', 'Panel text', 500),
    ]),
    subcommand('remove', 'Remove a role panel by its Discord message ID', [
      stringOption('message_id', 'Discord message ID of the panel', 20, true),
    ]),
  ], Permissions.ManageRoles),
  command('welcome', 'Configure welcome messages, goodbye messages and autoroles', [
    subcommand('setup', 'Set the greeting channel and optionally add goodbye text and a role', [
      channelOption('channel', 'Channel for the greetings', true),
      stringOption('welcome', 'Welcome text. Placeholders: {member}, {server}, {count}', 500),
      stringOption('goodbye', 'Optional goodbye text. Placeholders: {member}, {server}, {count}', 500),
      roleOption('role', 'Optional role for new members'),
    ]),
    subcommand('disable', 'Turn off greetings and autoroles'),
  ], Permissions.ManageGuild),
];

export function isAssignableRole(guild, role, bot, actor, channels = []) {
  if (!role || role.id === guild.id || role.managed || role.tags?.availableForPurchase ||
    role.tags?.guildConnections || (role.permissions.bitfield & ~ordinaryRolePermissions) !== 0n ||
    !bot?.permissions.has(Permissions.ManageRoles) || bot.roles.highest.comparePositionTo(role) <= 0) return false;
  if (actor && actor.id !== guild.ownerId && actor.roles.highest.comparePositionTo(role) <= 0) return false;
  return ![...channels].some(channel => {
    const overwrite = channel?.permissionOverwrites?.cache.get(role.id);
    return overwrite && (overwrite.allow.bitfield & ~ordinaryRolePermissions) !== 0n;
  });
}

function requireAssignableRole(guild, role, bot, actor, store, channels) {
  if (!isAssignableRole(guild, role, bot, actor, channels) || store.isSupportRole(guild.id, role.id)) {
    throw new CommunityInputError('Choose ordinary roles below both your highest role and Owaua’s, with no moderation or administrative permissions in the server or its channels.');
  }
}

export function greetingText(template, member, joining) {
  const guild = member.guild;
  const replacements = {
    member: joining ? `<@${member.id}>` : member.user?.username ?? 'Someone',
    server: guild.name,
    count: String(guild.memberCount),
  };
  return template.replace(/\{(member|server|count)\}/g, (_, key) => replacements[key]).slice(0, 2000);
}

function panelComponents(roles, style, guildId) {
  const labels = roles.map((role, index) => {
    try { return safeCommunityText(role.name, guildId); }
    catch { return `Role ${index + 1}`; }
  });
  const components = style === 'dropdown' ? [{
    type: ComponentType.StringSelect, custom_id: 'community:roles:select', placeholder: 'Toggle a role',
    options: roles.map((role, index) => ({ label: labels[index].slice(0, 100), value: role.id })),
  }] : roles.map((role, index) => ({
    type: ComponentType.Button, style: ButtonStyle.Secondary, label: labels[index].slice(0, 80).toWellFormed(),
    custom_id: `community:roles:${role.id}`,
  }));
  return [{ type: ComponentType.ActionRow, components }];
}

export function createMemberFeatures({ store, client, configure, removeMessage, logError }) {
  const { db } = store;
  const assign = serializeByKey();
  const findPanel = db.prepare('SELECT * FROM role_panels WHERE guild_id=? AND message_id=?');
  const forgetPanel = db.prepare('DELETE FROM role_panels WHERE guild_id=? AND message_id=?');
  const pending = db.prepare('SELECT role_id FROM pending_autoroles WHERE guild_id=? AND user_id=?');
  const clearPending = db.prepare('DELETE FROM pending_autoroles WHERE guild_id=? AND user_id=?');

  async function handleRoles(interaction) {
    requirePermission(interaction, Permissions.ManageRoles, 'Manage Roles');
    await interaction.deferReply(privateReply);
    return configure(interaction.guildId, async () => {
      const { guild, options } = interaction;
      if (options.getSubcommand() === 'remove') {
        const messageId = options.getString('message_id', true).trim();
        const panel = findPanel.get(guild.id, messageId);
        if (!panel) throw new CommunityInputError('I couldn’t find that role panel in this server.');
        const panelChannel = await lookupChannel(guild, panel.channel_id, { force: true });
        const actor = await guild.members.fetch({ user: interaction.user.id, force: true });
        if (panelChannel && !panelChannel.permissionsFor(actor)?.has(Permissions.ViewChannel)) {
          throw new CommunityInputError('I couldn’t find that role panel in this server.');
        }
        await removeMessage(guild, panel.channel_id, panel.message_id);
        forgetPanel.run(guild.id, panel.message_id);
        return reply(interaction, 'Removed the role panel.');
      }
      if (db.prepare('SELECT COUNT(*) AS count FROM role_panels WHERE guild_id=?').get(guild.id).count >= 100) {
        throw new CommunityInputError('This server already has 100 role panels. Remove one first.');
      }
      const supplied = roleOptionNames.map(name => options.getRole(name)?.id).filter(Boolean);
      if (new Set(supplied).size !== supplied.length) throw new CommunityInputError('Choose each role only once.');
      const channel = await destination(interaction);
      const [roles, bot, actor, channels] = await Promise.all([
        guild.roles.fetch(), guild.members.fetchMe({ force: true }),
        guild.members.fetch({ user: interaction.user.id, force: true }), guild.channels.fetch(),
      ]);
      const selected = supplied.map(id => roles.get(id));
      for (const role of selected) requireAssignableRole(guild, role, bot, actor, store, channels.values());
      const label = safeCommunityText(options.getString('message') ?? 'Choose a role to add or remove it.', guild.id);
      for (const role of selected) store.markMemberRole(guild.id, role.id);
      const style = options.getString('style') ?? 'buttons';
      const message = await channel.send({ ...publicMessage,
        content: label, components: panelComponents(selected, style, guild.id) });
      try {
        db.prepare('INSERT INTO role_panels(message_id,guild_id,channel_id,mode,role_ids) VALUES(?,?,?,?,?)')
          .run(message.id, guild.id, channel.id, style, JSON.stringify(supplied));
      } catch (error) {
        await message.delete().catch(cleanupError => logError('role_panel_cleanup_error', cleanupError));
        throw error;
      }
      return reply(interaction, `Posted the role panel in <#${channel.id}>. Message ID: \`${message.id}\`.`);
    });
  }

  async function handleRoleToggle(interaction) {
    const panel = findPanel.get(interaction.guildId, interaction.message.id);
    const isDropdown = interaction.isStringSelectMenu() && interaction.customId === 'community:roles:select';
    const buttonRole = interaction.isButton() && /^community:roles:(\d{17,20})$/.exec(interaction.customId)?.[1];
    const roleId = isDropdown && interaction.values.length === 1 ? interaction.values[0] : buttonRole;
    if (!panel || interaction.channelId !== panel.channel_id || !roleId ||
      isDropdown !== (panel.mode === 'dropdown') || !JSON.parse(panel.role_ids).includes(roleId)) {
      throw new CommunityInputError('That role panel is no longer available.');
    }
    await interaction.deferReply(privateReply);
    const { guild } = interaction;
    return assign(`${guild.id}:${interaction.user.id}`, async () => {
      if (!findPanel.get(guild.id, panel.message_id)) throw new CommunityInputError('This panel was removed.');
      const [member, role, bot, channels] = await Promise.all([
        guild.members.fetch({ user: interaction.user.id, force: true }),
        guild.roles.fetch(roleId, { force: true }), guild.members.fetchMe({ force: true }), guild.channels.fetch(),
      ]);
      if (member.pending) throw new CommunityInputError('Finish the server’s membership screening first.');
      requireAssignableRole(guild, role, bot, undefined, store, channels.values());
      const remove = member.roles.cache.has(roleId);
      if (remove) await member.roles.remove(roleId, 'Self-assignable role panel');
      else await member.roles.add(roleId, 'Self-assignable role panel');
      return reply(interaction, `${remove ? 'Removed' : 'Added'} <@&${roleId}>.`);
    });
  }

  async function handleWelcome(interaction) {
    requirePermission(interaction, Permissions.ManageGuild, 'Manage Server');
    const { guild, options } = interaction;
    const disable = options.getSubcommand() === 'disable';
    if (!disable && !client.options.intents.has(GatewayIntentBits.GuildMembers)) {
      throw new CommunityInputError('Welcome setup needs the Server Members Intent. Enable it for the Discord application and set OWAUA_GUILD_MEMBERS_INTENT=true.');
    }
    await interaction.deferReply(privateReply);
    return configure(guild.id, async () => {
      if (disable) {
        const changed = store.clear(guild.id, 'welcome');
        db.prepare('DELETE FROM pending_autoroles WHERE guild_id=?').run(guild.id);
        return reply(interaction, changed ? 'Disabled greetings and autoroles.' : 'Greetings and autoroles are already off.');
      }
      const channel = await destination(interaction);
      const roleId = options.getRole('role')?.id ?? null;
      if (roleId) {
        requirePermission(interaction, Permissions.ManageRoles, 'Manage Roles');
        const [role, bot, actor, channels] = await Promise.all([
          guild.roles.fetch(roleId, { force: true }), guild.members.fetchMe({ force: true }),
          guild.members.fetch({ user: interaction.user.id, force: true }), guild.channels.fetch(),
        ]);
        requireAssignableRole(guild, role, bot, actor, store, channels.values());
      }
      const welcome = safeCommunityText(options.getString('welcome') ?? 'Welcome to {server}, {member}!', guild.id);
      const goodbyeOption = options.getString('goodbye');
      const goodbye = goodbyeOption === null ? null : safeCommunityText(goodbyeOption, guild.id);
      if (roleId) store.markMemberRole(guild.id, roleId);
      store.set(guild.id, 'welcome', { channelId: channel.id, welcome, goodbye, roleId });
      return reply(interaction, `Welcome messages are set for <#${channel.id}>.${goodbye ? ' Goodbye messages are on.' : ''}${roleId ? ' Autorole is on.' : ''}`);
    });
  }

  async function applyWelcomeRole(member, roleId) {
    if (!roleId) return;
    if (member.pending) {
      db.prepare(`INSERT INTO pending_autoroles(guild_id,user_id,role_id) VALUES(?,?,?)
        ON CONFLICT(guild_id,user_id) DO UPDATE SET role_id=excluded.role_id`)
        .run(member.guild.id, member.id, roleId);
      return;
    }
    const guild = member.guild;
    const [role, bot, channels] = await Promise.all([
      guild.roles.fetch(roleId, { force: true }), guild.members.fetchMe({ force: true }), guild.channels.fetch(),
    ]);
    if (store.get(guild.id, 'welcome')?.roleId === roleId &&
      isAssignableRole(guild, role, bot, undefined, channels.values()) && !store.isSupportRole(member.guild.id, roleId)) {
      await member.roles.add(role, 'Welcome autorole');
    }
  }

  async function sendGreeting(member, settings, joining) {
    const template = joining ? settings.welcome : settings.goodbye;
    if (!template) return;
    const channel = await lookupChannel(member.guild, settings.channelId);
    if (!channel || !textChannelTypes.includes(channel.type)) return;
    let content;
    try { content = safeCommunityText(greetingText(template, member, joining), member.guild.id); }
    catch { content = joining ? `Welcome, <@${member.id}>!` : 'A member left the server.'; }
    await channel.send({ ...publicMessage, content,
      allowedMentions: joining && template.includes('{member}') ? { ...quiet, users: [member.id] } : quiet });
  }

  async function onMemberAdd(member) {
    if (member.user?.bot) return;
    const settings = store.get(member.guild.id, 'welcome');
    if (!settings) return;
    await Promise.all([
      sendGreeting(member, settings, true).catch(error => logError('welcome_message_error', error)),
      applyWelcomeRole(member, settings.roleId).catch(error => logError('welcome_autorole_error', error)),
    ]);
  }

  async function onMemberRemove(member) {
    clearPending.run(member.guild.id, member.id);
    const settings = store.get(member.guild.id, 'welcome');
    if (settings && !member.user?.bot) await sendGreeting(member, settings, false);
  }

  async function onMemberUpdate(member) {
    if (member.pending || member.user?.bot) return;
    const record = pending.get(member.guild.id, member.id);
    if (!record) return;
    await applyWelcomeRole(member, record.role_id);
    clearPending.run(member.guild.id, member.id);
  }

  return { handleRoles, handleRoleToggle, handleWelcome, onMemberAdd, onMemberRemove, onMemberUpdate };
}
