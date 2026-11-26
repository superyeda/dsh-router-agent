# 在已安装的 DSH 上离线复验

从仓库根目录运行（macOS，固定 DSH **0.2.2-rc.5**）：

	sh scripts/dsh-runtime-smoke/run.sh

有旧安装包时，可分别或同时加上以下对照参数。脚本只从给定归档读取固定条目，不安装、不访问旧 profile；不加参数的验收不依赖旧包。

```sh
sh scripts/dsh-runtime-smoke/run.sh \
  --compare-0.1.0 dsh-router-agent-0.1.0.tgz \
  --compare-0.1.1 dsh-router-agent-0.1.1.tgz \
  --compare-0.1.2 dsh-router-agent-0.1.2.tgz
```

[启动器](./run.sh) 默认使用系统 Applications 下的 DeepSeek Harness.app；可把其他位置的同版本应用路径作为最后一个参数（不能在当前用户主目录中）。无需安装依赖、启停现用 DSH，也不需要打开浏览器。每次都创建独立临时目录，结束即清理。版本不匹配、缺少 sandbox-exec 或任一断言失败都会非零退出。

**真实链路：** [验证脚本](./probe.mjs) 用安装包的 Electron 直接加载 ASAR 中的 Cordis、Typert、Connection、Gateway、Session/Workspace Controller、Agent loop、模型选择和 JSONL 后端，并注册本仓库的生产宿主插件及前端适配器。标准客户端生成 RPC 信封；一元请求在内存中交给 Host Fetch handler，流交给 Gateway.wireStream。没有监听端口或访问 HTTP 地址。

前六条 PASS 验证基础库、网关和会话；后续断言涵盖旧会话恢复、面板重挂及实际路由。可选的旧版本对照另输出 CONTROL / REPRO：

1. 实际版本、宿主与客户端描述符注册、服务可用；启动时没有 provider，显式注册后只有一个内存 provider。
2. 即使给合成非 owner 在 Gateway 层授予该端点权限，宿主仍以 owner-required 拒绝且模型调用数为零；owner 的 infer 只传指定 system、user 和空工具列表。
3. 同一创建键只返回同一活 Agent。空会话已经 flush 到隔离 DSH_HOME 下的真实 JSONL 文件（校验路径、存在性及字节数）。
4. 只有新建的路由会话改变模型，Host 默认与之后独立创建的原生会话保持原值；非路由创建的会话和已运行的会话不能配置。
5. 先用一个已进入模型的独立原生轮次占住 Agent，再从适配器投递：可见 queued，释放上一轮后变成 done，仅该 requestId 读到自己的最终文本。重复投递后重开 JSONL 读句柄，确认用户消息、轮次数和模型选择事件没有重复；也验证候选和近期提示。
6. 在原生工作区归档目标后，适配器重新检查基线，阻止后续投递，并从候选中排除该会话。

**桌面初始化和恢复**由[对照脚本](./startup.mjs)验证：

- 使用安装版 `dsh-permission-presets` 和 `dsh-tool-subagent/model-selection-settings` 自身的 `agent/created` 钩子，没有手工构造或插入初始化事件。采用安装包 standard 预设中的 persona、agent-instructions、time-context、tool-todo 四个原始条目及原配置；没有启动完整桌面预设中的网络、子代理、办公等无关工具或其后端。
- 在相同 0.1.1 原始宿主上，仅切换模型选择策略开关。关闭时写三条权限初始化，创建成功；开启时追加第四条 `subagent/model-selection-policy`，原宿主返回 `router-agent/create-failed`，却已留下真实会话。卸载旧插件后 live Agent 消失，重新只读打开 JSONL 时仍然只有四条初始化。修复版在相同四条条件下正常创建、配置并投递。
- 用两个确切的旧版遗留会话分别模拟**同进程插件热重载**与**完整冷启动**（两个顺序退出/启动的 Electron PID 仅共享临时 DSH_HOME）。相同键和目录不能自动创建或取得配置权；错误目录/键不修改原日志。所有者显式恢复才会复用该 ID，冷 Agent 的唯一新增初始化记录是原生 `session/end-seed {}`，回执 cursor=4。重确认同一未改动会话得到相同水位，不再加 marker；配置始终 `not-owned`。真实适配器只准一次投递，拒绝第二次，重开 JSONL 核对一条相符用户消息、一轮完整结果、零选模记录。会话总数及全局默认均不变。
- 另测试带合法前缀/UUID 的原生 live 空会话：非 owner 即使有该 Session 的端点权限也不能恢复，显式复用不等于取得所有权。所有者确认后，如果别的原生请求先写入，陈旧许可会在发出 router prompt 前被拦截。忙碌且有排队输入或已有历史时也不准恢复。

