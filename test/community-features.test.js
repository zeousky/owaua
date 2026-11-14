import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ChannelType, Client, MessagePayload, PermissionFlagsBits as Permissions, PermissionsBitField } from 'discord.js';
import { communityCommands, createCommunityFeatures } from '../src/community-features.js';

const ids = {
  guild: '1440000000000000000', admin: '1440000000000000001', member: '1440000000000000002',
  bot: '1440000000000000003', role: '1440000000000000004', base: '1440000000000000005',
  board: '1440000000000000006', panel: '1440000000000000007', source: '1440000000000000008',
  staff: '1440000000000000009',
};
const all = new PermissionsBitField(Permissions.Administrator);
const ordinary = new PermissionsBitField([Permissions.ViewChannel, Permissions.SendMessages]);

function createFixture(t, { guildMembers = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'owaua-community-'));
  const client = new Client({ intents: guildMembers ? ['GuildMembers'] : [] });
  t.after(() => client.destroy());
  const role = { id: ids.role, name: 'Gaming', permissions: ordinary, managed: false };
  const staffRole = { ...role, id: ids.staff, name: 'Support' };
  const topRole = { comparePositionTo: () => 1 };
  const granted = new Map();
  const actor = {
    id: ids.admin, permissions: all, roles: { highest: topRole, cache: new Map() }, pending: false,
  };
  const bot = { ...actor, id: ids.bot };
  const member = {
    user: { id: ids.member, username: 'Member', bot: false }, id: ids.member, permissions: ordinary, pending: false,
    roles: { cache: granted, add: async role => granted.set(role?.id ?? role, role), remove: async id => granted.delete(id) },
  };
  const guild = {
    id: ids.guild, ownerId: ids.admin, name: 'Test Guild', memberCount: 42,
    members: { me: bot, fetchMe: async () => bot, fetch: async input => {
      const id = typeof input === 'string' ? input : input.user;
      return id === ids.admin ? actor : member;
    } },
    roles: { everyone: { id: ids.guild }, fetch: async id => {
      if (id === undefined) return new Map([[role.id, role], [staffRole.id, staffRole]]);
      return id === staffRole.id ? staffRole : role;
    } },
  };
  member.guild = guild;

  const channels = new Map();
  const addChannel = id => {
    const messages = new Map();
    const edits = [];
    const channel = { id, guild, guildId: guild.id, type: ChannelType.GuildText,
      permissionOverwrites: {
        cache: new Map(), edit: async (...args) => edits.push(args),
      },
      permissionsFor: () => all,
      isTextBased: () => true,
      send: async payload => {
        // Match the runtime serialization of raw Discord components and flags.
        const body = MessagePayload.create({ client }, payload).resolveBody().body;
        const sent = { id: ids.panel, body, delete: async () => messages.delete(ids.panel) };
        messages.set(sent.id, sent);
        return sent;
      },
      messages: {
        fetch: async params => messages.get(params.message),
        edit: async (id, payload) => { messages.get(id).body.content = payload.content; },
        delete: async id => messages.delete(id),
      },
      mock: { messages, edits },
    };
    channels.set(id, channel);
    return channel;
  };
  const base = addChannel(ids.base);
  const board = addChannel(ids.board);
  const requests = [];
  guild.channels = {
    fetch: async id => id === undefined ? channels : channels.get(id),
    create: async payload => {
      requests.push(payload);
      const channel = addChannel(`14400000000000000${20 + requests.length}`);
      channel.topic = payload.topic;
      return channel;
    },
  };
  const errors = [];
  const features = createCommunityFeatures({
    directory, client, allowed: id => id === ids.guild, logError: (_, error) => errors.push(error),
  });
  t.after(async () => {
    await features.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function interaction(commandName, subcommand, opts = {}, user = actor, channelId = base.id) {
    return {
      commandName, guild, guildId: guild.id, user, channelId, member: user,
      memberPermissions: user.permissions, client: { user: bot },
      options: {
        getSubcommand: () => subcommand,
        getString: name => opts[name] ?? null,
        getRole: name => opts[name] ?? null,
        getChannel: name => opts[name] ?? null,
        getInteger: name => opts[name] ?? null,
      },
      isButton: () => false,
      isStringSelectMenu: () => false,
      async deferReply() { this.deferred = true; },
      async reply(payload) { this.response = payload.content; this.replied = true; },
      async editReply(payload) { this.response = payload.content; this.replied = true; },
    };
  }
  return { features, channels, base, board, role, staffRole, member, interaction, errors, requests };
}

test('community commands are guild-only and register within command limits', () => {
  assert.deepEqual(communityCommands.map(item => item.name), ['roles', 'welcome', 'starboard', 'ticket']);
  for (const command of communityCommands) {
    assert.deepEqual(command.contexts, [0]);
    for (const entry of [command, ...command.options, ...command.options.flatMap(option => option.options)]) {
      assert.ok(entry.description.length <= 100);
      assert.ok(entry.name.length <= 32);
      if (entry.options) assert.ok(entry.options.length <= 25);
    }
  }
});

test('role panels serialize Discord IDs and reject stale privileged or unlisted roles', async t => {
  const { features, base, role, staffRole, member, interaction } = createFixture(t);
  const setup = interaction('roles', 'create', { role, style: 'dropdown' });
  await features.handleCommand(setup);
  const menu = base.mock.messages.get(ids.panel).body.components[0].components[0];
  assert.equal(menu.custom_id, 'community:roles:select');
  assert.deepEqual(menu.options, [{ label: 'Gaming', value: role.id }]);
  const toggle = roleId => ({
    ...interaction('', '', {}, member),
    customId: menu.custom_id, values: [roleId], message: { id: ids.panel },
    isStringSelectMenu: () => true,
  });
  const invalid = toggle(staffRole.id);
  await features.handleComponent(invalid);
  assert.match(invalid.response, /no longer available/);
  assert.equal(member.roles.cache.size, 0);

  base.permissionOverwrites.cache.set(role.id, { allow: new PermissionsBitField(Permissions.ManageMessages) });
  const privileged = toggle(role.id);
  await features.handleComponent(privileged);
  assert.match(privileged.response, /no moderation or administrative permissions/);
  assert.equal(member.roles.cache.size, 0);
  base.permissionOverwrites.cache.clear();

  const add = toggle(role.id);
  await features.handleComponent(add);
  assert.match(add.response, /^Added/);
  assert.equal(member.roles.cache.has(role.id), true);
  const remove = toggle(role.id);
  await features.handleComponent(remove);
  assert.match(remove.response, /^Removed/);
  assert.equal(member.roles.cache.size, 0);
});

test('welcome sends only the authorized greeting mention and defers the autorole until screening passes', async t => {
  const { features, base, role, member, interaction } = createFixture(t);
  member.pending = true;
  const setup = interaction('welcome', 'setup', { channel: base, role, welcome: 'Hi {member}, welcome to {server}! @everyone',
    goodbye: 'Goodbye, {member}. Members left: {count}.' });
  await features.handleCommand(setup);
  assert.match(setup.response, /Autorole is on/);
  await features.onMemberAdd(member);
  assert.equal(member.roles.cache.size, 0);
  let body = base.mock.messages.get(ids.panel).body;
  assert.match(body.content, /welcome to Test Guild/);
  assert.deepEqual(body.allowed_mentions.parse, []);
  assert.deepEqual(body.allowed_mentions.users, [ids.member]);
  member.pending = false;
  await features.onMemberUpdate({}, member);
  assert.equal(member.roles.cache.has(role.id), true);
  await features.onMemberRemove(member);
  body = base.mock.messages.get(ids.panel).body;
  assert.match(body.content, /Goodbye, Member.*42/);
  assert.deepEqual(body.allowed_mentions.parse, []);
});

test('welcome setup explains how to enable the intent', async t => {
  const { features, base, interaction } = createFixture(t, { guildMembers: false });
  const setup = interaction('welcome', 'setup', { channel: base });
  await features.handleCommand(setup);
  assert.match(setup.response, /Server Members Intent/);
});

test('starboard adds one link, updates the counter and removes it below threshold', async t => {
  const { features, base, board, interaction } = createFixture(t);
  await features.handleCommand(interaction('starboard', 'setup', { channel: board }));
  const message = { guild: base.guild, guildId: base.guild.id, channelId: base.id, id: ids.source };
  const react = { emoji: { id: null, name: '⭐' }, message, countDetails: { normal: 3 } };
  base.mock.messages.set(ids.source, { reactions: { cache: new Map([['⭐', react]]) } });
  await features.onReactionAdd(react);
  assert.match(board.mock.messages.get(ids.panel).body.content, /\*\*3\*\*.*Jump to message/);
  react.countDetails.normal = 4;
  await features.onReactionAdd(react);
  assert.match(board.mock.messages.get(ids.panel).body.content, /\*\*4\*\*/);
  assert.equal(board.mock.messages.size, 1);
  react.countDetails.normal = 0;
  await features.onReactionClear(message);
  assert.equal(board.mock.messages.size, 0);
  base.nsfw = true;
  react.countDetails.normal = 5;
  await features.onReactionAdd(react);
  assert.equal(board.mock.messages.size, 0);
});

test('tickets create explicit private overwrites, close the owner’s access to post, and require staff to reopen', async t => {
  const { features, base, channels, requests, member, interaction, role, staffRole } = createFixture(t);
  await features.handleCommand(interaction('roles', 'create', { role }));
  const setupInvalid = interaction('ticket', 'setup', { staff: role });
  await features.handleCommand(setupInvalid);
  assert.match(setupInvalid.response, /dedicated support role/);
  const setup = interaction('ticket', 'setup', { staff: staffRole });
  await features.handleCommand(setup);
  assert.match(setup.response, /Posted the ticket panel/);
  const open = interaction('ticket', 'open', { subject: 'Help with my account' }, member);
  await features.handleCommand(open);
  assert.match(open.response, /private ticket is ready/);
  const { permissionOverwrites } = requests[0];
  assert.equal(permissionOverwrites.length, 4);
  assert.deepEqual(permissionOverwrites[0].deny, [Permissions.ViewChannel]);
  assert.equal(permissionOverwrites[1].id, member.id);
  assert.equal(permissionOverwrites[3].id, staffRole.id);
  assert.equal(base.mock.messages.get(ids.panel).body.components[0].components[0].custom_id, 'community:ticket:open');
  const ticket = [...channels.values()].find(x => x.topic);
  await features.handleCommand(interaction('ticket', 'close', {}, member, ticket.id));
  assert.equal(ticket.mock.edits[0][1].SendMessages, false);
  const unauthorized = interaction('ticket', 'reopen', {}, member, ticket.id);
  await features.handleCommand(unauthorized);
  assert.match(unauthorized.response, /Only support staff/);
  const reopen = interaction('ticket', 'reopen', {}, undefined, ticket.id);
  await features.handleCommand(reopen);
  assert.match(reopen.response, /Reopened/);
  assert.equal(ticket.mock.edits[1][1].SendMessages, true);
});
