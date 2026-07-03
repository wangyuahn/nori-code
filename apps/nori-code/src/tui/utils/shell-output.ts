import { currentTheme } from '#/tui/theme';

// Captured command output can contain terminal control sequences — colours,
// cursor moves, alternate-screen switches, hyperlinks, `\r` spinners, bells, …
// We render through pi-tui, which passes strings straight to the terminal, so
// any sequence left intact is executed by the terminal and fights with pi-tui's
// own cursor control (the "blank screen + leftover characters" symptom). Strip
// everything a terminal would interpret as a command rather than printable text,
// keeping only `\n` and `\t` (which the renderer understands).

// ESC [ <params> <intermediates> <final> — colours, cursor moves, clear, and
// private modes such as ESC[?1049h (alt screen) / ESC[?25l (hide cursor).
const CSI_PATTERN = /\u001B\[[0-9:;<=>?]*[ -/]*[@-~]/g;
// 8-bit C1 CSI form. Rare, but terminal-safe output should not let it through.
const C1_CSI_PATTERN = /\u009B[0-9:;<=>?]*[ -/]*[@-~]/g;
// ESC ] … <BEL>  or  ESC ] … ESC \ — window titles and OSC 8 hyperlinks.
const OSC_PATTERN = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g;
const C1_OSC_PATTERN = /\u009D[\s\S]*?(?:\u0007|\u009C|\u001B\\)/g;
// DCS/SOS/PM/APC strings can contain arbitrary bytes until ST/BEL. Strip the
// payload too; otherwise an unterminated graphics/control payload can leak
// printable chunks into the transcript or keep consuming following text.
const ESC_STRING_PATTERN = /\u001B[\u0050\u0058\u005E\u005F][\s\S]*?(?:\u0007|\u001B\\)/g;
const C1_STRING_PATTERN = /[\u0090\u0098\u009E\u009F][\s\S]*?(?:\u0007|\u009C|\u001B\\)/g;
const OSC_UNTERMINATED_PATTERN = /\u001B\][\s\S]*$/g;
const C1_OSC_UNTERMINATED_PATTERN = /\u009D[\s\S]*$/g;
const ESC_STRING_UNTERMINATED_PATTERN = /\u001B[\u0050\u0058\u005E\u005F][\s\S]*$/g;
const C1_STRING_UNTERMINATED_PATTERN = /[\u0090\u0098\u009E\u009F][\s\S]*$/g;
// ESC <char> (and ESC <intermediate> <char>) — charset/keypad selection,
// save/restore cursor (ESC 7 / ESC 8), full reset (ESC c), etc. Runs after the
// CSI/OSC patterns, so it only catches sequences they didn't already consume.
const ESC_SINGLE_PATTERN = /\u001B(?:[ -/][0-~]|[0-~])/g;
// C0 control characters except \n (0x0A) and \t (0x09): NUL, BEL, \b, \r, …
// plus a lone ESC (0x1B) that wasn't part of a sequence recognised above.
const C0_CONTROL_PATTERN = /[\u0000-\u0008\u000B-\u001B\u001C-\u001F]/g;
const C1_CONTROL_PATTERN = /[\u0080-\u009F]/g;

/**
 * Strip every terminal control sequence from captured command output so it is
 * safe to render via pi-tui (which does not sanitize on its own).
 *
 * Never throws: a bad or pathological input falls back to stripping only the
 * C0 control characters, so rendering can never crash the TUI.
 */
export function sanitizeShellOutput(text: string): string {
  if (typeof text !== 'string') return '';
  if (text.length === 0) return text;
  try {
    return text
      .replace(ESC_STRING_PATTERN, '')
      .replace(C1_STRING_PATTERN, '')
      .replace(OSC_PATTERN, '')
      .replace(C1_OSC_PATTERN, '')
      .replace(ESC_STRING_UNTERMINATED_PATTERN, '')
      .replace(C1_STRING_UNTERMINATED_PATTERN, '')
      .replace(OSC_UNTERMINATED_PATTERN, '')
      .replace(C1_OSC_UNTERMINATED_PATTERN, '')
      .replace(CSI_PATTERN, '')
      .replace(C1_CSI_PATTERN, '')
      .replace(ESC_SINGLE_PATTERN, '')
      .replace(C0_CONTROL_PATTERN, '')
      .replace(C1_CONTROL_PATTERN, '');
  } catch {
    return text.replace(C0_CONTROL_PATTERN, '').replace(C1_CONTROL_PATTERN, '');
  }
}

/**
 * Format captured stdout/stderr for the transcript. Sanitizes both streams and
 * dims them; stderr is red only on actual failure.
 *
 * Never throws: if anything goes wrong (theme lookup, huge input, …) it falls
 * back to a best-effort plain view so a render error can never crash the TUI.
 */
export function formatBashOutputForDisplay(stdout: string, stderr: string, isError?: boolean): string {
  try {
    const dim = (s: string): string => currentTheme.fg('textDim', s);
    const parts: string[] = [];
    const cleanStdout = sanitizeShellOutput(stdout).trimEnd();
    if (cleanStdout.length > 0) parts.push(dim(cleanStdout));
    const cleanStderr = sanitizeShellOutput(stderr).trimEnd();
    if (cleanStderr.length > 0) {
      // Dim grey normally; red only on actual failure (so warnings on a
      // successful command are not mistaken for errors).
      parts.push(isError ? currentTheme.fg('error', cleanStderr) : dim(cleanStderr));
    }
    return parts.length > 0 ? parts.join('\n') : dim('(no output)');
  } catch {
    const plain = [sanitizeShellOutput(String(stdout ?? '')), sanitizeShellOutput(String(stderr ?? ''))]
      .filter((s) => s.length > 0)
      .join('\n');
    return plain.length > 0 ? plain : '(no output)';
  }
}
