import { vi } from "vitest";

// The failure-injection tests deliberately trip the catches that keep one dead mailbox, or one
// write that cannot land, from taking the rest of a run down with them. Those catches log, and
// nothing else asserts that they do: delete the `console.error` and every test still passes while
// the failure becomes genuinely silent, which is the one thing this site is built not to be.
//
// So the log is captured rather than suppressed. The caller asserts what was logged, and a passing
// run stops printing stack traces that look like something broke.
export async function capturingErrors(fn) {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const value = await fn();
    return { value, logged: spy.mock.calls.map(([e]) => e) };
  } finally {
    spy.mockRestore();
  }
}