**生产面板的首次挂载与完全卸载后的重挂载**也单独复验。[面板回归](./panel.mjs) 先撤回诊断用的 root Remote 描述符，再用真实 `client.plugin()` 挂载[生产客户端](../../lib/client.js)，从注册的 main slot 取得页面使用的 `connectRouter`，通过表单提交。记录的真实 RPC 顺序必须为 `routerAgent/infer → routerAgent/create → routerAgent/configure → session/prompt`，并验证分类输出确实被 planner 采用、任务得到预期结果，卸载后两个 slots 与 `remote.routerAgent` 服务均消失。旧包对照必须得到 `cannot get property "remote.routerAgent" without inject` 的失败分项，且没有任何 router 或 prompt RPC；这才会输出 REPRO。

**自动路由回归**使用[生产表单场景](./routing.mjs)和单独的 Electron 宿主（注册安装包 standard/PTC 预设的安全条目，部署基值 standard，显式宿主偏好 ptc）。唯一内存 provider 的实际模型 ID 为 `synthetic-fast`、`synthetic-standard`、`synthetic-deep`。浏览器内设置只有一个项目和一个不同的通用目录，原三档均指向 deep；无对话侧推理会操作文件。分类器有意建议最高档，以便本地策略不能靠模型讨巧。

- 0.1.2 负对照：未点项目的安装标题错字需要澄清；再指定项目并明确新建，同类错字实际用 deep 且继承 ptc；无“继续”、未点项目的同件事复述却被另开在通用目录。不是仅检查路由返回值。
- 当前成品：提交错字要求，初次由 fast Agent 接受后，模型端暂停。同一项目和任务没有标题投影；关闭并重新打开生产面板，保留已接纳的 journal，再从主表单提交同文件、同平台、同字替换的另一种说法。在首轮仍在途时必须复用同一 ID、不能再次 create/configure；随后新提交的无关复杂架构要求必须创建不同的 deep Agent。读取真实 Session JSONL 并比对 `source.rpcId`、`model/selection` 和实际适配器执行记录。
- 再退出该 Electron 进程，仅保留临时 JSONL 及这个合成面板的本地 journal，在新进程中先断言旧 Agent 不存在、真实投影无标题。第三种措辞仍复用该 ID，原模型保持 fast；只有一个新的人类 `rpcId`，不新建、不改模。
- 单独提交普通功能和单测任务，验证 standard 模型。未指定和显式 `standard` 都创建普通预设，显式 `ptc` 和 `inherit` 保留两种不同创建意图（后者不发送预设），对应实际会话头部为 ptc；宿主自己的默认选择始终是 ptc。只验新会话的原生预设与身份，不在烟测中运行 PTC 子进程/工具。

**0.2.0 单次投递、紧凑记录和同页原会话**由[生产表单用例](./ledger.mjs)复验。只跑这一项：

	sh scripts/dsh-runtime-smoke/run.sh --ledger-only

- 向生产表单提交带“先 / 然后 / 最后”的三行要求；不是把三个子任务送给夹具。必须恰好一条记录、一个子项、一个真实执行会话、一次 `session/prompt` RPC。模型收到的文本和落盘的用户消息须逐字匹配（含换行与标点），不得再发第二条 prompt。
- 第一轮真实模型暂停时，从默认折叠的记录直接点原会话按钮。宿主启用官方事件源；[原装客户端服务](./stock-session.mjs)负责目录、实时授权、会话引用和事件窗口。验证同页作用域、唯一 `session/follow` 流（原 ID、仅对已在执行的 Agent 打开原生订阅，要求 assistant 流），以及提供给 React portal 的确切原生引用：原文、运行中状态和引用来源 `routerPane` 都须一致。关闭后引用归零；打开和关闭均不导航，不增添 JSONL 事件。
- 在途记录不可清理；完成后第一次点击只显示确认，显式确认才移除本机记录。原会话及完整落盘日志保持不变。不安装、不中断现用 DSH；本例在 React portal 接收原生引用处停止，不涵盖浏览器像素渲染、原生输入框交互或审批操作。

**隔离与边界：** 启动器清空继承环境，将 HOME、DSH_HOME、TMPDIR、cwd 指向临时区。子进程以 macOS Seatbelt 拒绝所有网络、读取原用户主目录及临时区之外的文件写入；仅显式挂载的库服务参与，未加载用户 profile、凭据、设置编辑器或真实模型适配器。模型响应与 Peer 均由测试创建。面板场景的 DOM、存储、槽位外壳及菜单权限提示由内存夹具承载；授权基线仍是实际远端流，表单、journal、controller、planner、客户端/宿主网关和 Agent 均走生产路径。未测试浏览器/React 渲染、登录、生产模型质量、WebSocket、打包安装或真实 profile 配置写回。
