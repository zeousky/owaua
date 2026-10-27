import test from 'node:test';
import assert from 'node:assert/strict';
import { commands } from '../src/commands.js';
import { parsePrefixCommand, createPrefixInteraction, PrefixCommandError, PrefixPrivateReplyError } from '../src/prefix-command.js';
import { createCommandHandler } from '../src/command-handler.js';
import { conversationScope } from '../src/store.js';
import { DEFAULT_PERSONA } from '../src/persona.js';
import { MEDIA_OWNER } from '../src/media-store.js';

const actor = '111111111111111111';
const file = (id, name, contentType) => ({ id, name, contentType, size: 12, url: `https://cdn.discordapp.com/attachments/1/2/${name}` });
const files = [file('image-id', 'cat.png', 'image/png'), file('document-id', 'guide.txt', 'text/plain'),
  file('audio-id', 'recording.ogg', 'audio/ogg'), file('video-id', 'clip.mp4', 'video/mp4')];
const attachments = new Map(files.map(file => [file.id, file]));

function message({ userId = actor, guildId = 'guild', dmBlocked = false, content = '' } = {}) {
  const publicReplies = [], privateReplies = [], edits = [];
  const sent = destination => async payload => {
    destination.push(payload);
    return { edit: async next => { edits.push(next); return { edit: async () => {} }; } };
  };
  return { content, guildId, channelId: 'channel', guild: { id: guildId }, channel: { id: 'channel' }, attachments,
    author: { id: userId, send: dmBlocked ? async () => { throw new Error('DM blocked'); } : sent(privateReplies) },
    reply: sent(publicReplies), publicReplies, privateReplies, edits };
}
const event = (content, settings) => {
  const source = message(settings);
  return createPrefixInteraction(source, parsePrefixCommand(content, { attachments: source.attachments }));
};

function example(option) {
  if (option.type === 11) return files.find(file => ({ image: 'cat.png', file: 'guide.txt', audio: 'recording.ogg', video: 'clip.mp4' })[option.name] === file.name).name;
  if (option.type === 6) return `<@${actor}>`;
  if (option.type === 5) return 'true';
  if (option.type === 4 || option.type === 10) return String(Math.max(option.min_value ?? 1, 1));
  if (option.choices) return option.choices[0].value;
  if (option.name === 'server') return '123456789012345678';
  if (option.name === 'schema') return '{"type": "object"}';
  return 'x'.repeat(Math.max(option.min_length ?? 1, 1));
}

// Exercise every registered command, subcommand and option, including optional
// fields. A new slash command cannot silently lose its prefix equivalent.
for (const command of commands) {
  const variants = command.options?.some(option => option.type === 1) ? command.options : [null];
  for (const variant of variants) {
    const name = `.${command.name}${variant ? ` ${variant.name}` : ''}`;
    test(`prefix registry coverage: ${name}, including every option`, () => {
      const options = (variant ?? command).options ?? [];
      const parsed = parsePrefixCommand(name + options.map(option => ` ${option.name}:${example(option)}`).join(''), { attachments });
      assert.equal(parsed.commandName, command.name);
      assert.equal(parsed.subcommand, variant?.name ?? null);
      for (const option of options) {
        const value = parsed.values.get(option.name);
        if (option.type === 11) assert.ok(files.includes(value));
        else if (option.type === 6) assert.equal(value.id, actor);
        else assert.equal(typeof value, option.type === 5 ? 'boolean' : [4, 10].includes(option.type) ? 'number' : 'string');
      }
    });
  }
}

test('natural text, quoted option-like text, JSON, booleans and numbers survive parsing', () => {
  assert.equal(parsePrefixCommand(".ASK What's the weather today? reasoning:high").values.get('prompt'), "What's the weather today?");
  assert.equal(parsePrefixCommand('.language Brazilian Portuguese').values.get('name'), 'Brazilian Portuguese');
  assert.deepEqual([...parsePrefixCommand('.memory remember hobby I like hiking').values], [['key', 'hobby'], ['text', 'I like hiking']]);
  const parsed = parsePrefixCommand('.ask prompt:"Explain output:json" output:json schema:{"type": "object", "properties": {"answer": {"type": "string"}}} library:false');
  assert.equal(parsed.values.get('prompt'), 'Explain output:json');
  assert.equal(JSON.parse(parsed.values.get('schema')).properties.answer.type, 'string');
  assert.equal(parsed.values.get('library'), false);
  assert.equal(parsePrefixCommand('.speak Hello speed:1.2').values.get('speed'), 1.2);
  assert.equal(parsePrefixCommand(".persona set description:'Talk like a pirate'").values.get('description'), 'Talk like a pirate');
  assert.equal(parsePrefixCommand('.ask Visit https://example.com').values.get('prompt'), 'Visit https://example.com');
  assert.equal(parsePrefixCommand('.ask What does [ mean?').values.get('prompt'), 'What does [ mean?');
  assert.equal(parsePrefixCommand('.ask Explain this:\n  line one\n  line two reasoning:high').values.get('prompt'), 'Explain this:\n  line one\n  line two');
});

