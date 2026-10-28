let importCounter = 0

/**
 * In Bun, appending a query string to a relative specifier forces a fresh module
 * evaluation. Using an absolute file:// URL does not behave the same way.
 */
export const importFresh = async <T>(path: string): Promise<T> =>
  import(`${path}?case=${importCounter++}`) as Promise<T>
