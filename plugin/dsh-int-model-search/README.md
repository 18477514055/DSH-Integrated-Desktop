# dsh-int-model-search —— 模型下拉的搜索框 + 提供方筛选

> **一句话**：官方「选择模型」下拉里没有搜索框，模型多了要一行一行找。
> 本插件在那张列表顶上插一个**搜索框**和一排**提供方筛选胶囊**。
>
> **它原来是外壳的注入脚本**（`src/inject/model-search.js`，`executeJavaScript` 打进官方页面），
> 2026-09-29 移植成独立客户端插件 —— 这样它**跟着内核走**，换成官方桌面端也在。

## 装法

```powershell
# 装进集成版自己的家（profile=web）
node scripts/install-plugin.js --plugin dsh-int-model-search --apply

# 装进**官方桌面端**的家（profile=desktop）—— 复刻集成版用这条
node scripts/install-plugin.js --plugin dsh-int-model-search --apply --home "$env:USERPROFILE\.dsh" --profile desktop
```

装完**重启一次客户端**（宿主在启动时快照客户端 bundle，刷新页面不够）。

## 行为（与注入版**逐字一致** —— 同一段代码，机械移植）

| 语义 | 规则 |
|---|---|
| 关键词命中**提供方名** | 该提供方**整组**显示（不是只显示组标题） |
| 关键词命中模型名 / label / 描述 | 该行显示 |
| 提供方胶囊 | 精确筛选；**再点一次已选中的胶囊 = 取消** |
| 胶囊何时出现 | 只在**提供方多于一个**时（只有一个时它没意义、白占地方） |
| 空态 | 只在"确实加了筛选条件且一条不剩"时出现，并给「清空搜索与筛选」 |
| 胶囊上的数字 | 是**该提供方的全部条数**（不受关键词影响） |
| Esc 的优先级 | 先清筛选条件，**再按一次**才关菜单 |

## 锚点（官方改版时先看这里）

只用官方**语义属性**，一个 CSS module 哈希类名都不碰：
`div[role="menu"]` + `section[role="group"][aria-labelledby]` + `button[role="menuitemradio"][title]`。
提供方名字从 `aria-labelledby` 指向的元素取。
⇒ 官方改结构时**它自己会安静地不工作**（找不到就退出，官方界面照常用），不会把菜单弄坏。

## 与外壳注入的关系（★ 两边只能活一个）

- 外壳 `src/main.js` 注入前会查 profile 里**有没有装本插件**：装了就**跳过注入**，并在 `shell.log` 里写一行。
  ⇒ 插件缺失时（干净装机、没勾选插件）功能仍在，只是由注入版提供。
- 两者共用同一段 DOM 逻辑与同一个调试钩子 `window.__dshModelSearchStats`，
  靠 `stats.src`（`"inject"` / `"plugin"`）区分身份，**验收脚本据此断言"现在跑的是哪一个"**。

## 调试钩子

```js
window.__dshModelSearchStats   // { sweeps, applies, pillBuilds, watch, src }
```

`sweeps` 不涨 = MutationObserver 没跑；`applies` 不涨 = 菜单没被认出来；
`pillBuilds` 不涨 = 提供方分组没认出来（胶囊没重建）。**出问题时看哪个计数不动，别猜。**

## 生成物警告

`lib/client.js` 是 **`scripts/port-inject-to-plugin.mjs` 机械生成**的（注入体逐字不变）。
**别直接编辑它** —— 改 `src/inject/model-search.js` 或生成器，然后重跑：

```powershell
node scripts/port-inject-to-plugin.mjs           # 重新生成
node scripts/port-inject-to-plugin.mjs --check   # 只校对（退出码 2 = 需要重新生成）
```
