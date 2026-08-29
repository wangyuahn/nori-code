import { AsyncLocalStorage } from 'node:async_hooks';

const activeMutation = new AsyncLocalStorage<true>();
let mutationTail: Promise<void> = Promise.resolve();

export function withMountTreeMutation<T>(operation: () => Promise<T>): Promise<T> {
  if (activeMutation.getStore() === true) return operation();

  const result = mutationTail.catch(() => undefined).then(() => activeMutation.run(true, operation));
  mutationTail = result.then(() => undefined, () => undefined);
  return result;
}
