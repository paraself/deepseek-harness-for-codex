/**
 * Inert host half of the Codex session mark.
 *
 * The host must mount a plugin row for the DSH client-module scanner to serve
 * the browser bundle; this module does nothing on the host. All behaviour is in
 * client.js, which registers the Session-row decoration.
 */
export const name = "dsh-codex-session-mark";

export function apply() {}
