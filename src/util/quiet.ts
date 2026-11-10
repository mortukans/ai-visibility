// node:sqlite is still flagged "experimental" in Node, but it's stable enough for
// our use. Silence only that one notice so the CLI output stays clean; every other
// warning passes through untouched.
const original = process.emitWarning.bind(process);
(process as unknown as { emitWarning: (warning: unknown, ...rest: unknown[]) => void }).emitWarning = (
  warning: unknown,
  ...rest: unknown[]
) => {
  const message =
    typeof warning === "string" ? warning : warning instanceof Error ? warning.message : "";
  if (/sqlite/i.test(message)) return;
  (original as (...a: unknown[]) => void)(warning, ...rest);
};