test('invalid input is rejected before dispatch, without echoing values', () => {
  for (const input of ['.ask', '.ask spoken:maybe prompt:hello', '.ask hello reasoning:extreme', '.memory forget id:0',
    '.memory view page:11', '.memory forget id:1.2', '.memory forget id:9007199254740992', '.speak Hello speed:Infinity',
    '.speak Hello speed:0.1', '.speak Hello format:ogg', '.reset unexpected', '.voice invalid', '.persona',
    '.ask Hello output:json output:text', '.ask --unknown:secret', '.ask "unclosed', '.ask schema:{"type":"object"',
    '.persona set description:' + 'x'.repeat(121), '.usage user:someone', '.usage server:short']) {
    assert.throws(() => parsePrefixCommand(input), PrefixCommandError, input);
  }
  for (const input of ['.music hi', '.asker hello', 'hello .ask there', '/ask hi', 'plain text']) assert.equal(parsePrefixCommand(input), null);
});

test('attachments are resolved from Discord metadata and typed URLs are refused', () => {
  assert.equal(parsePrefixCommand('.transcribe', { attachments }).values.get('audio'), files[2]);
  assert.equal(parsePrefixCommand('.knowledge add', { attachments }).values.get('file'), files[1]);
  assert.equal(parsePrefixCommand('.transcribe audio:3', { attachments }).values.get('audio'), files[2]);
  assert.equal(parsePrefixCommand('.knowledge add file:guide.txt', { attachments }).values.get('file'), files[1]);
  for (const input of ['.transcribe', '.knowledge add', '.transcribe audio:https://example.com/a.ogg']) {
    assert.throws(() => parsePrefixCommand(input), PrefixCommandError);
  }
});

test('message adapter keeps authenticated scope and routes private results and edits to DMs', async () => {
  const interaction = event('.memory view');
  assert.equal(interaction.user.id, actor);
  assert.equal(interaction.guildId, 'guild');
  assert.equal(interaction.channelId, 'channel');
  await interaction.deferReply({ flags: 64 });
  await interaction.editReply({ content: 'private fact', flags: 68 });
  assert.equal(interaction.sourceMessage.publicReplies.length, 0);
  assert.equal(interaction.sourceMessage.privateReplies.length, 1);
  assert.equal(interaction.sourceMessage.privateReplies[0].flags, undefined);
  assert.equal(interaction.sourceMessage.edits[0].content, 'private fact');
  assert.equal(interaction.sourceMessage.edits[0].flags, 4);
  const blocked = event('.jobs', { dmBlocked: true });
  await assert.rejects(blocked.reply({ content: 'private media URL', flags: 64 }), PrefixPrivateReplyError);
  assert.equal(blocked.sourceMessage.publicReplies.length, 0);
  const direct = event('.help', { guildId: null });
  await direct.reply({ content: 'help', flags: 64 });
  assert.equal(direct.sourceMessage.publicReplies[0].flags, undefined);
  assert.equal(direct.sourceMessage.privateReplies.length, 0);
});

