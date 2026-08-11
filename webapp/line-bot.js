const crypto = require("crypto");

const lineReplyEndpoint = "https://api.line.me/v2/bot/message/reply";
const openAiResponsesEndpoint = "https://api.openai.com/v1/responses";

function lineChannelSecret() {
  return String(process.env.LINE_CHANNEL_SECRET || "");
}

function lineChannelAccessToken() {
  return String(process.env.LINE_CHANNEL_ACCESS_TOKEN || "");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function lineReadiness() {
  const secret = lineChannelSecret();
  const token = lineChannelAccessToken();
  return {
    channelSecretConfigured: secret.length >= 16,
    channelAccessTokenConfigured: token.length >= 32,
    configured: secret.length >= 16 && token.length >= 32,
    ledgerEnabled: true,
    bindingEnabled: true,
    webSyncEnabled: true,
    ledgerCommandsEnabled: true,
    privacyDeleteEnabled: true,
    aiParserConfigured: Boolean(process.env.OPENAI_API_KEY && process.env.LINE_AI_PARSER_ENABLED === "1"),
    richMenuAutoDeploy: process.env.LINE_RICH_MENU_AUTO_DEPLOY === "1",
    replyDisabled: process.env.LINE_REPLY_DISABLED === "1"
  };
}

function verifyLineSignature(rawBody, signature) {
  const secret = lineChannelSecret();
  if (!secret) {
    const error = new Error("LINE_CHANNEL_SECRET 尚未設定");
    error.statusCode = 503;
    throw error;
  }
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  return safeEqual(expected, signature);
}

function parseLineWebhook(rawBody) {
  try {
    return JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody));
  } catch {
    const error = new Error("LINE webhook JSON 格式不正確");
    error.statusCode = 400;
    throw error;
  }
}

function connectionReplyText() {
  return [
    "LINE 記帳已接通。",
    "可以試著輸入：買早餐 65、賺 3000、買 0056 10000。",
    "完成網頁綁定後，收入、支出與 ETF 部位會同步到現金流報告。"
  ].join("\n");
}

function formatMoney(value) {
  return `NT$${Math.round(Number(value || 0)).toLocaleString("zh-TW")}`;
}

function firstAmount(text) {
  const normalized = String(text || "").replace(/[,，]/g, "");
  const ticker = firstTicker(normalized);
  const amountText = ticker ? normalized.replace(new RegExp(`\\b${ticker}\\b`, "i"), " ") : normalized;
  const match = amountText.match(/(?:NT\$?\s*)?(\d+(?:\.\d+)?)\s*(萬|千|[kw])?(?:\s*(?:元|塊|台幣|twd))?/i);
  if (!match) return 0;
  const multiplier = /萬|w/i.test(match[2] || "") ? 10000 : /千|k/i.test(match[2] || "") ? 1000 : 1;
  return Math.round(Number(match[1]) * multiplier);
}

function firstTicker(text) {
  const value = String(text || "").toUpperCase();
  const numeric = value.match(/\b(00\d{2,4}|0\d{4,5})\b/);
  if (numeric) return numeric[1];
  const alpha = value.match(/\b([A-Z]{2,5})\b/);
  return alpha && alpha[1] !== "ETF" ? alpha[1] : "";
}

function compactNote(text) {
  return String(text || "")
    .replace(/[,，]/g, "")
    .replace(/\d+(?:\.\d+)?\s*(?:萬|千|[kw])?\s*(?:元|塊|台幣|twd)?/ig, "")
    .replace(/\b(買|付|花|繳|支出|得|賺|收入|薪水|獎金|ETF|投資|購入)\b/ig, "")
    .trim()
    .slice(0, 80);
}

