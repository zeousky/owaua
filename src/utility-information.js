import { ApplicationCommandOptionType as Option, ChannelType, InteractionContextType } from 'discord.js';
import { discordDate, safeDisplayText, UtilityInputError } from './utility-input.js';

const user = { type: Option.User, name: 'user', description: 'User to look up (defaults to you)' };
const guild = [InteractionContextType.Guild];
export const informationCommands = [
  { name: 'userinfo', description: 'See a user’s account and server profile', options: [user] },
  { name: 'avatar', description: 'View someone’s Discord avatar', options: [user] },
  { name: 'serverinfo', description: 'See this server’s information and statistics', contexts: guild },
  { name: 'roleinfo', description: 'See a role’s color, ID, and permissions', contexts: guild, options: [
    { type: Option.Role, name: 'role', description: 'Role to look up', required: true },
  ] },
];

function roleNames(roles) {
  const names = roles.first(8).map(role => safeDisplayText(role.name, 'Role'));
  if (roles.size > names.length) names.push(`and ${roles.size - names.length} more`);
  return names.join(', ') || 'None';
}

function displayUser(interaction) {
  return interaction.options.getUser('user') ?? interaction.user;
}

function displayMember(interaction, user) {
  return interaction.guild?.members.cache.get(user.id) ??
    (user.id === interaction.user.id ? interaction.member : interaction.options.getMember('user'));
}

function separatedPermissionName(name) {
  return name.replace(/(?<=[a-z])(?=[A-Z])/gu, ' ');
}

const informationHandlers = {
  userinfo(interaction) {
    const user = displayUser(interaction);
    const member = displayMember(interaction, user);
    let description = `**ID** \`${user.id}\`\n**Account created** ${discordDate(user.createdTimestamp)}\n**Account** ${user.bot ? 'Bot' : 'User'}`;
    if (member?.joinedTimestamp) description += `\n**Joined** ${discordDate(member.joinedTimestamp)}`;
    const roles = member?.roles?.cache
      ?.filter(role => role.id !== interaction.guildId)
      .sort((left, right) => right.comparePositionTo(left));
    if (roles) description += `\n**Roles** ${roleNames(roles)}`;
    return { embeds: [{ title: safeDisplayText(member?.displayName ?? user.displayName ?? user.username), description,
      thumbnail: { url: member?.displayAvatarURL?.() ?? user.displayAvatarURL() } }] };
  },
  avatar(interaction) {
    const user = displayUser(interaction);
    const member = displayMember(interaction, user);
    const imageOptions = { size: 1024, forceStatic: false };
    const accountAvatar = user.displayAvatarURL(imageOptions);
    const displayAvatar = member?.displayAvatarURL?.(imageOptions) ?? accountAvatar;
    return { embeds: [{
      title: `Avatar for ${safeDisplayText(member?.displayName ?? user.displayName ?? user.username)}`,
      image: { url: displayAvatar },
      description: displayAvatar === accountAvatar ? '[Open image](' + accountAvatar + ')' :
        '[Server avatar](' + displayAvatar + ') · [Account avatar](' + accountAvatar + ')',
    }] };
  },
  serverinfo({ guild, member, user }) {
    if (!guild) throw new UtilityInputError('Use this command in a server.');
    const channels = guild.channels.cache.filter(channel => !channel.isThread() && channel.type !== ChannelType.GuildCategory &&
      channel.permissionsFor(member?.id ?? user.id)?.has('ViewChannel')).size;
    const icon = guild.iconURL();
    return { embeds: [{ title: safeDisplayText(guild.name), description: [
      `**ID** \`${guild.id}\``, `**Owner** <@${guild.ownerId}>`, `**Created** ${discordDate(guild.createdTimestamp)}`,
      `**Members** ${guild.memberCount.toLocaleString('en-US')}`, `**Channels you can see** ${channels}`,
      `**Roles** ${Math.max(0, guild.roles.cache.size - 1)}`, `**Boosts** ${guild.premiumSubscriptionCount ?? 0}`,
    ].join('\n'), ...(icon ? { thumbnail: { url: icon } } : {}) }] };
  },
  roleinfo({ guild, options }) {
    if (!guild) throw new UtilityInputError('Use this command in a server.');
    const role = options.getRole('role', true);
    const permissions = role.permissions.toArray().map(separatedPermissionName).join(' · ');
    return { embeds: [{ title: safeDisplayText(role.name), color: role.color, description: [
      `**ID** \`${role.id}\``, `**Color** ${role.hexColor}`, `**Created** ${discordDate(role.createdTimestamp)}`,
      `**Hoisted** ${role.hoist ? 'Yes' : 'No'}`, `**Mentionable** ${role.mentionable ? 'Yes' : 'No'}`,
      `**Managed by an integration** ${role.managed ? 'Yes' : 'No'}`, `**Server permissions**\n${permissions || 'None'}`,
    ].join('\n') }] };
  },
};

export function handleInformationCommand(interaction) {
  return informationHandlers[interaction.commandName](interaction);
}
