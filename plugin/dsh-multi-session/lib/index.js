/**
 * dsh-multi-session —— 宿主半边（Host half）。
 *
 * 本插件的全部行为都在浏览器半边（`lib/client.js`，见 package.json 的 `dsh.client`）。
 * 这里的空 `apply()` 是**刻意**的：官方自己的纯 UI 插件就是这个形状
 * （对照 `@deepseek-ai/dsh-client-ui-session/lib/index.js`：注释写着
 * 「Host loader entry for the browser-only ... UI adapter. Provides no Host-side behavior.」）。
 *
 * 为什么必须存在：loader 条目加载的是这个包的 **node 半边**；只有它的存在让 package
 * 出现在 profile 的 bundle 树里，宿主侧 `dsh-client-modules` 才会去读 `dsh.client` 声明、
 * 把 `lib/client.js` 组合进 `/plugins/??<id>/client.js` 那个 combo URL。
 * 没有这个文件 → 包加载失败 → 浏览器半边根本没有机会被公告。
 */

/** 宿主侧不做任何事。纯浏览器能力的宿主占位体。 */
export function apply() {}
