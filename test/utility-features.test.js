import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Collection, MessageFlags, PermissionFlagsBits as Permission, PermissionsBitField } from 'discord.js';
import { convertColor, formatJson, timestampSeconds } from '../src/utility-developer.js';
import { createUtilityFeatures } from '../src/utility-features.js';

const moderatorId = '111111111111111111';
const targetId = '222222222222222222';
const botId = '333333333333333333';
const ownerId = '444444444444444444';
const guildA = '555555555555555555';
const guildB = '666666666666666666';
const moderatorPermissions = new PermissionsBitField([
  Permission.ViewChannel, Permission.ReadMessageHistory, Permission.ManageMessages,
  Permission.ModerateMembers, Permission.BanMembers, Permission.ViewAuditLog,
]);

function member(id, position, permissions = moderatorPermissions) {
  return {
    id, permissions, roles: { highest: { position, comparePositionTo: other => position - other.position } },
    isCommunicationDisabled: () => false,
  };
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'owaua-utility-'));
  const controller = createUtilityFeatures({ directory, client: { user: { id: botId } }, allowed: () => true, logError() {} });
  t.after(async () => { await controller.close(); rmSync(directory, { recursive: true, force: true }); });
  return controller;
}

function interaction(commandName, {
  guildId = guildA, id = '777777777777777777', actor = member(moderatorId, 5),
  target = member(targetId, 1), bot = member(botId, 9), channel, values = {},
} = {}) {
  const result = [];
  const set = {
    id, guildId, commandName, user: { id: actor.id }, channel,
    memberPermissions: actor.permissions, appPermissions: bot.permissions,
    guild: {
      id: guildId, ownerId, name: 'Test guild',
      members: {
        async fetch({ user, force }) {
          assert.equal(force, true);
          return user === actor.id ? actor : target;
        },
        async fetchMe({ force }) {
          assert.equal(force, true);
          return bot;
        },
      },
    },
    options: {
      getString: name => values[name] ?? null,
      getInteger: name => values[name] ?? null,
      getUser: name => values[name] ?? (name === 'user' && commandName !== 'purge' ? { id: target.id } : null),
    },
    async deferReply(payload) { assert.equal(payload.flags, MessageFlags.Ephemeral); },
    async editReply(payload) { result.push(payload); },
  };
  return { set, result };
}

test('timestamp requires an explicit timezone for a date-time and rejects rollover dates', () => {
  assert.equal(timestampSeconds('2026-11-20T14:00+01:00'), timestampSeconds('2026-11-20T13:00:00Z'));
  assert.equal(timestampSeconds('2026-11-20'), timestampSeconds('2026-11-20T00:00Z'));
  assert.equal(timestampSeconds('1795132800'), 1795132800);
  assert.throws(() => timestampSeconds('2026-11-20T14:00'));
  assert.throws(() => timestampSeconds('2026-02-31'));
});

test('color reports equivalent hex, RGB, and HSL values', () => {
  const expected = { hex: '#336699', rgb: [51, 102, 153], hsl: [210, 50, 40] };
  assert.deepEqual(convertColor('#369'), expected);
  assert.deepEqual(convertColor('rgb(51, 102, 153)'), expected);
  assert.deepEqual(convertColor('hsl(210, 50%, 40%)'), expected);
  assert.deepEqual(convertColor('hsl(-150deg, 50%, 40%)'), expected);
  assert.throws(() => convertColor('256,0,0'));
  assert.throws(() => convertColor('hsl(210, 101%, 40%)'));
});

test('JSON formatting preserves exact numeric literals, duplicate keys and escaped quotes', () => {
  const input = '{"n":9007199254740993, "n":2, "str":"a \\"quoted\\" brace }", "array":[]}';
  const compact = '{"n":9007199254740993,"n":2,"str":"a \\"quoted\\" brace }","array":[]}';
  assert.equal(formatJson(input, 'compact'), compact);
  assert.equal(formatJson(input), '{\n  "n": 9007199254740993,\n  "n": 2,\n  "str": "a \\"quoted\\" brace }",\n  "array": []\n}\n');
  assert.throws(() => formatJson('{"a": }'), /valid JSON/);
});

test('JSON formatting checks decoded strings even when a duplicate key overwrites them', () => {
  const escaped = String.raw`{"p\u0061ssword":"abcdefghijklmno", "password":"example"}`;
  assert.throws(() => formatJson(escaped), error => error.name === 'SafetyError');
  const word = String.raw`"f\u0075ck"`;
  assert.throws(() => formatJson(word, 'compact', { clean: true }), /clean language/);
});

