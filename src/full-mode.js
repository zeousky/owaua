import { AsyncLocalStorage } from 'node:async_hooks';

export const FULL_MODE_OWNER = '1172433512364769342';
const requests = new AsyncLocalStorage();

// Only the authenticated Discord actor and their saved setting can grant this
// request-local capability. Never derive it from prompts or tool arguments.
export function withFullMode(userId, enabled, work) {
  return requests.run({ userId, enabled: userId === FULL_MODE_OWNER && enabled === true }, work);
}
export function fullModeActive(userId = requests.getStore()?.userId) {
  const request = requests.getStore();
  return request?.enabled === true && userId === FULL_MODE_OWNER && request.userId === userId;
}