function dependencies(overrides = {}) {
  const calls = [], errors = [], active = new Set();
  const scope = conversationScope('guild', 'channel', actor);
  const store = {
    persona: () => DEFAULT_PERSONA, setPersona: (user, next) => { calls.push(['persona', user]); return next; },
    resetPersona: user => calls.push(['resetPersona', user]), language: () => 'auto', setLanguage: (user, language) => calls.push(['language', user, language]),
    memoryStatus: selected => { calls.push(['memory', selected]); return { paused: false, notes: 0, turns: 0 }; }, listMemories: () => [],
    remember: (selected, user) => { calls.push(['remember', selected, user]); return { id: 1 }; },
    forgetMemory: (selected, id) => { calls.push(['forget', selected, id]); return true; }, clearMemory: selected => calls.push(['clear', selected]),
    pauseMemory: (selected, paused) => calls.push(['pause', selected, paused]), reset: selected => calls.push(['reset', selected]),
  };
  const library = {
    list: selected => { calls.push(['knowledge', selected]); return []; }, isActive: () => false,
    add: async (selected, file) => { calls.push(['add', selected, file]); return { id: 1, filename: file.name, bytes: file.size }; },
    forget: async (selected, id) => { calls.push(['forgetDocument', selected, id]); return true; },
    clear: async selected => { calls.push(['clearDocuments', selected]); return { deleted: 1, failed: 0 }; },
  };
  const deps = {
    allowed: () => true, isStopping: () => false, store, knowledge: library, active, help: { content: 'help text' },
    mediaStore: { jobs: (user, guild) => { calls.push(['jobs', user, guild]); return []; }, usage: options => { calls.push(['usage', options]); return { day: '2026-10-23', rows: [] }; } },
    mcp: { list: options => { calls.push(['integrations', options]); return [{ label: 'docs', description: 'Read documentation' }]; } },
    voiceAPI: {
      speak: async (text, options) => { calls.push(['speak', text, options]); return { attachment: Buffer.from('mock speech'), name: 'speech.mp3', voice: 'eve' }; },
      transcribe: async (audio, options) => { calls.push(['transcribe', audio, options]); return { text: 'mock transcript', words: [], language: 'en' }; },
      voices: async () => { calls.push(['voices']); return [{ id: 'eve', name: 'Eve' }]; },
    },
    voiceManager: { handle: async (event, options) => { calls.push(['voice', event.author.id, options.action]); return event.reply({ content: 'voice result' }); } },
    standalone: async (interaction, run, options) => { calls.push(['standalone', interaction.commandName, options]); return run(); },
    client: { user: { id: 'bot' } }, answer: async request => { calls.push(['answer', request]); return request.send({ content: 'mock answer' }); },
    signal: new AbortController().signal, logError: (...error) => errors.push(error), ...overrides,
  };
  return { deps, calls, errors, scope, handler: createCommandHandler(deps) };
}

const routes = [
  '.ask Hello library:true spoken:true reasoning:high output:json', '.reset', '.help', '.language Hungarian',
  '.persona set description:"Talk like a pirate"', '.persona view', '.persona reset',
  '.memory view page:1', '.memory remember key:hobby text:"I like hiking"', '.memory forget id:1', '.memory clear', '.memory pause', '.memory resume',
  '.jobs', '.usage', '.knowledge list', '.knowledge add', '.knowledge forget id:1', '.knowledge clear',
  '.speak Hello voice:eve speed:1.1', '.transcribe language:hu speakers:true', '.voice join', '.voice leave', '.voice status', '.voice voices', '.integrations',
];
for (const route of routes) {
  test(`shared dispatcher executes ${route} with mocked providers`, async () => {
    const { handler, calls, errors, scope } = dependencies();
    const interaction = event(route);
    await handler(interaction);
    assert.deepEqual(errors, []);
    assert.ok(interaction.sourceMessage.publicReplies.length + interaction.sourceMessage.privateReplies.length > 0);
    if (/^\.(ask|speak|transcribe|voice)\b/.test(route)) assert.ok(interaction.sourceMessage.publicReplies.length > 0);
    else assert.equal(interaction.sourceMessage.publicReplies.length, 0, 'private results must stay out of the server');
    if (route.startsWith('.ask')) {
      const request = calls.find(call => call[0] === 'answer')[1];
      assert.equal(request.userId, actor);
      assert.equal(request.scope, scope);
      assert.equal(request.useLibrary, true);
      assert.equal(request.spoken, true);
      assert.equal(request.requestOptions.reasoningEffort, 'high');
      assert.equal(request.requestOptions.outputFormat, 'json');
      assert.equal(request.images.length, 1);
      assert.equal(request.documents[0], files[1]);
      assert.equal(request.audio[0], files[2]);
    }
    if (/^\.(speak|transcribe|knowledge (add|forget|clear)|voice join)/.test(route)) assert.ok(calls.some(call => call[0] === 'standalone'));
    if (route === '.voice join') assert.deepEqual(calls.find(call => call[0] === 'standalone')[2], { voice: true });
    if (route.startsWith('.knowledge ') && !route.endsWith('list')) assert.deepEqual(calls.find(call => call[0] === 'standalone')[2], { charge: route === '.knowledge add' });
    if (route === '.usage') assert.deepEqual(calls.at(-1), ['usage', { userId: actor, guildId: undefined }]);
  });
}

