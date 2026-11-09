/**
 * @fileoverview Host half of `dsh-plugin-agy-bg`.
 *
 * The plugin is presentation-only: the whole feature lives in the browser half
 * (`client.js`), which paints a fixed WebGL canvas behind the shell and adds a
 * Settings → General switch. The host owns no service, route, tool, or persisted
 * state, and a row with no resources has nothing to clean up on unload.
 *
 * @returns {void}
 */
export function apply() {}