function taipeiDateParts(value = new Date()) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function parseOccurredAt(text, now = new Date()) {
  const raw = String(text || "");
  const today = taipeiDateParts(now);
  let date = new Date(`${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}T12:00:00+08:00`);
  if (/前天/.test(raw)) date = new Date(date.getTime() - 2 * 86400000);
  else if (/昨天|昨日/.test(raw)) date = new Date(date.getTime() - 86400000);
  const full = raw.match(/(?:(\d{4})[年/-])?(\d{1,2})[月/-](\d{1,2})日?/);
  if (full) {
    const year = Number(full[1] || today.year);
    const month = Number(full[2]);
    const day = Number(full[3]);
    const explicit = new Date(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T12:00:00+08:00`);
    if (Number.isFinite(explicit.getTime())) date = explicit;
  }
  return date.toISOString();
}

function expenseCategory(text) {
  const raw = String(text || "");
  if (/房租|租金|管理費/.test(raw)) return "房租";
  if (/保險|保費/.test(raw)) return "保險";
  if (/貸款|房貸|車貸|信貸|還款/.test(raw)) return "貸款";
  if (/水費|電費|瓦斯|網路|電話費|手機費/.test(raw)) return "生活帳單";
  if (/交際|應酬|請客|送禮|聚餐|生日|慶生|禮物|伴手禮|紅包|婚禮|喜宴|宴客|聚會/.test(raw)) return "交際";
  if (/衣服|衣物|服飾|外套|褲子|裙子|鞋子|包包|項鍊|首飾|耳環|戒指|手鍊|手錶|帽子|襪子|眼鏡|皮夾/.test(raw)) return "服飾";
  if (/伙食|早餐|午餐|晚餐|飲料|咖啡|餐|吃|便當|宵夜/.test(raw)) return "伙食";
  if (/交通|加油|停車|捷運|火車|計程車/.test(raw)) return "交通";
  if (/醫療|看醫生|藥/.test(raw)) return "醫療";
  if (/電影|遊戲|娛樂|唱歌|旅遊/.test(raw)) return "娛樂";
  if (/學費|課程|補習|書籍/.test(raw)) return "教育";
  if (/家用|孝親|小孩|育兒/.test(raw)) return "家庭";
  return /固定支出/.test(raw) ? "固定支出" : "其他支出";
}

function incomeCategory(text) {
  const raw = String(text || "");
  if (/獎金|年終|績效|分紅/.test(raw)) return "獎金";
  if (/本薪|固定收入|月薪|薪水/.test(raw)) return "本薪";
  if (/兼職|副業|接案|稿費|外快/.test(raw)) return "額外收入";
  return "其他收入";
}

function profilePatchFor({ raw, type, category, amount }) {
  if (type === "income" && category === "本薪" && /設定|固定收入金額/.test(raw)) return { monthlyIncome: amount };
  if (type !== "expense") return null;
  if (!/設定|固定支出金額|保險金額|貸款金額/.test(raw)) return null;
  if (category === "保險") return { insuranceExpense: amount };
  if (category === "貸款") return { loanExpense: amount };
  if (["房租", "生活帳單", "固定支出"].includes(category)) return { fixedExpense: amount };
  return null;
}

function parseLedgerMessage(text) {
  const raw = String(text || "").trim();
  const amount = firstAmount(raw);
  const ticker = firstTicker(raw);
  const hasDividend = /配息|股息|現金股利|領息|收到股利|收到配息/.test(raw);
  const hasSale = /賣(?:出|掉)?|出售|贖回|出場/.test(raw);
  const hasBuy = /買|購入|投入|定期定額|加碼/.test(raw);
  const hasInvestmentContext = /ETF|股票|投資|證券/.test(raw) || Boolean(ticker) || hasDividend || hasSale;
  const hasInvestment = /ETF|投資|購入|定期定額|加碼/.test(raw) || (ticker && hasBuy);
  const hasIncome = /得|賺|收入|本薪|月薪|薪水|獎金|年終|兼職|副業|外快|領到|收到/.test(raw);
  const inferredExpenseCategory = expenseCategory(raw);
  const hasExpense = /買|付|花|繳|支出|刷|扣款/.test(raw) || inferredExpenseCategory !== "其他支出";
  if (!amount) {
    if (hasInvestmentContext) return { intent: "help", reason: "missing_investment_details" };
    if (hasIncome) return { intent: "help", reason: "missing_income_amount" };
    if (hasExpense) return { intent: "help", reason: "missing_expense_amount" };
    return { intent: "help", reason: "missing_amount" };
  }
  if (hasInvestmentContext && /賺|獲利|漲了|上漲/.test(raw) && !hasDividend && !hasSale) {
    return { intent: "help", reason: "unrealized_investment_gain" };
  }
  if (hasDividend || hasSale) {
    const category = hasDividend ? "投資配息" : "投資賣出";
    return {
      intent: "ledger",
      type: "investment_income",
      amount,
      ticker,
      category,
      note: compactNote(raw) || ticker || category,
      occurredAt: parseOccurredAt(raw)
    };
  }
  if (hasInvestment) {
    return {
      intent: "ledger",
      type: "investment",
      amount,
      ticker,
      category: "ETF",
      note: compactNote(raw) || ticker || "投資",
      occurredAt: parseOccurredAt(raw)
    };
  }
  if (hasIncome) {
    const category = incomeCategory(raw);
    return {
      intent: "ledger",
      type: "income",
      amount,
      category,
      note: compactNote(raw) || category,
      occurredAt: parseOccurredAt(raw),
      profilePatch: profilePatchFor({ raw, type: "income", category, amount })
    };
  }
  if (hasExpense) {
    const category = inferredExpenseCategory;
    return {
      intent: "ledger",
      type: "expense",
      amount,
      category,
      note: compactNote(raw) || category,
      occurredAt: parseOccurredAt(raw),
      profilePatch: profilePatchFor({ raw, type: "expense", category, amount })
    };
  }
  return { intent: "help", reason: "unknown_keyword" };
}

function parseBindingMessage(text) {
  const match = String(text || "").trim().match(/^(?:綁定|绑定|bind)\s*(\d{6})$/i);
  return match ? { intent: "binding", code: match[1] } : null;
}

function parseLineCommand(text) {
  const raw = String(text || "").trim().replace(/[,，]/g, "");
  if (/^(?:取消|按錯)$/.test(raw)) return { intent: "command", command: "cancel_current" };
  if (/^(?:記一筆)?支出$/.test(raw)) return { intent: "command", command: "prompt_expense" };
  if (/^(?:記一筆)?收入$/.test(raw)) return { intent: "command", command: "prompt_income" };
  if (/^(?:ETF配置|ETF部位|補ETF部位|投資ETF)$/i.test(raw)) return { intent: "command", command: "prompt_investment" };
  if (/^綁定網頁(?:帳號|報告)?$/.test(raw)) return { intent: "command", command: "prompt_binding" };
  if (/^修改(?:上一筆|最後一筆)$/.test(raw)) return { intent: "command", command: "prompt_update_last" };
  if (/^(?:查詢?)?(?:本月)?(?:明細|摘要|統計)$/.test(raw)) return { intent: "command", command: "details" };
  if (/^確認刪除全部(?:資料|記帳|財務資料)$/.test(raw)) return { intent: "command", command: "confirm_delete_all" };
  if (/^刪除全部(?:資料|記帳|財務資料)$/.test(raw)) return { intent: "command", command: "request_delete_all" };
  const deleteIndexed = raw.match(/^刪除第?\s*(\d+)\s*筆$/);
  if (deleteIndexed) return { intent: "command", command: "delete_indexed", index: Number(deleteIndexed[1]) };
  if (/^刪除(?:上一筆|最後一筆)$/.test(raw)) return { intent: "command", command: "delete_last" };
  const updateIndexed = raw.match(/^修改第?\s*(\d+)\s*筆\s*(?:金額)?\s*(\d+(?:\.\d+)?(?:萬|千|[kw])?)$/i);
  if (updateIndexed) return { intent: "command", command: "update_indexed", index: Number(updateIndexed[1]), amount: firstAmount(updateIndexed[2]) };
  const update = raw.match(/^(?:(?:修改)(?:上一筆|最後一筆)|(?:上一筆|最後一筆)改成?)\s*(?:金額)?\s*(\d+(?:\.\d+)?(?:萬|千|[kw])?)$/i);
  if (update) return { intent: "command", command: "update_last", amount: firstAmount(update[1]) };
  return null;
}

function openAiOutputText(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  return (response?.output || [])
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text || "")
    .join("");
}

function shouldUseAiParser(text, deterministic) {
  if (process.env.LINE_AI_PARSER_ENABLED !== "1" || !process.env.OPENAI_API_KEY) return false;
  if (["missing_amount", "missing_income_amount", "missing_expense_amount", "missing_investment_details", "unrealized_investment_gain"].includes(deterministic.reason)) return false;
  if (deterministic.intent === "help") return true;
  const withoutTicker = String(text || "").replace(/\b(?:00\d{2,4}|0\d{4,5})\b/g, "");
  return (withoutTicker.match(/\d+(?:\.\d+)?\s*(?:萬|千|[kw]|元|塊)?/gi) || []).length > 1;
}

async function parseLedgerMessageWithAi(text) {
  if (!firstAmount(text)) return null;
  const today = taipeiDateParts();
  const response = await fetch(openAiResponsesEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_LINE_PARSER_MODEL || "gpt-5.4-nano",
      store: false,
      input: [
        {
          role: "system",
          content: "你是台灣家庭記帳文字解析器。只抽取使用者明確說出的交易，不推測不存在的金額。買生活用品是 expense；買 ETF 或股票是 investment；ETF 或股票配息、已賣出收到的款項是 investment_income；薪水或一般收到款項是 income。收入分類優先使用本薪、獎金、額外收入、其他收入；支出分類優先使用房租、伙食、交通、交際、服飾、生活帳單、保險、貸款、醫療、娛樂、教育、家庭、其他支出。尚未賣出的帳面獲利不算現金收入。最多拆成 5 筆。日期使用 Asia/Taipei。"
        },
        {
          role: "user",
          content: `今天是 ${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}。請解析：${String(text || "").slice(0, 500)}`
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "cashflow_ledger_entries",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              entries: {
                type: "array",
                maxItems: 5,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    type: { type: "string", enum: ["income", "expense", "investment", "investment_income"] },
                    amount: { type: "integer", minimum: 1, maximum: 1000000000 },
                    category: { type: "string", maxLength: 30 },
                    ticker: { type: ["string", "null"], maxLength: 12 },
                    note: { type: "string", maxLength: 80 },
                    occurredAt: { type: "string" }
                  },
                  required: ["type", "amount", "category", "ticker", "note", "occurredAt"]
                }
              }
            },
            required: ["entries"]
          }
        }
      }
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`OpenAI parser HTTP ${response.status}`);
  const payload = JSON.parse(openAiOutputText(await response.json()) || "{}");
  const entries = (payload.entries || []).slice(0, 5).map((entry) => {
    const type = ["income", "expense", "investment", "investment_income"].includes(entry.type) ? entry.type : null;
    const amount = Math.round(Number(entry.amount));
    if (!type || !Number.isFinite(amount) || amount <= 0 || amount > 1000000000) return null;
    let category = String(entry.category || (type === "expense" ? "其他支出" : type === "income" ? "其他收入" : type === "investment_income" ? "投資流入" : "ETF")).slice(0, 30);
    if (type === "expense" && category === "餐飲") category = "伙食";
    if (type === "income" && ["固定收入", "月薪", "薪水"].includes(category)) category = "本薪";
    if (type === "income" && category === "收入") category = "其他收入";
    const occurred = new Date(entry.occurredAt);
    return {
      type,
      amount,
      category,
      ticker: entry.ticker ? String(entry.ticker).trim().toUpperCase().slice(0, 12) : "",
      note: String(entry.note || category).slice(0, 80),
      occurredAt: Number.isFinite(occurred.getTime()) ? occurred.toISOString() : parseOccurredAt(text),
      profilePatch: profilePatchFor({ raw: text, type, category, amount })
    };
  }).filter(Boolean);
  return entries.length ? { intent: "ledger_batch", entries, parser: "ai" } : null;
}

async function parseIncomingMessage(text) {
  const command = parseLineCommand(text);
  if (command) return command;
  const binding = parseBindingMessage(text);
  if (binding) return binding;
  const deterministic = parseLedgerMessage(text);
  if (!shouldUseAiParser(text, deterministic)) return deterministic;
  try {
    return await parseLedgerMessageWithAi(text) || deterministic;
  } catch {
    return deterministic;
  }
}

function ledgerTypeLabel(type) {
  return {
    expense: "支出",
    income: "收入",
    investment: "投資買入",
    investment_income: "投資流入"
  }[type] || "記帳";
}

function summaryReplyText(entry, summary) {
  const title = `已記錄${ledgerTypeLabel(entry.type)}：${entry.note || entry.category || ""} ${formatMoney(entry.amount)}`.trim();
  const tickerLine = entry.ticker ? `ETF/標的：${entry.ticker}\n` : "";
  return [
    title,
    tickerLine + `${summary.month} 月統計`,
    `總收入：${formatMoney(summary.income)}`,
    `投資流入：${formatMoney(summary.investmentIncome)}`,
    `總支出：${formatMoney(summary.expense)}`,
    `投資總額：${formatMoney(summary.investment)}`,
    `剩餘現金流：${formatMoney(summary.remaining)}`
  ].join("\n");
}

function batchSummaryReplyText(entries, summary) {
  return [
    `已記錄 ${entries.length} 筆：`,
    ...entries.map((entry, index) => `${index + 1}. ${ledgerTypeLabel(entry.type)} ${entry.note || entry.category} ${formatMoney(entry.amount)}`),
    ...compactSummaryLines(summary)
  ].join("\n");
}

function entryReplyText(entry) {
  if (!entry) return "";
  const date = new Date(entry.occurredAt).toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
  const subject = entry.ticker || entry.note || entry.category || ledgerTypeLabel(entry.type);
  return `${date} ${ledgerTypeLabel(entry.type)} ${subject} ${formatMoney(entry.amount)}`;
}

function compactSummaryLines(summary) {
  return [
    `${summary.month} 月統計`,
    `總收入：${formatMoney(summary.income)}`,
    `投資流入：${formatMoney(summary.investmentIncome)}`,
    `總支出：${formatMoney(summary.expense)}`,
    `投資總額：${formatMoney(summary.investment)}`,
    `剩餘現金流：${formatMoney(summary.remaining)}`
  ];
}

function detailsReplyText(entries, summary) {
  if (!entries.length) return `目前 ${summary.month} 還沒有記帳資料。`;
  return [
    `${summary.month} 最近明細`,
    ...entries.map((entry, index) => `${index + 1}. ${entryReplyText(entry)}`),
    "需要修正時，輸入「修改上一筆 80」或「刪除上一筆」。"
  ].join("\n");
}

function mutationReplyText(action, result, summary) {
  if (!result.entry) return "目前沒有可以修改或刪除的記帳資料。";
  const title = action.startsWith("delete") ? `已刪除第 ${result.index || 1} 筆` : `已修改第 ${result.index || 1} 筆`;
  const duplicate = result.duplicate ? "（這個指令已處理過，未重複執行）" : "";
  return [title + duplicate, entryReplyText(result.entry), ...compactSummaryLines(summary), "回到網頁按「重新整理」即可同步最新結果。"].join("\n");
}

function helpReplyText(reason = "") {
  if (reason === "missing_expense_amount") {
    return "請補上支出金額，例如：買早餐 65、付房租 12000。\n若要結束，請按「取消」或輸入「取消／按錯」。";
  }
  if (reason === "missing_income_amount") {
    return "請補上收入金額，例如：月薪 5萬、獎金 3000。\n若要結束，請按「取消」或輸入「取消／按錯」。";
  }
  if (reason === "missing_investment_details") {
    return "請選擇買入、收到配息或賣出，並提供金額。\n例如：買 0056 10000、0056 配息 800、賣出 0056 收到 12000。\n若要結束，請按「取消」或輸入「取消／按錯」。";
  }
  if (reason === "unrealized_investment_gain") {
    return "這筆是已經賣出收到的款項，還是尚未賣出的帳面損益？\n已賣出請輸入：賣出 0056 收到 12000。\n尚未賣出不會記入現金流；也可以輸入「取消／按錯」。";
  }
  return [
    "我還沒看懂這筆。",
    "你可以這樣輸入：",
    "買早餐 65",
    "付房租 12000",
    "賺 3000",
    "買 0056 10000",
    "0056 配息 800",
    "賣出 0056 收到 12000",
    "查明細",
    "修改上一筆 80",
    "刪除上一筆",
    "刪除全部資料",
    "取消／按錯"
  ].join("\n");
}

function summaryFlexMessage(title, subtitle, summary, allowUndo = true) {
  const siteUrl = String(process.env.SITE_PUBLIC_BASE_URL || "https://shaino0807.github.io/small-budget-cashflow-web/");
  const metric = (label, value, color = "#04342C") => ({
    type: "box",
    layout: "horizontal",
    margin: "md",
    contents: [
      { type: "text", text: label, size: "sm", color: "#65736F", flex: 3 },
      { type: "text", text: formatMoney(value), size: "sm", color, weight: "bold", align: "end", flex: 4 }
    ]
  });
  const messageButton = (label, text, primary = false) => ({
    type: "button",
    style: primary ? "primary" : "secondary",
    color: primary ? "#1D9E75" : undefined,
    height: "sm",
    action: { type: "message", label, text }
  });
  return {
    type: "flex",
    altText: `${title}｜收入 ${formatMoney(summary.income)}、投資流入 ${formatMoney(summary.investmentIncome)}、支出 ${formatMoney(summary.expense)}、投資買入 ${formatMoney(summary.investment)}`,
    contents: {
      type: "bubble",
      size: "mega",
      styles: {
        header: { backgroundColor: "#04342C" },
        footer: { separator: true, separatorColor: "#DDE8E4" }
      },
      header: {
        type: "box",
        layout: "vertical",
        paddingAll: "20px",
        contents: [
          { type: "text", text: title, color: "#FFFFFF", weight: "bold", size: "lg", wrap: true },
          { type: "text", text: subtitle || `${summary.month} 月現金流`, color: "#9FE1CB", size: "sm", margin: "sm", wrap: true }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "20px",
        contents: [
          { type: "text", text: `${summary.month} 月統計`, color: "#04342C", weight: "bold", size: "md" },
          metric("總收入", summary.income),
          metric("投資流入", summary.investmentIncome, "#12654E"),
          metric("總支出", summary.expense, "#B42318"),
          metric("投資買入", summary.investment, "#7C3AED"),
          { type: "separator", margin: "lg", color: "#DDE8E4" },
          metric("剩餘現金流", summary.remaining, Number(summary.remaining) >= 0 ? "#1D9E75" : "#B42318")
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        paddingAll: "16px",
        contents: [
          { type: "box", layout: "horizontal", spacing: "sm", contents: [messageButton("本月摘要", "本月摘要", true), messageButton("修改上一筆", "修改上一筆")] },
          { type: "box", layout: "horizontal", spacing: "sm", contents: [
            { type: "button", style: "secondary", height: "sm", action: { type: "uri", label: "完整報告", uri: siteUrl } },
            messageButton("補 ETF 部位", "ETF 配置")
          ] },
          ...(allowUndo ? [messageButton("按錯／撤銷剛才這筆", "按錯")] : [])
        ]
      }
    }
  };
}

async function replyLineMessage(replyToken, messages) {
  if (!replyToken || process.env.LINE_REPLY_DISABLED === "1") {
    return { skipped: true, reason: process.env.LINE_REPLY_DISABLED === "1" ? "reply_disabled" : "missing_reply_token" };
  }
  const token = lineChannelAccessToken();
  if (!token) return { skipped: true, reason: "channel_access_token_not_configured" };
  const response = await fetch(lineReplyEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ replyToken, messages })
  });
  if (!response.ok) {
    const error = new Error(`LINE reply API HTTP ${response.status}`);
    error.statusCode = 502;
    throw error;
  }
  return { skipped: false };
}

function pendingPrompt(command) {
  return {
    prompt_expense: {
      type: "expense",
      label: "支出",
      text: "請輸入支出內容與金額，例如：買早餐 65、付房租 12000。"
    },
    prompt_income: {
      type: "income",
      label: "收入",
      text: "請輸入收入內容與金額，例如：月薪 5萬、獎金 3000。"
    },
    prompt_investment: {
      type: "investment",
      label: "ETF／股票交易",
      text: "請選擇買入、收到配息或賣出，並提供金額。\n例如：買 0056 10000、0056 配息 800、賣出 0056 收到 12000。"
    },
    prompt_binding: {
      type: "binding",
      label: "綁定網頁帳號",
      text: process.env.LINE_LIFF_URL
        ? `請開啟會員帳本，LINE 會自動登入並同步你的記帳資料。\n${process.env.LINE_LIFF_URL}`
        : `請先開啟現金流網站完成免費健檢，在報告的「LINE 懶人記帳同步」取得 6 位數碼，再傳送「綁定 123456」。\n${String(process.env.SITE_PUBLIC_BASE_URL || "https://shaino0807.github.io/small-budget-cashflow-web/")}`
    },
    prompt_update_last: {
      type: "update",
      label: "修改上一筆",
      text: "請在後面加上正確金額，例如：修改上一筆 80。"
    },
    request_delete_all: {
      type: "delete_all",
      label: "刪除全部資料",
      text: "這會刪除所有 LINE 記帳、ETF 部位、財務設定與網頁綁定，而且無法復原。\n若確定要刪除，請輸入：確認刪除全部資料"
    }
  }[command] || null;
}

function canceledPrefix(canceled) {
  return canceled?.label ? `已取消「${canceled.label}」　+$0\n` : "";
}

function cancelReplyText(result) {
  if (result?.kind === "pending") {
    return `已取消「${result.label}」　+$0\n這個項目沒有寫入記帳，也不會影響現金流。`;
  }
  if (result?.kind === "entry" && result.entry) {
    const subject = result.label || result.entry.ticker || result.entry.note || result.entry.category || ledgerTypeLabel(result.entry.type);
    return `已撤銷剛才的「${subject}」　+$0\n現金流與 ETF 部位已回復。`;
  }
  return "目前沒有待輸入或剛完成可撤銷的項目。較早的紀錄請使用「刪除上一筆」或「刪除第 N 筆」。";
}

function cancelableTextMessage(text) {
  return {
    type: "text",
    text,
    quickReply: {
      items: [{
        type: "action",
        action: { type: "message", label: "取消", text: "取消" }
      }]
    }
  };
}

async function handleLineWebhook(rawBody, options = {}) {
  const body = parseLineWebhook(rawBody);
  const events = Array.isArray(body.events) ? body.events : [];
  const replies = [];
  for (const event of events) {
    if (event.type !== "message" || event.message?.type !== "text") continue;
    const text = String(event.message.text || "");
    const userId = event.source?.userId || "";
    let replyText = connectionReplyText();
    let ledgerResult = null;
    let bindingResult = null;
    let commandResult = null;
    const parsed = await parseIncomingMessage(text);
    if (parsed.intent === "command") {
      if (!options.store || !userId) {
        replyText = "LINE 記帳後端尚未準備好，請稍後再試。";
      } else {
        try {
          const prompt = pendingPrompt(parsed.command);
          if (parsed.command === "cancel_current") {
            const result = options.store.cancelCurrentLineInput({
              lineUserId: userId,
              sourceMessageId: event.message.id
            });
            commandResult = { command: parsed.command, result };
            replyText = cancelReplyText(result);
          } else if (prompt) {
            const pending = options.store.startLinePendingInput({
              lineUserId: userId,
              type: prompt.type,
              label: prompt.label,
              sourceMessageId: event.message.id
            });
            commandResult = { command: parsed.command, pending: true, result: pending };
            replyText = `${canceledPrefix(pending.canceled)}${prompt.text}\n若要結束，請按「取消」或輸入「取消／按錯」。`;
          } else if (parsed.command === "confirm_delete_all") {
            const deleted = options.store.deleteLineUserData({ lineUserId: userId });
            commandResult = { command: parsed.command, deleted };
            replyText = `已刪除全部 LINE 財務資料。\n記帳 ${deleted.ledgerEntries} 筆、ETF 部位 ${deleted.holdings} 筆、網頁綁定 ${deleted.bindings} 筆。`;
          } else if (parsed.command === "details") {
            const canceled = options.store.clearLinePendingInput({ lineUserId: userId });
            const summary = options.store.lineLedgerSummary(userId);
            const entries = options.store.lineLedgerEntries(userId, summary.month, 8);
            commandResult = { command: parsed.command, entries, summary };
            replyText = `${canceledPrefix(canceled)}${detailsReplyText(entries, summary)}`;
          } else {
            const canceled = options.store.clearLinePendingInput({ lineUserId: userId });
            const isDelete = parsed.command.startsWith("delete");
            const isIndexed = parsed.command.endsWith("indexed");
            const result = isDelete
              ? isIndexed
                ? options.store.deleteIndexedLineLedgerEntry({ lineUserId: userId, index: parsed.index, sourceMessageId: event.message.id })
                : options.store.deleteLastLineLedgerEntry({ lineUserId: userId, sourceMessageId: event.message.id })
              : isIndexed
                ? options.store.updateIndexedLineLedgerEntry({ lineUserId: userId, index: parsed.index, amount: parsed.amount, sourceMessageId: event.message.id })
                : options.store.updateLastLineLedgerEntry({ lineUserId: userId, amount: parsed.amount, sourceMessageId: event.message.id });
            options.store.markLineUndoTarget({ lineUserId: userId, entries: [] });
            const summary = options.store.lineLedgerSummary(userId);
            commandResult = { command: parsed.command, result, summary };
            replyText = `${canceledPrefix(canceled)}${mutationReplyText(parsed.command, result, summary)}`;
          }
        } catch (error) {
          replyText = error.message || "記帳指令處理失敗，請稍後再試。";
        }
      }
    } else if (parsed.intent === "binding") {
      if (!options.store || !userId) {
        replyText = "目前無法確認你的 LINE 身分，請稍後再試。";
      } else {
        try {
          bindingResult = options.store.bindLineReport({ lineUserId: userId, code: parsed.code });
          options.store.clearLinePendingInput({ lineUserId: userId });
          replyText = "綁定成功。之後在 LINE 記錄的收入、支出與 ETF 投資，會同步到這份網頁報告。";
        } catch (error) {
          replyText = error.message || "綁定失敗，請回到網頁重新產生綁定碼。";
        }
      }
    } else if (parsed.intent === "ledger_batch") {
      if (!options.store || !userId) {
        replyText = "LINE 記帳後端尚未準備好，請稍後再試。";
      } else {
        const entries = [];
        let duplicateCount = 0;
        for (let index = 0; index < parsed.entries.length; index += 1) {
          const item = parsed.entries[index];
          try {
            entries.push(options.store.addLineLedgerEntry({
              lineUserId: userId,
              ...item,
              source: {
                platform: "line",
                parser: "ai",
                messageId: `${event.message.id}:${index + 1}`,
                messageText: text,
                replyToken: event.replyToken ? "present" : "missing"
              }
            }));
          } catch (error) {
            if (error.statusCode === 409) duplicateCount += 1;
            else throw error;
          }
        }
        if (entries.length) {
          options.store.clearLinePendingInput({ lineUserId: userId });
          options.store.markLineUndoTarget({ lineUserId: userId, entries });
        }
        const summary = options.store.lineLedgerSummary(userId);
        ledgerResult = { entries, summary, parser: "ai" };
        replyText = entries.length
          ? batchSummaryReplyText(entries, summary)
          : `這 ${duplicateCount} 筆資料已經記錄過，不會重複入帳。\n${compactSummaryLines(summary).join("\n")}`;
      }
    } else if (parsed.intent === "ledger") {
      if (!options.store || !userId) {
        replyText = "LINE 記帳後端尚未準備好，請稍後再試。";
      } else {
        try {
          const entry = options.store.addLineLedgerEntry({
            lineUserId: userId,
            type: parsed.type,
            amount: parsed.amount,
            category: parsed.category,
            ticker: parsed.ticker,
            note: parsed.note,
            occurredAt: parsed.occurredAt,
            profilePatch: parsed.profilePatch,
            source: {
              platform: "line",
              messageId: event.message.id,
              messageText: text,
              replyToken: event.replyToken ? "present" : "missing"
            }
          });
          options.store.clearLinePendingInput({ lineUserId: userId });
          options.store.markLineUndoTarget({ lineUserId: userId, entries: [entry] });
          const summary = options.store.lineLedgerSummary(userId);
          ledgerResult = { entry, summary };
          replyText = summaryReplyText(entry, summary);
        } catch (error) {
          if (error.statusCode !== 409) throw error;
          const summary = options.store.lineLedgerSummary(userId);
          replyText = [
            "這筆 LINE 訊息已經記錄過，不會重複入帳。",
            `${summary.month} 月統計`,
            `總收入：${formatMoney(summary.income)}`,
            `投資流入：${formatMoney(summary.investmentIncome)}`,
            `總支出：${formatMoney(summary.expense)}`,
            `投資總額：${formatMoney(summary.investment)}`,
            `剩餘現金流：${formatMoney(summary.remaining)}`
          ].join("\n");
        }
      }
    } else if (parsed.intent === "help" && options.store && userId && ["missing_expense_amount", "missing_income_amount", "missing_investment_details", "unrealized_investment_gain"].includes(parsed.reason)) {
      const promptType = parsed.reason === "missing_expense_amount"
        ? "expense"
        : parsed.reason === "missing_income_amount"
          ? "income"
          : "investment";
      const label = promptType === "expense" ? "支出" : promptType === "income" ? "收入" : "ETF／股票交易";
      const pending = options.store.startLinePendingInput({
        lineUserId: userId,
        type: promptType,
        label,
        sourceMessageId: event.message.id
      });
      commandResult = { command: `prompt_${promptType}`, pending: true, result: pending };
      replyText = `${canceledPrefix(pending.canceled)}${helpReplyText(parsed.reason)}`;
    } else if (!/測試|test|hello|hi|嗨|哈囉/i.test(text)) {
      replyText = helpReplyText(parsed.reason);
    }
    let messages = [{ type: "text", text: replyText }];
    if (ledgerResult?.summary) {
      const recorded = ledgerResult.entry || ledgerResult.entries?.[0];
      const title = ledgerResult.entries?.length > 1 ? `已記錄 ${ledgerResult.entries.length} 筆` : `已記錄${ledgerTypeLabel(recorded?.type)}`;
      const subtitle = ledgerResult.entries?.length > 1
        ? ledgerResult.entries.map((entry) => `${entry.note || entry.category} ${formatMoney(entry.amount)}`).join("、").slice(0, 100)
        : `${recorded?.note || recorded?.category || ""} ${formatMoney(recorded?.amount)}`;
      messages = [summaryFlexMessage(title, subtitle, ledgerResult.summary)];
    } else if (commandResult?.summary && commandResult?.result?.entry) {
      const actionTitle = commandResult.command.startsWith("delete") ? "已刪除記帳" : "已修改記帳";
      messages = [summaryFlexMessage(actionTitle, entryReplyText(commandResult.result.entry), commandResult.summary, false)];
    } else if (commandResult?.pending) {
      messages = [cancelableTextMessage(replyText)];
    }
    const result = await replyLineMessage(event.replyToken, messages);
    replies.push({
      eventType: event.type,
      messageType: event.message.type,
      parsedIntent: parsed.intent,
      ledgerType: ledgerResult?.entry?.type || null,
      ledgerCount: ledgerResult?.entries?.length || (ledgerResult?.entry ? 1 : 0),
      parser: ledgerResult?.parser || "rules",
      binding: bindingResult ? "linked" : null,
      command: commandResult?.command || null,
      commandDuplicate: Boolean(commandResult?.result?.duplicate),
      pending: Boolean(commandResult?.pending),
      canceled: commandResult?.result?.canceled?.label || commandResult?.result?.kind || null,
      userId: event.source?.userId ? "present" : "missing",
      ...result
    });
  }
  return { receivedEvents: events.length, replies };
}

module.exports = {
  handleLineWebhook,
  lineReadiness,
  parseBindingMessage,
  parseIncomingMessage,
  parseLineCommand,
  parseLedgerMessage,
  parseLedgerMessageWithAi,
  summaryFlexMessage,
  verifyLineSignature
};