test('original channel scope, owner authorization and busy guards survive DM delivery', async () => {
  const { handler, calls, scope, deps } = dependencies();
  await handler(event('.memory remember key:hobby text:hiking'));
  assert.deepEqual(calls.at(-1), ['remember', scope, actor]);
  await handler(event('.knowledge add'));
  assert.ok(calls.some(call => call[0] === 'add' && call[1] === scope && call[2] === files[1]));
  await handler(event(`.usage user:<@${actor}> server:123456789012345678`, { userId: MEDIA_OWNER }));
  assert.deepEqual(calls.at(-1), ['usage', { userId: actor, guildId: '123456789012345678' }]);
  deps.active.add(scope);
  const before = calls.length;
  const busy = event('.reset');
  await handler(busy);
  assert.equal(calls.length, before);
  assert.match(busy.sourceMessage.privateReplies[0].content, /finish your current request/);
});

test('shutdown and guild restrictions gate every route before any provider or store call', async () => {
  for (const override of [{ isStopping: () => true }, { allowed: () => false }]) {
    for (const route of routes) {
      const { handler, calls, errors } = dependencies(override);
      await handler(event(route));
      assert.deepEqual(calls, [], route);
      assert.deepEqual(errors, [], route);
    }
  }
});

test('blocked DMs give only a generic public notice, including direct-return handlers', async () => {
  for (const route of ['.memory view', '.jobs', '.help', '.integrations', '.reset', '.knowledge add']) {
    const { handler, errors, calls } = dependencies();
    const interaction = event(route, { dmBlocked: true });
    await handler(interaction);
    assert.deepEqual(errors, []);
    assert.equal(interaction.sourceMessage.publicReplies.length, 1, route);
    assert.match(interaction.sourceMessage.publicReplies[0].content, /couldn’t send you a DM/);
    assert.ok(!calls.some(call => call[0] === 'add'), 'failed private deferral must prevent uploading');
  }
});

test('slash interactions keep their ephemeral flags through the shared dispatcher', async () => {
  const { handler } = dependencies();
  const slash = event('.memory view');
  const replies = [];
  delete slash.sourceMessage;
  slash.reply = async payload => replies.push(payload);
  await handler(slash);
  assert.equal(replies[0].flags, 64);
});

test('exhausted admission prevents paid command dispatch while controls remain reachable', async () => {
  const { handler, calls } = dependencies({ standalone: async (interaction, _run, options) => {
    if (options?.charge === false) return _run();
    return interaction.reply({ content: 'Daily request limit reached.', flags: 64 });
  } });
  for (const route of ['.speak Hello', '.transcribe', '.voice join', '.knowledge add']) {
    await handler(event(route));
  }
  assert.deepEqual(calls, [], 'no provider or upload must run after admission denial');
  for (const route of ['.help', '.usage', '.jobs', '.voice leave', '.voice status', '.knowledge list', '.knowledge clear']) {
    await handler(event(route));
  }
  assert.ok(calls.some(call => call[0] === 'voice' && call[2] === 'leave'));
  assert.ok(calls.some(call => call[0] === 'voice' && call[2] === 'status'));
  assert.ok(calls.some(call => call[0] === 'clearDocuments'));
  assert.ok(calls.some(call => call[0] === 'usage'));
  assert.ok(calls.some(call => call[0] === 'jobs'));
});


test('ask uses explicitly selected attachments instead of another file on the message', async () => {
  const { handler, calls } = dependencies();
  const source = message();
  const other = file('other-document', 'other.txt', 'text/plain');
  source.attachments = new Map([...attachments, [other.id, other]]);
  const parsed = parsePrefixCommand('.ask Summarize this file:other.txt', { attachments: source.attachments });
  await handler(createPrefixInteraction(source, parsed));
  const request = calls.find(call => call[0] === 'answer')[1];
  assert.deepEqual(request.documents, [other]);
});


test('a private response after public deferral opens a DM instead of editing the public message', async () => {
  const interaction = event('.ask Hello');
  await interaction.deferReply();
  await interaction.reply({ content: 'private detail', flags: 64 });
  assert.equal(interaction.sourceMessage.publicReplies.length, 1);
  assert.equal(interaction.sourceMessage.privateReplies[0].content, 'private detail');
  assert.deepEqual(interaction.sourceMessage.edits, []);
});