test('QR result is a private PNG attachment', async t => {
  const controller = fixture(t);
  const { set, result } = interaction('qr', { values: { text: 'https://example.com/' } });
  await controller.handleCommand(set);
  assert.equal(result[0].files[0].name, 'qr.png');
  assert.equal(result[0].files[0].attachment.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.deepEqual(result[0].allowedMentions.parse, []);
});

test('warnings enforce permissions and hierarchy before recording or DMing', async t => {
  const controller = fixture(t);
  const target = member(targetId, 10);
  target.send = () => assert.fail('Unauthorized warning DM');
  const high = interaction('warn', { target, values: { reason: 'Example warning' } });
  await controller.handleCommand(high.set);
  assert.match(high.result[0].content, /highest role/);
  const unprivileged = interaction('warn', { actor: member(moderatorId, 20, new PermissionsBitField()),
    target, values: { reason: 'Example warning' } });
  await controller.handleCommand(unprivileged.set);
  assert.match(unprivileged.result[0].content, /need the Moderate Members permission/);
  const history = interaction('modhistory');
  await controller.handleCommand(history.set);
  assert.match(history.result[0].content, /No matching/);
});

test('moderation cases are scoped to their server and duplicate requests cannot repeat an action', async t => {
  const controller = fixture(t);
  const target = member(targetId, 1);
  let warnings = 0;
  target.send = async () => { warnings++; };
  const warning = interaction('warn', { target, values: { reason: 'Example warning' } });
  await Promise.all([controller.handleCommand(warning.set), controller.handleCommand(warning.set)]);
  assert.equal(warnings, 1);
  assert(warning.result.some(reply => /already recorded/.test(reply.content)));
  const history = interaction('modhistory');
  await controller.handleCommand(history.set);
  assert.match(history.result[0].embeds[0].description, /#1 warn.*\n.*\nExample warning/u);
  const elsewhere = interaction('modhistory', { guildId: guildB });
  await controller.handleCommand(elsewhere.set);
  assert.match(elsewhere.result[0].content, /No matching/);
  const separate = interaction('warn', { guildId: guildB, id: '777777777777777778', target, values: { reason: 'Separate warning' } });
  await controller.handleCommand(separate.set);
  assert.match(separate.result[0].content, /Case #1/);
});

test('timeout requires Discord role and permission and records unconfirmed results', async t => {
  const controller = fixture(t);
  const target = { ...member(targetId, 1), moderatable: false, timeout: () => assert.fail('Unprivileged timeout') };
  const request = interaction('timeout', { target, values: { minutes: 60 } });
  await controller.handleCommand(request.set);
  assert.match(request.result[0].content, /Discord excludes administrators/);

  target.moderatable = true;
  target.timeout = async (milliseconds, auditReason) => {
    assert.equal(milliseconds, 60 * 60 * 1000);
    assert.match(auditReason, /case #1/);
    throw new Error('network timeout');
  };
  await controller.handleCommand(request.set);
  assert.match(request.result[1].content, /did not confirm/);
  const history = interaction('modhistory');
  await controller.handleCommand(history.set);
  assert.match(history.result[0].embeds[0].description, /Outcome unconfirmed/);
});

test('purge leaves pinned, old and other users’ messages in place', async t => {
  const controller = fixture(t);
  const now = Date.now();
  const current = {
    id: '899999999999999998', author: { id: targetId }, createdTimestamp: now, bulkDeletable: true, pinned: false,
  };
  let deleted = 0;
  const eligible = { ...current, async delete() { deleted++; } };
  const messages = [eligible, { ...current, id: '899999999999999997', pinned: true },
    { ...current, id: '899999999999999996', createdTimestamp: now - 15 * 86400_000 },
    { ...current, id: '899999999999999995', author: { id: moderatorId } }];
  const channel = {
    permissionsFor: member => member.permissions,
    messages: { fetch: async () => new Collection(messages.map(message => [message.id, message])) },
    bulkDelete: () => assert.fail('A single eligible message must avoid bulk delete'),
  };
  const request = interaction('purge', { channel, values: { amount: 4, user: { id: targetId } } });
  await controller.handleCommand(request.set);
  assert.equal(deleted, 1);
  assert.match(request.result[0].content, /^Deleted 1 message\./u);
});
