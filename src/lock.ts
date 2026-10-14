const queues = new Map<string, Promise<void>>();

/**
 * Runs `fn` after every operation previously queued for the same site has
 * settled, so lifecycle steps for one site never interleave.
 */
export function withSiteLock<T>(siteId: string, fn: () => Promise<T>): Promise<T> {
	const previous = queues.get(siteId) ?? Promise.resolve();
	const run = previous.then(fn);
	const tail = run.then(
		() => undefined,
		() => undefined
	);
	queues.set(siteId, tail);
	tail.then(() => {
		const current = queues.get(siteId);
		if (current === tail) queues.delete(siteId);
	});
	return run;
}
