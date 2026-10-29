import { card } from './ui.js';
import { FULL_MODE_OWNER } from './full-mode.js';
import { MistralInputError, mistralOperations } from './mistral-api.js';
import { ProviderError } from './provider-error.js';
import { SafetyError, assertSafeText, assertSafeValue, withRequestUser } from './safety.js';

export const mistralCommand = {
  name: 'mistral', description: 'Owner only: use the full Mistral REST API', options: [
    { type: 3, name: 'operation', description: 'API operation, or operations to list all supported calls', required: true },
    { type: 3, name: 'payload', description: 'REST JSON object; include path IDs and API fields', max_length: 6000 },
    { type: 11, name: 'file', description: 'Discord file for an upload or transcription operation' },
  ],
};

function outputFile(operation, result) {
  if (result?.bytes && Buffer.isBuffer(result.bytes)) {
    const extensions = { 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
      'image/png': 'png', 'image/jpeg': 'jpg', 'application/pdf': 'pdf', 'text/plain': 'txt', 'text/event-stream': 'sse.txt' };
    const extension = extensions[result.contentType.split(';')[0]] ?? 'bin';
    return { attachment: result.bytes, name: `mistral-result.${extension}` };
  }
  const data = JSON.stringify(result, null, 2);
  assertSafeText(data);
  return { attachment: Buffer.from(data), name: `${operation.replace(/[^a-z0-9_-]/gi, '_').slice(0, 80)}.json` };
}

export async function handleMistralCommand(interaction, { api, router, standalone, signal } = {}) {
  // Options may contain data or invoke attachment handling: authorize first.
  if (interaction.user?.id !== FULL_MODE_OWNER) {
    return interaction.reply({ ...card('', 'Only the bot owner can use Mistral API commands.'), flags: 64 });
  }
  return withRequestUser(interaction.user.id, async () => {
    const operation = interaction.options.getString('operation', true);
    if (['operations', 'help', 'features'].includes(operation)) {
      const data = { model: 'mistral-large-4', usage: '.mistral <operation> <JSON payload>',
        payload: 'Use REST snake_case fields. Include path IDs in the payload. _query supplies extra URL query fields; _body optionally supplies a non-object body.',
        operations: mistralOperations() };
      return interaction.reply({ ...card('', 'The complete Mistral operation list is attached. Results are private; use the exact operation name and REST JSON fields. Specialist endpoints use their own models.'),
        files: [outputFile('mistral-operations', data)], flags: 64, allowedMentions: { parse: [] } });
    }
    if (!api) return interaction.reply({ ...card('', 'Mistral is not configured. Add MISTRAL_API_KEY to the bot service.'), flags: 64 });
    let payload;
    try {
      const raw = interaction.options.getString('payload') ?? '{}';
      if (raw.length > 6000) throw new Error();
      payload = JSON.parse(raw);
      if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error();
    } catch {
      return interaction.reply({ ...card('', 'Use a valid JSON object as the payload, for example .mistral models {}.'), flags: 64 });
    }
    const run = async () => {
      await interaction.deferReply({ flags: 64 });
      try {
        const result = await api.request(operation, payload, { signal, attachment: interaction.options.getAttachment?.('file') });
        if (!result?.bytes) assertSafeValue(result, { secrets: [api.apiKey] });
        const files = [outputFile(operation, result)];
        return await interaction.editReply({ ...card('', 'Mistral API request completed. The result is attached.'), files, flags: 64, allowedMentions: { parse: [] } });
      } catch (error) {
        if (error instanceof ProviderError) router?.reportFailure(error, 'mistral');
        const message = error instanceof MistralInputError ? error.message
          : error?.code === 'insufficient_balance' ? 'Mistral has insufficient balance. The provider fallback was checked for future chat requests; this API action was not repeated.'
            : error instanceof ProviderError ? `Mistral could not complete this operation (HTTP ${error.status}). Check model access, API permissions, and required fields.`
              : error instanceof SafetyError ? 'The result contained protected content and was not attached.'
                : ['AbortError', 'TimeoutError'].includes(error?.name) ? 'The Mistral request timed out or was cancelled.'
                  : 'The Mistral API request failed. No provider details were exposed.';
        return interaction.editReply({ ...card('', message), flags: 64, allowedMentions: { parse: [] } });
      }
    };
    return standalone ? standalone(interaction, run) : run();
  });
}
