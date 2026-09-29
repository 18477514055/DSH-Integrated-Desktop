/**
 * dsh-int-sidebar-open —— 宿主半边（Host half）。
 *
 * 本插件的全部行为都在浏览器半边（`lib/client.js`，见 package.json 的 `dsh.client`）：
 * 它装饰右侧栏文件树的每一行，动作通过**官方的** `session.openWorkspacePath` Remote 完成
 * —— 那条链的宿主半边在官方包里（`dsh-api-session-controller` → `dsh-native-command` 的
 * `openNativePath` / `revealNativePath`），**我们不需要自己注册 web 路由**。
 *
 * 为什么这个空 `apply()` 是必须的：loader 条目加载的是这个包的 **node 半边**；
 * 只有它的存在让 package 出现在 profile 的 bundle 树里，宿主侧 `dsh-client-modules`
 * 才会去读 `dsh.client` 声明、把 `lib/client.js` 组合进 combo URL。
 * 没有这个文件 → 包加载失败 → 浏览器半边根本没有机会被公告。
 *
 * ★ 与注入版的差别（安全边界在哪）：注入版靠外壳的三条闸门（来源 `assertLocalFileUi` /
 *   路径 `guardWorkspaceFilePath` / 动作 `{open,reveal}`）；插件版把前两条交给了**官方宿主**
 *   （`SessionOpenWorkspacePathRequest` 的 d.ts 原文：path 是 "after best-effort Session
 *   workspace resolution"，解析与会话工作区归属由宿主负责），我们这边只保证只发两个动作。
 */

/** 宿主侧不做任何事。纯浏览器能力的宿主占位体。 */
export function apply() {}
