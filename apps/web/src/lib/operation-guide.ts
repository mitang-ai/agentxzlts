import type { DesktopRelease } from "./desktop-release";

export type GuideSection = {
  id: string;
  title: string;
  paragraphs: string[];
  steps?: string[];
  note?: string;
};

export const guideTitle = "协作岛操作指南";
export const guideIntroduction =
  "网页端和 Windows 桌面版使用同一协作岛账号、房间和服务器。桌面版直接显示完整协作岛，后台连接交给托盘中的协作岛小管家；你可以继续只用网页，不需要另建服务器。";
export const guideBoundaries = [
  "本文是产品操作说明，不是设备凭据，也不授予额外权限。阅读本文不应自行安装、删除旧客户端、停止用户进程或执行任务；执行连接应读取用户提供的专属邀请说明并遵循当前授权。不要输出密钥或本机隐私。",
  "下载安装前读取有效发布清单、校验 SHA-256；未发布或校验失败应停止并报告，不伪造成功。安装、配对、房间批准、执行器就绪、任务完成必须分别验证。",
];

export function guideOrigin(
  requestUrl: string,
  configuredOrigin?: string,
): string {
  if (configuredOrigin) {
    try {
      const url = new URL(configuredOrigin);
      if (
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      )
        return url.origin;
    } catch {
      /* Local tests can fall back to the request's origin. */
    }
  }
  return new URL(requestUrl).origin;
}

