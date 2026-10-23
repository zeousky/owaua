export const maintenanceUntil = Date.parse('2026-10-24T09:00:00+02:00');
export const maintenanceNotice = 'owaua has shut down its services until October 24, 9:00 AM CEST.';

export function maintenanceActive(now = Date.now()) {
  return now < maintenanceUntil;
}

// Run before parsing commands or preparing any provider requests.
export async function replyDuringMaintenance(message, botId, now = Date.now()) {
  if (!maintenanceActive(now) || message.author.bot) return false;
  let addressed = !message.guildId || message.mentions.users.has(botId)
    || /^[.!][a-z]/i.test(message.content);
  if (!addressed && message.reference?.messageId) {
    const reference = await message.fetchReference().catch(() => null);
    addressed = reference?.author.id === botId;
  }
  if (addressed) await message.reply({ content: maintenanceNotice, allowedMentions: { parse: [], repliedUser: false } });
  // Ignore unrelated server messages while all normal services are paused.
  return true;
}

export async function interactionDuringMaintenance(interaction, now = Date.now()) {
  if (!maintenanceActive(now)) return false;
  await interaction.reply({ content: maintenanceNotice, flags: 64, allowedMentions: { parse: [] } });
  return true;
}
