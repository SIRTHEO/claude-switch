/**
 * awaitInkScreen — centralizes the Ink render/wait pattern.
 *
 * Problem solved:
 *   The previous pattern used `.then(resolve)` without `.catch`, which silently
 *   swallows rejections from `waitUntilExit()` (e.g. SIGTERM, internal Ink error).
 *
 * Usage:
 *   const instance = render(<MyScreen ... />);
 *   return awaitInkScreen(instance, () => result);
 */
export async function awaitInkScreen<T>(
  instance: { waitUntilExit(): Promise<unknown> },
  getResult: () => T,
): Promise<T> {
  await instance.waitUntilExit();
  return getResult();
}