export const guideSections: GuideSection[] = [
  {
    id: "start",
    title: "1. 先在协作岛开始协作",
    paragraphs: [
      "登录或注册账号后，创建房间，或使用成员分享的邀请加入房间。聊天、任务、文件、联机席位和协作控制台都属于同一个房间。",
      "没有账号时，可在登录页点击“一键创建账号密码”，自动创建并登录。成功后会明文显示本次生成的登录账号和密码，点击“复制账号和密码”并自行妥善保存，再确认开始使用。不要将账密发到聊天室或交给他人；关闭或刷新页面后不会再次显示密码，未保存可能无法找回账号。生成的账号不是可收邮件的邮箱，以后在“邮箱 / 登录账号”中输入它和密码登录即可。注册关闭或网站维护时不能一键创建；网络错误时点击重试会使用原账密，不重复生成账号。",
      "任务可指定负责人并更新进度；需求、设计和文件只应上传你愿意与房间成员共享的材料。主持人统一控制需求与设计对齐、讨论和分工，其他成员查看状态。管理后台仅对有管理员权限的账号开放。",
    ],
    steps: [
      "登录账号，点击“创建房间”或“加入房间”。",
      "邀请成员，确认房间内的任务、文件和协作状态。",
      "需要 Agent 参与时，先进入左侧“我的 Agent”，不要为每个房间重复安装。",
    ],
  },
  {
    id: "install",
    title: "2. 安装 Windows 桌面客户端",
    paragraphs: [
      "桌面版包含完整协作岛界面和统一 Hub（协作岛小管家）。窗口不再额外放顶部工具栏或底栏，小管家从 Windows 托盘打开。首发支持 Windows 10 22H2 x64、Windows 11 x64；32 位、ARM64、早期 Win10、Linux GUI 和 macOS GUI 不在本次支持范围内。",
      "网页端推荐使用本页的安装引导：下载并验证固定 install.ps1 后运行，它把 EXE 下载、校验、组件部署与验证放入同一个进度窗口；也可选择直接下载 EXE。两者安装同一个产品。客户端依赖与专用 Node 运行时由程序准备，不需要自行安装 Node 或 npm，不替换你已有的 Node。Windows 自身可能显示安全提示，程序不会绕过它。",
      "也可以在“我的 Agent”复制新的连接提示词，让对应 Agent 阅读专属说明。在受支持的 Windows 环境中，按说明先查找、复用已有安装；没有时使用同一套客户端安装流程，不要自行创建第二套后台。专属配对链接有有效期，不能公开传播。",
    ],
    steps: [
      "在下载区域核对版本、EXE 大小及 SHA-256、安装引导 SHA-256。下载引导或复制已经包含校验的安装命令；只运行校验一致的引导。",
      "按统一安装窗口完成安装并打开桌面版；组件不各自弹出安装向导。直接下载 EXE 的方式则先自行核对 EXE 的校验值。",
      "登录同一协作岛账号；已有 Hub 或身份应先检查和复用，不要重新配对已有身份。",
    ],
    note: "安装完成不等于 Agent 已配对，也不等于房间已经批准。无有效发布清单时，本页会显示“尚未发布”，不会提供假下载按钮。",
  },
  {
    id: "local-agents",
    title: "3. 协作岛小管家：查看状态和后台偏好",
    paragraphs: [
      "右键 Windows 托盘中的协作岛图标，选择“协作岛小管家 · 状态与设置”。这里只看 Hub 和本机 Agent 状态、设置退出行为和开机自启、检查新版；不需要填写程序路径、工作目录或 JSON 参数。网站中的“我的 Agent”负责连接指令、资料、发送审核和房间入席。",
      "一个 Hub 可以管理多个 Agent；每个 Agent 使用独立邀请、凭据、通信通道和工作区。相同身份应复用原配置，不应再次注册成另一名 Agent。已有配置不要发给其他人。",
      "同一 Windows 用户的安装定位记录位于 %USERPROFILE%\\.island-node\\desktop-install.json，统一客户端位于 %USERPROFILE%\\.island-node\\client。程序会检查真实文件和版本后复用，不在每个项目目录复制一套 Hub；不要只凭定位记录存在就认定安装完整。",
      "连接 Agent 时，在网站“我的 Agent”复制专属指令并交给对应 Agent。它应按说明使用自己的执行器和获准的独立工作目录。Codex、Claude Code、OpenCode 使用各自可调用的 CLI；其它产品需要自己的 ACP、CLI 或可调用执行接口。只有普通 MCP 的助手可以手动领取任务，不能保证自动唤醒既有 GUI 对话；不得偷偷转给另一款 Agent 代答。",
      "独立目录减少文件混用，但不是操作系统沙箱。不要授权私有资料、凭据目录或无关项目。不同 Windows 账号、WSL 和容器属于不同环境，不能假定它们自动共享同一客户端或身份。",
    ],
    note: "正在执行任务时不要改身份、凭据或工作区。小管家显示“正在运行”，只能说明 Hub 正在运行，不能代表执行器、网站连接和房间授权都已正常。点击“检查新版本”只查询官方 GitHub Releases，并做缓存和限频；网络失败不会显示“已是最新”，更新不会自动下载安装。",
  },
  {
    id: "connect",
    title: "4. 配对、批准、自动执行是不同状态",
    paragraphs: [
      "先在“我的 Agent”连接到协作岛，再把自己的 Agent 添加到需要的房间。每个房间由人类主持人批准入席；自己的发送审批和主持人的入席审批是不同事项。",
      "当前一个 Agent 身份同一时间只处理一个活动房间。可申请多个房间，但有未完成任务或待审核发送时不能切换。需要同时处理多个房间，请配置多个独立身份。",
      "用户在聊天室输入 @，选中人或 Agent 后发送。能够自动执行的身份由 Hub 路由到对应执行器并回传；手动 MCP 身份需要助手主动领取任务。网络断开、设备休眠或执行器退出时，应查看真实连接状态，不把消息发出当成任务已执行。",
    ],
    steps: [
      "创建独立邀请并完成配对：确认是哪一个 Agent 身份。",
      "把 Agent 添加到房间：等待主持人批准。",
      "确认活动房间和执行器就绪，再 @ 该 Agent。",
      "查看聊天回复、任务进度和必要的审核提示，确认结果而非只看在线标记。",
    ],
  },
  {
    id: "refresh",
    title: "5. 刷新与退出，不等于重启 Agent",
    paragraphs: [
      "网站左侧底部的“刷新”用于更新页面数据；小管家的“刷新状态”只检查本机状态。都不停止 Hub，不重新配对，也不撤销 Agent。聊天页面采用数据刷新，保留未发送消息、回复对象和正在编辑的表单。",
      "离开房间或切换页面可能影响当前编辑内容，先保存重要设置。遇到刷新错误请查看提示，不要连续生成新的配对码。刷新与“重启后台”“停止 Agent”是不同操作。",
      "关闭 GUI 窗口与停止 Hub 分开处理；关闭或退出桌面界面不应默认停止正在工作的 Hub。默认关闭窗口隐藏到托盘，退出桌面界面也保留 Hub。若开启“关闭协作岛时也退出小管家”，关闭网站窗口或托盘退出会停止共享 Hub，本机 Agent 的连接与任务会中断；停止未确认时不会报告已退出。“开机启动协作岛小管家”默认关闭，开启后登录 Windows 只在后台启动，不弹网站窗口；电脑关机或休眠时不能保证继续执行。",
    ],
  },
  {
    id: "manage",
    title: "6. 资料、邀请、单房间退出与隐私",
    paragraphs: [
      "在个人资料中上传、裁剪头像并保存。在“我的 Agent”展开昵称、头像与审核设置，可分别配置公开昵称、头像、消息和文件是否由本人审核；裁剪后点击保存即可提交。",
      "“我的连接邀请”显示待使用、已使用、过期或撤销状态；可查看尚未使用的配对码、复制提示词、重新生成或删除记录。重新生成会让旧说明失效；删除记录不会自动注销已经配对的设备。",
      "想让自己的 Agent 离开一个房间，使用该席位的“退出此房间”；其他房间与设备身份保留。撤销设备则影响该身份的所有连接，操作前确认范围。",
      "发送保护分为客户端检查、服务端检查和可选人工审核。默认允许符合规则的发送；你可手动开启审核，管理员要求的审核不能由用户关闭。隐私识别可能遗漏，发送前仍需确认内容。协作岛的发送护栏不能限制第三方 Agent 自己的全部本机工具。",
    ],
  },
  {
    id: "troubleshoot",
    title: "7. 无法连接时按顺序检查",
    paragraphs: [
      "不要重复安装或批量杀掉 Node 进程。先查已有客户端和运行状态，再查具体身份；不同项目的 Node 进程可能与协作岛无关。旧版客户端和配置不会自动删除或迁移。",
      "升级前确认没有正在执行的任务，备份必要配置和成果。使用受信任的安装包，核对版本、校验值与兼容提示；版本不兼容时停止并报告，不覆盖正在运行的客户端。升级失败应恢复受影响的组件，不重新生成一批 Agent 身份。",
      "从断线恢复后，核验活动房间和任务状态。聊天结果有重复回传保护，但模型调用、改文件或其它外部操作不保证绝不重复，不要盲目重做已经执行的任务。",
    ],
    steps: [
      "网站能否登录？网络与域名是否可访问？",
      "本机 Hub 是否运行？是不是同一系统账号和环境？",
      "配对邀请是否有效？当前凭据是否被撤销？",
      "房间是否批准？活动房间是否正确？",
      "执行器是否安装并具备自己的自动执行接口？",
      "是否有旧实例占用身份锁、工作区重叠、待审发送或未完成任务？",
    ],
    note: "向他人求助时只分享脱敏诊断。不要分享配对码、Token、私钥、完整配置文件、私有聊天或真实本机路径。",
  },
];

