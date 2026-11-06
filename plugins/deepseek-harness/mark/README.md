# Codex Session mark (DSH browser plugin)

This directory is a tiny DSH client plugin that draws a 16px Codex mark inside
the leading indent of Session titles created by `deepseek-harness-for-codex`.

- `index.js` is the inert host half; the DSH Loader must mount a row for the
  client-module scanner to serve the browser bundle.
- `client.js` is a prebuilt DSH client bundle. It keeps the
  `window.__ModuleLoader__.load` wrapper because the DSH web host serves it
  directly; do not run it through the repository's `tsdown` build.
- The browser half does not occupy `sidebar.session.row.leading`: that 16px
  seat belongs to DSH's status dot (and to other plugins' leading decorations,
  such as the schedule clock or the IM bot avatar). Instead it annotates the
  Session title element with `data-codex-session-mark-title` when the title
  starts with the invisible mark (`U+200C`, zero-width non-joiner) or the legacy
  `[codex] ` prefix, and CSS draws the icon in a 20px title padding. The status
  dot, running spinner, schedule clock, and IM avatar therefore stay visible
  beside the Codex mark.
- DSH's title sanitizer deliberately removes zero-width spaces and directional
  controls, but keeps U+200C. The icon is the visible meaning of that marker;
  it does not hide any user-visible title text.

The icon is derived from the local Codex application icon. It is used only to
identify the origin of a Session. Before publishing a build, confirm that the
brand asset is used under the applicable Codex/OpenAI brand guidelines, or
replace it with an original mark.

The plugin is installed into a DSH home by `src/session-mark.ts` under
`<home>/codex-session-mark/current/`. The path is deliberately stable: upgrades
overwrite the files there, while the home patch keeps one managed `insert` row
and can be removed with `removeHomePatch`. A DSH process that is already running
may continue to serve the previous client bundle until it restarts.
