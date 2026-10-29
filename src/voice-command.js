import { card, answerCard } from './ui.js';
import { ProviderError } from './ai.js';
import { VoiceInputError } from './voice.js';
import { SafetyError } from './safety.js';
import { fullModeActive } from './full-mode.js';

export const speakCommand = {
  name: 'speak', description: 'Turn your text into an AI-generated spoken audio file', options: [
    { type: 3, name: 'text', description: 'Words to speak; expressive speech tags are supported', required: true, max_length: 4000 },
    { type: 3, name: 'voice', description: 'Voice ID for the active provider (omit for its default)', max_length: 100 },
    { type: 3, name: 'language', description: 'Language code such as en, fr, or pt-BR (default: auto)', max_length: 24 },
    { type: 10, name: 'speed', description: 'Speech speed, from 0.7 to 1.5', min_value: 0.7, max_value: 1.5 },
    { type: 3, name: 'format', description: 'Download format', choices: [{ name: 'MP3', value: 'mp3' }, { name: 'WAV', value: 'wav' }] },
    { type: 5, name: 'timestamps', description: 'Also attach character timing metadata for captions' },
    { type: 5, name: 'normalize', description: 'Read numbers and abbreviations as spoken words' },
  ],
};
export const transcribeCommand = {
  name: 'transcribe', description: 'Turn an attached audio recording into text and timestamps', options: [
    { type: 11, name: 'audio', description: 'MP3, WAV, OGG, Opus, FLAC, AAC, or M4A under 20 MB', required: true },
    { type: 3, name: 'language', description: 'Optional language code such as en or hu', max_length: 24 },
    { type: 5, name: 'speakers', description: 'Identify different speakers in the timestamp file' },
    { type: 5, name: 'format', description: 'Format spoken numbers/currencies; requires a language' },
  ],
};
export const voiceCommand = {
  name: 'voice', description: 'Talk with Owaua using xAI realtime voice', options: [
    { type: 1, name: 'join', description: 'Start a ten-minute conversation using only your microphone audio', options: [
      { type: 3, name: 'voice', description: 'Built-in or custom xAI voice ID (default: eve)', max_length: 100 },
    ] },
    { type: 1, name: 'leave', description: 'End your voice conversation and disconnect' },
    { type: 1, name: 'status', description: 'Check whether a voice conversation is running' },
    { type: 1, name: 'voices', description: 'List available voices for the active speech provider' },
  ],
};
export function voiceErrorMessage(error) {
  if (error instanceof SafetyError) return error.message;
  if (error instanceof VoiceInputError) return error.message;
  if (error instanceof ProviderError && error.status === 429) return `${error.provider === 'mistral' ? 'Mistral' : 'xAI'} is getting too many voice requests right now. Try again in a moment.`;
  if (error instanceof ProviderError && error.code === 'insufficient_balance') return 'The voice provider has insufficient credit. Automatic fallback was checked for future requests; please try again.';
  if (['AbortError', 'TimeoutError'].includes(error?.name)) return 'That voice request stopped before it finished. Try again in a moment.';
  return 'I couldn’t finish that voice request. Give it another try in a moment.';
}
export async function handleSpeakCommand(interaction, voice, { signal, onUsage = () => {} } = {}) {
  await interaction.deferReply();
  try {
    const options = interaction.options;
    const result = await voice.speak(options.getString('text', true), {
      signal, voice: options.getString('voice') ?? 'eve', language: options.getString('language') ?? 'auto',
      speed: options.getNumber('speed') ?? 1, format: options.getString('format') ?? 'mp3',
      timestamps: options.getBoolean('timestamps') ?? false, normalize: options.getBoolean('normalize') ?? false,
    });
    const files = [{ attachment: result.attachment, name: result.name }];
    if (result.timing) files.push({ attachment: Buffer.from(JSON.stringify(result.timing, null, 2)), name: 'speech-timestamps.json' });
    await interaction.editReply({ ...card('Generated speech', `Here’s your audio, made with the ${result.provider === 'mistral' ? 'Mistral' : 'xAI'} voice ${result.voice}.`), files });
    onUsage({ model: result.model, voice: result.voice, characters: result.characters });
  } catch (error) { await interaction.editReply(card('Voice request failed', voiceErrorMessage(error), { tone: 'error' })); }
}
export async function handleTranscribeCommand(interaction, voice, { signal, onUsage = () => {} } = {}) {
  await interaction.deferReply();
  try {
    const result = await voice.transcribe(interaction.options.getAttachment('audio', true), {
      signal, language: interaction.options.getString('language') ?? undefined,
      diarize: interaction.options.getBoolean('speakers') ?? false, format: interaction.options.getBoolean('format') ?? false,
    });
    const files = [
      { attachment: Buffer.from(result.text), name: 'transcript.txt' },
      { attachment: Buffer.from(JSON.stringify({ language: result.language, duration: result.duration, words: result.words, ...(result.segments ? { segments: result.segments } : {}) }, null, 2)), name: 'transcript-timestamps.json' },
    ];
    const preview = !fullModeActive() && result.text.length > 12000 ? `${result.text.slice(0, 11900)}\n\nFull transcript attached.` : result.text;
    const payload = answerCard(preview, { fullMode: fullModeActive() });
    await interaction.editReply({ ...payload, files: [...(payload.files ?? []), ...files] });
    onUsage({ model: result.model, duration: result.duration });
  } catch (error) { await interaction.editReply(card('Transcription failed', voiceErrorMessage(error), { tone: 'error' })); }
}
export async function handleVoiceCommand(interaction, manager, voice, { signal } = {}) {
  await interaction.deferReply();
  const action = interaction.options.getSubcommand();
  try {
    if (action === 'voices') {
      const voices = await voice.voices({ signal });
      return interaction.editReply(card('Available speech voices', voices.map(v => `\`${v.id}\` — ${v.name}`).join('\n').slice(0, 3900) || 'I couldn’t find any built-in voices just now. Try again in a moment.'));
    }
    return await manager.handle({ guild: interaction.guild, guildId: interaction.guildId, author: interaction.user,
      channel: interaction.channel, reply: payload => interaction.editReply(payload) },
    { action, voice: interaction.options.getString('voice') ?? 'eve' });
  } catch (error) { return interaction.editReply(card('Voice request failed', voiceErrorMessage(error), { tone: 'error' })); }
}
