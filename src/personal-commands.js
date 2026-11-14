import { ApplicationCommandOptionType as O, ChannelType, InteractionContextType as C } from 'discord.js';

const text = (name, description, max_length, required = false) => ({ type: O.String, name, description, max_length, required });
const sub = (name, description, ...options) => ({ type: O.Subcommand, name, description, options });
const when = () => text('when', 'Delay (30m, 2h) or ISO time with an offset (2026-12-01T19:00+01:00)', 35, true);
const repeat = () => text('repeat', 'Repeat at a fixed interval of at least 1 hour, e.g. 1d or 1w', 30);
const reminderId = () => ({ type: O.Integer, name: 'id', description: 'ID shown by /reminders list', min_value: 1, required: true });

export const personalCommands = [
  { name: 'remind', description: 'Set a personal reminder delivered by DM', options: [
    when(), text('message', 'What to remind you about', 1000, true), repeat(),
  ] },
  { name: 'reminders', description: 'List, remove, or schedule reminders', options: [
    sub('list', 'List your personal reminders'),
    sub('remove', 'Remove one of your personal reminders', reminderId()),
    sub('schedule', 'Schedule a message to a server channel (Manage Messages required)',
      when(), text('message', 'Message to post', 1500, true),
      { type: O.Channel, name: 'channel', description: 'Channel to post in', channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement], required: true },
      repeat()),
    sub('scheduled', 'List your scheduled messages in this server'),
    sub('cancel', 'Cancel one of your scheduled messages in this server', reminderId()),
  ] },
  { name: 'poll', description: 'Create a native Discord poll or a button poll', contexts: [C.Guild], options: [
    text('question', 'What are people voting on?', 300, true),
    text('options', 'Two to ten answers separated by |, e.g. Blue | Green', 560, true),
    { ...text('format', 'How members will vote (default: Discord poll)', 10), choices: [
      { name: 'Discord poll', value: 'native' }, { name: 'Buttons', value: 'buttons' },
    ] },
    { type: O.Integer, name: 'hours', description: 'How many hours voting is open (default 24)', min_value: 1, max_value: 768 },
    { type: O.Boolean, name: 'multiple', description: 'Allow multiple answers in a Discord poll' },
  ] },
  { name: 'vote', description: 'Vote in or view a button poll in this channel', contexts: [C.Guild], options: [
    sub('cast', 'Choose or change your answer', text('poll', 'Poll message ID or link', 140, true),
      { type: O.Integer, name: 'choice', description: 'Answer number', min_value: 1, max_value: 10, required: true }),
    sub('results', 'View the current tally', text('poll', 'Poll message ID or link', 140, true)),
    sub('close', 'End a poll you created (or manage as a moderator)', text('poll', 'Poll message ID or link', 140, true)),
  ] },
  { name: 'afk', description: 'Set an away status until you next message in this server', contexts: [C.Guild], options: [
    sub('set', 'Mark yourself as away', text('reason', 'Optional reason shown when someone tags you', 180)),
    sub('clear', 'Remove your away status'),
  ] },
];
