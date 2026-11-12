export function configuredOwnerId(env = process.env) {
  const setting = env.OWAUA_OWNER_ID;
  const id = typeof setting === 'string' ? setting.trim() : setting;
  if (id === undefined || id === '') return undefined;
  if (typeof id !== 'string' || !/^[1-9]\d{16,19}$/.test(id) || BigInt(id) > 18446744073709551615n) {
    throw new TypeError('OWAUA_OWNER_ID must be a Discord user ID.');
  }
  return id;
}

export function isOwner(userId) {
  const ownerId = configuredOwnerId();
  return ownerId !== undefined && userId === ownerId;
}
