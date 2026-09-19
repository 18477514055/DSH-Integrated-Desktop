<#
  start-dsh.ps1 —— 【日常主力】一条命令启动 DSH 并在浏览器打开

  ⚠️ 与「浏览器启动.cmd / dsh-browser.ps1」的区别（两者不要搞混）：

    |            | 本脚本（start-dsh）        | dsh-browser.ps1（旧）      |
    |------------|---------------------------|---------------------------|
    | 定位        | **日常主力**，天天用        | **应急逃生**，出事了才用    |
    | 位置        | 本项目目录                 | ~/.dsh/safety/            |
    | 端口        | 3080（与社区版一致）        | 3199（故意错开）           |
    | 内核        | **全局新版**（自动发现）    | 社区版内置（0.1.2 旧版）    |
    | DSH_HOME    | **完全独立**（本项目自己的） | 与社区版共用 ~/.dsh        |
    | 依赖社区版  | ❌ 不依赖                  | ✅ 依赖（要检测它的安装目录）|

  ── 为什么 DSH_HOME 必须独立（实测依据）────────────────────────
  新版内核启动时会调用 healProfilesModuleFallback()，它会往
  `$DSH_HOME/profiles/node_modules` 写入/改写模块镜像（源码
  dsh-app-boot/lib/index.js）。而镜像必须与宿主内核**同世代**。

  如果本脚本用新版内核、却共用 ~/.dsh，就会把那 241 个包的镜像
  改成 0.1.5 世代 ⇒ **社区版内核（0.1.2）立刻报废**。
  所以本脚本强制使用独立 DSH_HOME，从根上避免这件事。

  依据：dsh-home-paths/lib/index.js 的 resolveDshHome() —— DSH_HOME
  环境变量优先级很高（仅次于显式配置），设了就不会碰 ~/.dsh。

  ── 用法 ────────────────────────────────────────────────────
    双击 start-dsh.cmd                启动（若已在跑则直接开浏览器）
    start-dsh.cmd -Stop               停止
    start-dsh.cmd -Status             看状态（不启动）
    start-dsh.cmd -Open               只重开浏览器
    start-dsh.cmd -Profile clean      用纯净 profile 启动
    start-dsh.cmd -Port 3090          换端口
    start-dsh.cmd -KernelPath <路径>   指定内核
    start-dsh.cmd -ListKernels        列出找到的内核
    start-dsh.cmd -DshHome <路径>     指定数据目录
    start-dsh.cmd -UseDefaultHome     改用 ~/.dsh（⚠️ 先读脚本里的警告）
#>
[CmdletBinding()]
param(
  # 注意：这里刻意不叫 $Profile —— $Profile 是 PowerShell 的自动变量
  # （保存用户 profile 脚本路径），拿它当参数名会覆盖自动变量，属于隐患。
  [string]$DshProfile = "web",
  [int]$Port = 3080,
  [switch]$Stop,
  [switch]$Status,
  [switch]$Open,
  [switch]$ListKernels,
  # 注意：这里刻意叫 $KernelPath 而不是 $Kernel ——
  # 声明 [string]$Kernel 会把同名变量永久约束成 String 类型，
  # 后面再给它赋 [pscustomobject] 会被强转成字符串，导致 .Dir/.Version 全为空。
  # （这个坑已实测复现，见项目 notes）
  [string]$KernelPath,
  [string]$DshHome,
  # 用系统默认的 ~/.dsh（与社区版共用）。默认关闭，见下方"数据目录"的说明。
  # ★★★ 2026-09-19 加装双保险：必须与 -Force 同用；且启动前做世代检查，目标镜像世代
  # 与当前内核世代不一致时拒绝启动（防止 0.1.5 内核重写 0.1.2 世代镜像 → 社区端报废）。
  [switch]$UseDefaultHome,
  [switch]$Force,
  [switch]$NoOpen
)

