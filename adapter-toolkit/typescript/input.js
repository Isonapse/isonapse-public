/**
 * Replace a host's executable argument object without invoking inherited setters
 * (notably `__proto__`) and without authorizing a partially applied rewrite.
 * All inability to prove/apply the exact replacement is a blocking error.
 * @param {object} target
 * @param {Record<string, unknown>} replacement
 * @returns {string | undefined}
 */
export function replaceExecutableInput(target, replacement) {
	try {
		const currentKeys = Reflect.ownKeys(target);
		const nextKeys = Reflect.ownKeys(replacement);
		const nextEntries = [];

		for (const key of currentKeys) {
			const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
			if (!descriptor?.configurable) {
				return `isonapse: executable input property ${String(key)} cannot be removed exactly; action was not authorized`;
			}
		}
		for (const key of nextKeys) {
			const descriptor = Reflect.getOwnPropertyDescriptor(replacement, key);
			if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) {
				return "isonapse: adapter input replacement was not a JSON data object; action was not authorized";
			}
			nextEntries.push([key, descriptor.value]);
		}
		if (nextEntries.length > 0 && !Reflect.isExtensible(target)) {
			return "isonapse: executable input is not extensible, so the exact replacement cannot be installed; action was not authorized";
		}

		for (const key of currentKeys) {
			if (!Reflect.deleteProperty(target, key)) {
				return `isonapse: executable input property ${String(key)} survived replacement; action was not authorized`;
			}
		}
		for (const [key, value] of nextEntries) {
			if (
				!Reflect.defineProperty(target, key, {
					value,
					writable: true,
					enumerable: true,
					configurable: true,
				})
			) {
				return `isonapse: executable input property ${key} could not be installed; action was not authorized`;
			}
		}

		const installedKeys = Reflect.ownKeys(target);
		if (
			installedKeys.length !== nextEntries.length ||
			nextEntries.some(([key, value]) =>
				!Reflect.has(target, key) || !Object.is(Reflect.get(target, key), value),
			)
		) {
			return "isonapse: executable input replacement did not verify exactly; action was not authorized";
		}
	} catch {
		return "isonapse: executable input replacement failed; action was not authorized";
	}
	return undefined;
}
