import { AsyncLocalStorage } from 'node:async_hooks';
import { isOwner } from './owner.js';

const requests = new AsyncLocalStorage();

// Only the authenticated Discord actor and their saved setting can grant this
// request-local capability. Never derive it from prompts or tool arguments.
export function withFullMode(userId, enabled, work) {
  return requests.run({ userId, enabled: isOwner(userId) && enabled === true }, work);
}
export function fullModeActive(userId = requests.getStore()?.userId) {
  const request = requests.getStore();
  return request?.enabled === true && request.userId === userId && isOwner(userId);
}