$ErrorActionPreference = 'Continue'
function Info($m) { Write-Host $m -ForegroundColor Cyan }
function Ok($m)   { Write-Host "   [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "   [!]  $m" -ForegroundColor Yellow }
function Bad($m)  { Write-Host "   [X]  $m" -ForegroundColor Red }

# ================================================================ 位置
# 本项目自己的目录（脚本在 <项目>\tools\ 下）
$ProjectRoot = Split-Path $PSScriptRoot -Parent
$StateDir    = Join-Path $ProjectRoot 'runtime'
$LogDir      = Join-Path $StateDir 'logs'
$Record      = Join-Path $StateDir 'kernel.json'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# ================================================================ 数据目录（DSH_HOME）
#
# 默认：**独立目录**（%APPDATA%\DSH Integrated\dsh-home，即外壳应用真正使用的那个）。
#
# ── 为什么默认独立 ──────────────────────────────────────────────
# 内核启动时会 healProfilesModuleFallback()，把 $DSH_HOME/profiles/node_modules
# 重写成与**当前内核**同世代。若该目录里的镜像属于别的世代，就会被整体改写。
#
# 2026-09-19 实测的拓扑（用进程血缘确证，见交接单）：
#   · 端口 3199 = 社区版内核 0.1.2，用 ~/.dsh，镜像 0.1.2 世代
#   · 端口 3080 = 全局新版 0.1.5，用独立目录，镜像 0.1.5 世代
# 两者各用各的镜像，互不污染 —— 隔离**确实生效**。
#
# 若改成共用 ~/.dsh，新版内核会把那份 0.1.2 镜像重写成 0.1.5，
# 届时**仍在运行的社区版内核会当场失效**（正是 2026-09-19 事故的模式）。
# 所以默认保持独立，直到确认没有任何旧世代内核在跑。
#
# 想要共用（例如要立刻看到 109 个历史会话）：加 -UseDefaultHome
# 但**必须先确认没有旧世代内核在运行**，否则会把它弄坏。
if (-not $DshHome) {
  if ($UseDefaultHome) {
    if (-not $Force) {
      Bad "-UseDefaultHome 会让本内核直连 ~/.dsh（与社区版共用数据目录）。"
      Bad "任何世代不一致都会重写社区端模块镜像，使社区端/逃生通道内核当场失效。"
      Bad "确认风险后请重新运行: start-dsh.cmd -UseDefaultHome -Force"
      exit 1
    }
    # ⚠️ 这里**故意不再读 $env:DSH_HOME**。
    #
    # 2026-09-19 真实事故：本行原为
    #     $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { ... '~/.dsh' }
    # 而调用方（DSH 自己的 shell）**天然带着 DSH_HOME=~/.dsh**（它就是从那儿继承的）。
    # 于是脚本把"环境里本来就有的默认值"误当成"用户显式指定"，
    # 让 0.1.5 内核指向了 ~/.dsh ⇒ 触发 heal ⇒
    # **把 ~/.dsh/profiles/node_modules 整体重写成 0.1.5 世代**（实测：22:18:14，241 个 JUNCTION 全部改指全局新版）。
    #
    # 教训：**不要用环境变量判断用户意图** —— 它无法区分
    # "用户设的" 与 "环境恰好带来的"。要共用就显式写路径，或显式加开关。
    $DshHome = Join-Path $env:USERPROFILE '.dsh'
  } else {
    # ★ 2026-09-20 修正：默认改用**外壳应用真正使用的那个 home**。
    #
    # 原默认是 <项目>\runtime\dsh-home —— 那是个**死路径**：
    # 外壳的 getDshHome()（src/main.js:123-128）传的是 app.getPath("userData")，
    # 所以应用永远不读 runtime\dsh-home（详见 docs\2026-09-20-环境迁移与验证记录.md §2.1）。
    # 往那里准备数据 = 白干（2026-09-20 真踩过）。
    # 旧目录已于 2026-09-20 清空删除，避免留下会与真身分叉的第二份数据。
    $DshHome = Join-Path $env:APPDATA 'DSH Integrated\dsh-home'
  }
}
$DshHome = [System.IO.Path]::GetFullPath($DshHome)

# ★★ 保险闸（2026-09-19 事故后加装，位置刻意放在"任何分支之前"）★★
# 只要目标解析成 ~/.dsh，就要求显式授权，否则一律拒绝 ——
# 包括通过 -DshHome 显式传进来的情况（那条路同样能误伤社区版）。
#
# 事故经过：内核启动时会调 healProfilesModuleFallback()，把
# $DSH_HOME/profiles/node_modules 重写成**当前内核**的世代。
# 2026-09-19 实测：一次误指 ~/.dsh 的运行，把那里 241 个 JUNCTION
# 全部改指全局新版（0.1.5），使社区版（0.1.2）的镜像世代不符。
$realHome  = Join-Path $env:USERPROFILE '.dsh'
$normHome  = ([System.IO.Path]::GetFullPath($DshHome)).TrimEnd('\')
$normReal  = ([System.IO.Path]::GetFullPath($realHome)).TrimEnd('\')
if ($normHome -ieq $normReal -and -not ($UseDefaultHome -and $Force)) {
  Bad "拒绝启动：目标 DSH_HOME 解析为 ~/.dsh，但没有显式授权。"
  Bad "  解析结果: $DshHome"
  Bad "  风险：内核会改写社区版的模块镜像（2026-09-19 事故就是这么发生的）。"
  Bad "  要用独立环境（推荐）：去掉 -DshHome，脚本默认用 %APPDATA%\DSH Integrated\dsh-home"
  Bad "  确实要共用：加 -UseDefaultHome -Force"
  exit 1
}

New-Item -ItemType Directory -Force -Path (Join-Path $DshHome 'profiles') | Out-Null

# ---- 世代检查：警告"跨世代改写模块镜像"这件事 ----
# 内核启动时会 healProfilesModuleFallback()，把 $DSH_HOME/profiles/node_modules
# 重写成与**当前内核**同世代。若该目录里的镜像属于别的世代（例如还留着
# 社区版 0.1.2 的镜像），就会被整体改写 —— 改写后旧内核将无法再使用。
# 这不是错误，但属于"不可逆的环境变化"，必须让用户知道。
function Get-MirrorGeneration([string]$homePath) {
  $mirror = Join-Path $homePath 'profiles\node_modules\@deepseek-ai\dsh-base\package.json'
  if (-not (Test-Path $mirror)) { return $null }
  try { return (Get-Content $mirror -Raw | ConvertFrom-Json).version } catch { return $null }
}

# ================================================================ 内核发现
function Get-KernelCandidates {
  $list = @()

  # ① 显式指定
  if ($KernelPath) { $list += [pscustomobject]@{ Path = $KernelPath; Source = '显式指定'; Priority = 0 } }

  # ② 环境变量
  if ($env:DSH_KERNEL_PATH) {
    $list += [pscustomobject]@{ Path = $env:DSH_KERNEL_PATH; Source = 'DSH_KERNEL_PATH'; Priority = 1 }
  }

  # ③ 本项目自带（vendor）—— "完全独立"的目标位置
  $vendor = Join-Path $ProjectRoot 'vendor\dsh'
  if (Test-Path $vendor) { $list += [pscustomobject]@{ Path = $vendor; Source = '项目自带'; Priority = 2 } }

  # ④ 全局 npm 安装
  $globalNpm = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh'
  if (Test-Path $globalNpm) { $list += [pscustomobject]@{ Path = $globalNpm; Source = '全局 npm'; Priority = 3 } }

  # ⑤ 项目 node_modules（若以后装在这里）
  $local = Join-Path $ProjectRoot 'node_modules\@deepseek-ai\dsh'
  if (Test-Path $local) { $list += [pscustomobject]@{ Path = $local; Source = '项目 node_modules'; Priority = 4 } }

  return $list | Sort-Object Priority
}

function Resolve-Kernel($pkgDir) {
  $bin = Join-Path $pkgDir 'lib\bin.js'
  if (-not (Test-Path $bin)) { return $null }
  $ver = '未知'
  $pj = Join-Path $pkgDir 'package.json'
  if (Test-Path $pj) {
    try { $ver = (Get-Content $pj -Raw | ConvertFrom-Json).version } catch {}
  }
  return [pscustomobject]@{ Dir = $pkgDir; Bin = $bin; Version = $ver }
}

$candidates = Get-KernelCandidates

if ($ListKernels) {
  Info "==== 找到的内核 ===="
  if ($candidates.Count -eq 0) { Bad "一个都没找到" }
  foreach ($c in $candidates) {
    $k = Resolve-Kernel $c.Path
    if ($k) { Ok ("[{0}] {1}  版本 {2}" -f $c.Source, $k.Dir, $k.Version) }
    else    { Warn ("[{0}] {1}  （无效：没有 lib\bin.js）" -f $c.Source, $c.Path) }
  }
  Info ""
  Info "独立 DSH_HOME 将是: $DshHome"
  exit 0
}

$kernel = $null
foreach ($c in $candidates) {
  $kernel = Resolve-Kernel $c.Path
  if ($kernel) { Info "内核来源: $($c.Source)"; break }
}
if (-not $kernel) {
  Bad "找不到可用的 dsh 内核。"
  Bad "已尝试：显式指定 / DSH_KERNEL_PATH / 项目 vendor / 全局 npm / 项目 node_modules"
  Info ""
  Info "安装一个（推荐装到项目里，保持完全独立）："
  Info "  cd `"$ProjectRoot`""
  Info "  npm install @deepseek-ai/dsh@latest --prefix .\vendor"
  exit 1
}
Info "内核版本: $($kernel.Version)"
Info "内核路径: $($kernel.Dir)"
Info "独立 DSH_HOME: $DshHome"
Info "端口: $Port    profile: $DshProfile"

# ---- -UseDefaultHome 世代保险（2026-09-19 加装，迁移方案铁律2）----
if ($UseDefaultHome) {
  $mirrorGen = Get-MirrorGeneration $DshHome
  $kernelGen = if ($kernel.Version -match '^[0-9]+\.[0-9]+\.[0-9]+') { $Matches[0] } else { $null }
  if ($mirrorGen -and $kernelGen) {
    $mg = if ($mirrorGen -match '^[0-9]+\.[0-9]+\.[0-9]+') { $Matches[0] } else { $mirrorGen }
    if ($mg -ne $kernelGen) {
      Bad "世代检查拒绝启动：目标镜像世代 $mirrorGen 与内核世代 $($kernel.Version) 不一致。"
      Bad "继续启动会重写 $DshHome\profiles\node_modules，使依赖旧镜像的内核（社区端/逃生通道）当场失效。"
      Bad "如确需继续，请先把依赖旧镜像的内核全部停掉，再重试。"
      exit 1
    }
  }
}

# ================================================================ 记录读写
function Get-Record {
  if (-not (Test-Path $Record)) { return $null }
  try { return Get-Content $Record -Raw | ConvertFrom-Json } catch { return $null }
}
function Test-Alive($rec) {
  if (-not $rec -or -not $rec.pid) { return $false }
  return [bool](Get-Process -Id ([int]$rec.pid) -ErrorAction SilentlyContinue)
}
function Test-DshUp([string]$url) {
  # 只探测"是不是 dsh 在监听"，不带 token 会是 401 —— 那也算在跑
  try {
    $r = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 6 -ErrorAction Stop
    return $true
  } catch {
    $code = $null
    try { $code = $_.Exception.Response.StatusCode.value__ } catch {}
    if ($code -eq 401 -or $code -eq 403) { return $true }   # 有鉴权 = 服务活着
    return $false
  }
}

$rec = Get-Record
$alive = Test-Alive $rec

# ================================================================ 状态
if ($Status -or $Open) {
  Info "==== DSH 状态（本项目） ===="
  if ($rec) {
    Info "  内核 PID : $($rec.pid)   版本: $($rec.version)"
    Info "  端口     : $($rec.port)   profile: $($rec.profile)"
    Info "  DSH_HOME : $($rec.dshHome)"
    Info "  启动时间 : $($rec.startedAt)"
    if ($alive) {
      Ok "内核在跑"
      if ($rec.url) { Info "  地址（带 token，可直接粘进浏览器）："; Write-Host "    $($rec.url)" -ForegroundColor White }
    } else {
      Warn "记录里的内核已不在跑（可能被关掉或重启过）"
    }
  } else {
    Warn "还没启动过（没有记录文件）"
  }
  if ($Open) {
    if ($alive -and $rec.url) { Start-Process $rec.url; Ok "已在默认浏览器打开" }
    else { Bad "内核没在跑，先跑 start-dsh.cmd 启动"; exit 1 }
  }
  exit 0
}

# ================================================================ 停止
if ($Stop) {
  Info "==== 停止本项目的内核 ===="
  if ($rec -and $rec.pid -and $alive) {
    Warn "结束内核 PID $($rec.pid)"
    & taskkill /PID ([string]$rec.pid) /T /F 2>&1 | Out-Null
    Start-Sleep -Seconds 2
    if (Test-Alive $rec) { Bad "没能结束，可能权限不足" } else { Ok "已停止" }
  } elseif ($rec -and $rec.pid) {
    Warn "记录里的 PID $($rec.pid) 已经不在跑了"
  } else {
    Warn "没有记录，可能本来就没启动"
  }
  Remove-Item $Record -Force -ErrorAction SilentlyContinue
  exit 0
}

# ================================================================ 启动
# 已有在跑的内核 → 直接复用（绝不起第二个，避免抢端口与抢镜像）
#
# ★★ 2026-09-20 修正（真实陷阱，已实测复现）★★
# 原判据只有 `$alive -and $rec.url` —— **不校验端口，也不校验 home**。
# 后果（真实发生过）：迁移之后 runtime\kernel.json 里仍记着一个**活着的旧内核**
#   PID 30672 / 端口 3102 / dshHome = <项目>\runtime\dsh-home
#   （已废弃的死路径，而且是个**空目录**）
# 于是双击本启动器会**直接打开一个空环境的界面**（0 会话、0 笔记），
# 看起来完全等同于「数据全丢了」。
# ⇒ 复用必须同时核对四件事：进程活着、端口一致、home 一致、内核世代与路径一致。
#   任何一条不符 → 拒绝复用该记录（按本次配置新起），并把陈旧记录归档。
$reuseMismatch = @()
if ($rec) {
  if ($rec.port -ne $Port) {
    $reuseMismatch += "端口：记录 $($rec.port) != 本次 $Port"
  }
  if ($rec.dshHome) {
    $rHome = ([System.IO.Path]::GetFullPath($rec.dshHome)).TrimEnd('\')
    if ($rHome -ine $normHome) {
      $reuseMismatch += "DSH_HOME：记录 $rHome != 本次 $DshHome"
    }
  } else {
    $reuseMismatch += "DSH_HOME：记录里没有这个字段（旧格式记录）"
  }
  if ($rec.version -ne $kernel.Version) {
    $reuseMismatch += "内核版本：记录 $($rec.version) != 当前 $($kernel.Version)"
  }
  if ($rec.kernelDir) {
    $rDir = ([System.IO.Path]::GetFullPath($rec.kernelDir)).TrimEnd('\')
    $nDir = ([System.IO.Path]::GetFullPath($kernel.Dir)).TrimEnd('\')
    if ($rDir -ine $nDir) {
      $reuseMismatch += "内核路径：记录 $rDir != 当前 $nDir"
    }
  }
}

if ($alive -and $rec.url -and $reuseMismatch.Count -eq 0) {
  Ok "内核已在运行（PID $($rec.pid)），直接打开浏览器"
  if (-not $NoOpen) { Start-Process $rec.url }
  exit 0
}

if ($alive -and $reuseMismatch.Count -gt 0) {
  Warn "记录里有个**还活着**的内核，但它与本次配置不符 —— 拒绝复用（防「打开空环境」的闸）"
  foreach ($rm in $reuseMismatch) { Warn "   - $rm" }
  Warn "   记录地址（**不会**打开）: $($rec.url)"
  Warn "   => 下面按本次配置新起一个内核。"
  $staleRec = Join-Path $StateDir ("kernel.stale-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Move-Item $Record $staleRec -Force -ErrorAction SilentlyContinue
  if (Test-Path $staleRec) { Warn "   陈旧记录已归档: $staleRec" }
  $rec = $null
}

# 端口已被别人占用？
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  $owner = Get-Process -Id $busy[0].OwningProcess -ErrorAction SilentlyContinue
  Warn "端口 $Port 已被占用（PID $($owner.Id) $($owner.ProcessName)）"
  Warn "如果是社区版客户端在跑，它占着 3080。请先退出它，或换个端口：start-dsh.cmd -Port 3090"
  exit 1
}

Info ""
Info "==== 启动内核 ===="
$logFile = Join-Path $LogDir ("kernel-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

# 关键：把 DSH_HOME 指向目标目录 —— 内核就不会碰别处
# （目标目录已在脚本开头通过"保险闸"校验过，不会误指 ~/.dsh）
$env:DSH_HOME = $DshHome

$args = @("`"$($kernel.Bin)`"")
# ★★ 参数语法（2026-09-19 实测更正）★★
# 新版 CLI 里 `web` 是**别名子命令**，与 `--profile` 互斥：
#   ✅ 正确：dsh --profile web   --host ... --port ... --no-open
#   ✅ 正确：dsh web             --host ... --port ... --no-open
#   ❌ 错误：dsh web --profile clean
#            → error: web takes none of parent --profile, --from-default-profile, ...
#   ❌ 错误：dsh --profile clean web
#            → 同样报 "web takes none of parent --profile"（两者不能并存）
#
# 也就是说：**要么用 `web`，要么用 `--profile <name>`，二选一**。
# 注意 `--profile <name>` 后面直接跟 web app 自己的参数（--host/--port/--no-open）。
if ($DshProfile -eq 'web') {
  # 默认 profile：用 web 别名（等价于 --profile web）
  $args += @('web')
} else {
  # 其它 profile：用 --profile <name>，**不能再加 web**
  $args += @('--profile', $DshProfile)
}
$args += @('--host', '127.0.0.1', '--port', "$Port", '--no-open')

# ★ 必须同时重定向 stdin。
# 只重定向 stdout/stderr 时，子进程会继承父进程的 stdin 管道，
# 调用方（.cmd / 上层 powershell）会一直等这个管道关闭 —— 也就是等内核退出，
# 于是表现为"内核明明起来了，但命令挂着不返回"（已实测踩过）。
# 注意：Start-Process 的 -RedirectStandardInput 要求**真实文件路径**，
# 写 'NUL' 会被当成相对路径而报 FileNotFoundException（也实测踩过）。
# 所以用一个项目内的空文件当 stdin —— 内核读到立即 EOF，不会拖住调用方。
$stdinFile = Join-Path $StateDir 'empty-stdin.txt'
if (-not (Test-Path $stdinFile)) { New-Item -ItemType File -Path $stdinFile -Force | Out-Null }

$proc = Start-Process -FilePath 'node' -ArgumentList $args `
  -RedirectStandardInput $stdinFile `
  -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err" `
  -PassThru -WindowStyle Hidden -WorkingDirectory $DshHome

Info "  内核 PID: $($proc.Id)"
Info "  日志    : $logFile"
Info "  等待就绪…"

# 等 stdout 出现 "dsh web: http://..."（带 token 的地址）
# 注意：日志文件刚创建时是空的，Get-Content -Raw 会返回 $null，
# 而 [regex]::Match($null, ...) 会抛 ArgumentNullException —— 必须判空。
$url = $null
for ($i = 0; $i -lt 90; $i++) {
  Start-Sleep -Seconds 2
  if ($proc.HasExited) { break }
  if (Test-Path $logFile) {
    $raw = Get-Content $logFile -Raw -ErrorAction SilentlyContinue
    if (-not [string]::IsNullOrEmpty($raw)) {
      $m = [regex]::Match($raw, 'dsh web: (https?://\S+)')
      if ($m.Success) { $url = $m.Groups[1].Value; break }
    }
  }
}

if (-not $url) {
  Bad "内核没能就绪。"
  if ($proc.HasExited) { Bad "  进程已退出（退出码 $($proc.ExitCode)）" }
  else { Bad "  超时未输出地址" }
  Info ""
  Info "--- stderr 末尾 25 行 ---"
  if (Test-Path "$logFile.err") { Get-Content "$logFile.err" -Tail 25 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray } }
  Info "--- stdout 末尾 15 行 ---"
  if (Test-Path $logFile) { Get-Content $logFile -Tail 15 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray } }
  Bad ""
  Bad "排错建议："
  Bad "  1) 用纯净 profile 试：start-dsh.cmd -Profile clean   （排除第三方插件问题）"
  Bad "  2) 换端口：start-dsh.cmd -Port 3090"
  Bad "  3) 看内核列表：start-dsh.cmd -ListKernels"
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  exit 1
}

# 记下来（供 -Status / -Stop / -Open 用）
@{
  pid       = $proc.Id
  port      = $Port
  profile   = $DshProfile
  version   = $kernel.Version
  kernelDir = $kernel.Dir
  dshHome   = $DshHome
  url       = $url
  log       = $logFile
  startedAt = (Get-Date).ToString('s')
} | ConvertTo-Json | Set-Content $Record -Encoding UTF8

Ok "内核已就绪（版本 $($kernel.Version)）"
Info ""
Info "  地址（带 token）："
Write-Host "  $url" -ForegroundColor White
Info ""

if (-not $NoOpen) {
  Start-Process $url
  Ok "已在默认浏览器打开"
  Info ""
  Info "提示："
  Info "  · 关掉浏览器不会停内核；要停用 start-dsh.cmd -Stop"
  Info "  · 数据全在 %APPDATA%\DSH Integrated\dsh-home\ 下，与社区版 ~/.dsh 完全隔离"
  Info "  · 下次启动会复用正在跑的内核，不会起第二个"
}