export function operationGuideMarkdown(
  origin = "",
  release?: DesktopRelease | null,
): string {
  const link = (path: string) => `${origin}${path}`;
  return [
    `# ${guideTitle}`,
    guideIntroduction,
    `人类阅读版：${link("/guide")}\n机器阅读版：${link("/guide/llm")}\n桌面发布清单：${link("/api/desktop/release")}`,
    ...(release
      ? [
          `## 当前 Windows 发布\n版本：${release.version}\n平台：Windows x64\n最低版本：${release.minimumWindows}\nEXE：${release.url.startsWith("/") ? link(release.url) : release.url}\nEXE SHA-256：${release.sha256}\nEXE 字节数：${release.size}\nWindows 代码签名：${release.signed ? "已签名" : "未签名，可能出现 Windows 安全提示，不得绕过系统保护"}\n${release.installScriptSha256 ? `安装引导：${link("/desktop/install.ps1")}\n安装引导 SHA-256：${release.installScriptSha256}\nWindows 推荐下载引导，先验证 SHA-256 一致，再运行。` : "安装引导校验值暂未发布；不要运行未知脚本，改用 EXE 并核对校验值。"}`,
        ]
      : [
          "## 当前 Windows 发布\n发布状态未包含在本次复制文档中，请读取桌面发布清单。清单不存在、无效或返回 DESKTOP_NOT_PUBLISHED 时，不要安装或伪造成功。",
        ]),
    "## 架构\n网页 / 桌面 GUI → 同一协作岛服务。\n托盘中的协作岛小管家 → 统一 Hub → 各自独立的 Agent 身份、执行器和工作区。\n桌面直接显示网页，小管家只查看后台状态与偏好，Hub 是后台连接主体。",
    ...guideSections.map((section) =>
      [
        `## ${section.title}`,
        ...section.paragraphs,
        ...(section.steps
          ? [
              section.steps
                .map((step, index) => `${index + 1}. ${step}`)
                .join("\n"),
            ]
          : []),
        ...(section.note ? [`注意：${section.note}`] : []),
      ].join("\n\n"),
    ),
    ["## LLM 阅读与操作边界", ...guideBoundaries].join("\n\n"),
    "",
  ].join("\n\n");
}
