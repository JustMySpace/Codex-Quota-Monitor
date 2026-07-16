import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles.css";

type TokenCounts = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
};

type MinuteBucket = TokenCounts & {
  minute: string;
  events: number;
};

type RateLimitSnapshot = {
  used_percent?: number | null;
  window_minutes?: number | null;
  resets_at?: number | null;
  plan_type?: string | null;
  credits?: {
    has_credits: boolean;
    unlimited: boolean;
    balance?: string | null;
  } | null;
};

type RateLimitPoint = {
  minute: string;
  used_percent: number;
  remaining_percent: number;
  window_minutes?: number | null;
  resets_at?: number | null;
};

type LatestUsage = {
  timestamp: string;
  minute: string;
  last: TokenCounts;
  total: TokenCounts;
  model_context_window?: number | null;
  rate_limit?: RateLimitSnapshot | null;
};

type SessionSummary = TokenCounts & {
  id: string;
  first_seen?: string | null;
  last_seen?: string | null;
  events: number;
  last_cumulative_total: number;
};

type UsageDashboard = {
  scanned_at_ms: number;
  lookback_days: number;
  codex_sessions_path: string;
  cache_path: string;
  totals: TokenCounts & { events: number };
  latest?: LatestUsage | null;
  buckets: MinuteBucket[];
  rate_limit_points?: RateLimitPoint[];
  sessions: SessionSummary[];
  errors: string[];
};

type SeriesBucket = MinuteBucket & {
  ms: number;
  fresh_input_tokens: number;
  visible_output_tokens: number;
};

type CumulativePoint = {
  ms: number;
  minute: string;
  total_tokens: number;
};

type BurnDownPoint = {
  ms: number;
  remaining_percent: number;
};

const root = document.querySelector<HTMLDivElement>("#app");

if (!root) {
  throw new Error("App root not found");
}

const app: HTMLDivElement = root;
const currentWindow = getCurrentWindow();
const currentWindowLabel = currentWindow.label;
const isPanelWindow = currentWindowLabel === "panel";
const opacityStorageKey = "codex-quota-monitor.opacity";
const languageStorageKey = "codex-quota-monitor.language";
const themeStorageKey = "codex-quota-monitor.theme";
const burnDaysStorageKey = "codex-quota-monitor.burn-days";

const locales = [
  { code: "en", label: "English" },
  { code: "zh-CN", label: "简体中文" },
  { code: "zh-TW", label: "繁體中文" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "pt-BR", label: "Português" },
  { code: "ru", label: "Русский" },
] as const;

type Locale = (typeof locales)[number]["code"];
type LanguageChoice = "system" | Locale;
type ThemeChoice = "system" | "dark" | "light";
type Theme = "dark" | "light";
type BurnDay = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const allBurnDays: BurnDay[] = [0, 1, 2, 3, 4, 5, 6];

const en = {
  actualRemaining: "Actual remaining",
  burnDownChart: "Quota burn-down",
  cached: "Cached",
  close: "Close",
  collapse: "Collapse",
  context: "Context",
  cumulative: "Cumulative",
  currentRange: "Current range",
  curve: "Curve",
  daysAgo: "d ago",
  darkTheme: "Dark",
  doubleClickPanel: "double click panel",
  fiveMin: "5 min",
  fiveMinShort: "5m",
  freshInput: "Fresh input",
  hoursAgo: "h ago",
  language: "Language",
  last1h: "Last 1h",
  localCodexMonitor: "Local Codex Monitor",
  localDay: "local day",
  minutesAgo: "m ago",
  noRateLimitData: "No rate-limit snapshots found.",
  noEvents: "No Codex token events found.",
  now: "now",
  opacity: "Opacity",
  output: "Output",
  peak5Min: "peak / 5 min",
  plan: "Plan",
  primaryQuotaRemaining: "Primary quota remaining",
  quotaTitle: "Quota Remaining & Token Usage",
  reasoning: "Reasoning",
  recentSession: "Recent sessions",
  refresh: "Refresh",
  remaining: "remaining",
  remainingQuota: "Remaining quota",
  reset: "Reset",
  resetWindow: "Reset window",
  realtime: "Realtime",
  realtimeCurve: "Realtime curve",
  scanning: "Scanning",
  shown: "shown",
  stacked5Min: "5-minute stacked",
  systemLanguage: "System",
  today: "Today",
  todayCurve: "Today curve",
  todayCumulativeCurve: "Today's cumulative curve",
  todayTotal: "Today total",
  tokenStackLegend: "fresh input / cached / output / reasoning",
  totalToday: "total today",
  turns: "turns",
  theme: "Theme",
  unknown: "unknown",
  idealBurn: "Ideal",
  lightTheme: "Light",
  useDay: "USE DAY",
  used: "used",
} as const;

type TranslationKey = keyof typeof en;

const translations: Record<Locale, Record<TranslationKey, string>> = {
  en,
  "zh-CN": {
    actualRemaining: "实际剩余",
    burnDownChart: "额度燃尽图",
    cached: "Cached",
    close: "关闭",
    collapse: "收起",
    context: "上下文",
    cumulative: "累计",
    currentRange: "当前范围",
    curve: "曲线",
    daysAgo: "天前",
    darkTheme: "暗色",
    doubleClickPanel: "双击打开面板",
    fiveMin: "5 分钟",
    fiveMinShort: "5分",
    freshInput: "Fresh input",
    hoursAgo: "小时前",
    language: "语言",
    last1h: "最近 1h",
    localCodexMonitor: "Local Codex Monitor",
    localDay: "本地当天",
    minutesAgo: "分钟前",
    noRateLimitData: "未找到 rate limit 快照。",
    noEvents: "未找到 Codex token 事件。",
    now: "刚刚",
    opacity: "透明度",
    output: "Output",
    peak5Min: "峰值 / 5 分钟",
    plan: "套餐",
    primaryQuotaRemaining: "主额度剩余",
    quotaTitle: "额度剩余与 Token 消耗",
    reasoning: "Reasoning",
    recentSession: "最近 Session",
    refresh: "刷新",
    remaining: "剩余",
    remainingQuota: "剩余额度",
    reset: "重置",
    resetWindow: "重置周期",
    realtime: "实时",
    realtimeCurve: "实时曲线",
    scanning: "扫描中",
    shown: "条",
    stacked5Min: "5 分钟分段堆叠",
    systemLanguage: "跟随系统",
    today: "今天",
    todayCurve: "今日曲线",
    todayCumulativeCurve: "当天累计曲线",
    todayTotal: "今日总量",
    tokenStackLegend: "fresh input / cached / output / reasoning",
    totalToday: "今日总量",
    turns: "轮",
    theme: "主题",
    unknown: "未知",
    idealBurn: "理想消耗",
    lightTheme: "亮色",
    useDay: "USE DAY",
    used: "已用",
  },
  "zh-TW": {
    actualRemaining: "實際剩餘",
    burnDownChart: "額度燃盡圖",
    cached: "Cached",
    close: "關閉",
    collapse: "收起",
    context: "上下文",
    cumulative: "累計",
    currentRange: "目前範圍",
    curve: "曲線",
    daysAgo: "天前",
    darkTheme: "暗色",
    doubleClickPanel: "雙擊開啟面板",
    fiveMin: "5 分鐘",
    fiveMinShort: "5分",
    freshInput: "Fresh input",
    hoursAgo: "小時前",
    language: "語言",
    last1h: "最近 1h",
    localCodexMonitor: "Local Codex Monitor",
    localDay: "本地當天",
    minutesAgo: "分鐘前",
    noRateLimitData: "未找到 rate limit 快照。",
    noEvents: "未找到 Codex token 事件。",
    now: "剛剛",
    opacity: "透明度",
    output: "Output",
    peak5Min: "峰值 / 5 分鐘",
    plan: "方案",
    primaryQuotaRemaining: "主額度剩餘",
    quotaTitle: "額度剩餘與 Token 消耗",
    reasoning: "Reasoning",
    recentSession: "最近 Session",
    refresh: "重新整理",
    remaining: "剩餘",
    remainingQuota: "剩餘額度",
    reset: "重置",
    resetWindow: "重置週期",
    realtime: "即時",
    realtimeCurve: "即時曲線",
    scanning: "掃描中",
    shown: "筆",
    stacked5Min: "5 分鐘分段堆疊",
    systemLanguage: "跟隨系統",
    today: "今天",
    todayCurve: "今日曲線",
    todayCumulativeCurve: "當天累計曲線",
    todayTotal: "今日總量",
    tokenStackLegend: "fresh input / cached / output / reasoning",
    totalToday: "今日總量",
    turns: "輪",
    theme: "主題",
    unknown: "未知",
    idealBurn: "理想消耗",
    lightTheme: "亮色",
    useDay: "USE DAY",
    used: "已用",
  },
  ja: {
    actualRemaining: "実際の残量",
    burnDownChart: "クォータ燃焼チャート",
    cached: "Cached",
    close: "閉じる",
    collapse: "折りたたむ",
    context: "コンテキスト",
    cumulative: "累積",
    currentRange: "現在の範囲",
    curve: "曲線",
    daysAgo: "日前",
    darkTheme: "ダーク",
    doubleClickPanel: "ダブルクリックでパネル",
    fiveMin: "5分",
    fiveMinShort: "5分",
    freshInput: "Fresh input",
    hoursAgo: "時間前",
    language: "言語",
    last1h: "直近 1h",
    localCodexMonitor: "Local Codex Monitor",
    localDay: "ローカル日",
    minutesAgo: "分前",
    noRateLimitData: "rate limit スナップショットが見つかりません。",
    noEvents: "Codex token イベントが見つかりません。",
    now: "今",
    opacity: "透明度",
    output: "Output",
    peak5Min: "ピーク / 5分",
    plan: "プラン",
    primaryQuotaRemaining: "主クォータ残量",
    quotaTitle: "クォータ残量と Token 使用量",
    reasoning: "Reasoning",
    recentSession: "最近の Session",
    refresh: "更新",
    remaining: "残り",
    remainingQuota: "残りクォータ",
    reset: "リセット",
    resetWindow: "リセット期間",
    realtime: "リアルタイム",
    realtimeCurve: "リアルタイム曲線",
    scanning: "スキャン中",
    shown: "件",
    stacked5Min: "5分スタック",
    systemLanguage: "システム",
    today: "今日",
    todayCurve: "今日の曲線",
    todayCumulativeCurve: "今日の累積曲線",
    todayTotal: "今日の合計",
    tokenStackLegend: "fresh input / cached / output / reasoning",
    totalToday: "今日の合計",
    turns: "ターン",
    theme: "テーマ",
    unknown: "不明",
    idealBurn: "理想",
    lightTheme: "ライト",
    useDay: "USE DAY",
    used: "使用済み",
  },
  ko: {
    actualRemaining: "실제 남음",
    burnDownChart: "할당량 번다운",
    cached: "Cached",
    close: "닫기",
    collapse: "접기",
    context: "컨텍스트",
    cumulative: "누적",
    currentRange: "현재 범위",
    curve: "곡선",
    daysAgo: "일 전",
    darkTheme: "다크",
    doubleClickPanel: "두 번 클릭해 패널 열기",
    fiveMin: "5분",
    fiveMinShort: "5분",
    freshInput: "Fresh input",
    hoursAgo: "시간 전",
    language: "언어",
    last1h: "최근 1h",
    localCodexMonitor: "Local Codex Monitor",
    localDay: "로컬 날짜",
    minutesAgo: "분 전",
    noRateLimitData: "rate limit 스냅샷을 찾을 수 없습니다.",
    noEvents: "Codex token 이벤트를 찾을 수 없습니다.",
    now: "지금",
    opacity: "투명도",
    output: "Output",
    peak5Min: "피크 / 5분",
    plan: "플랜",
    primaryQuotaRemaining: "기본 할당량 남음",
    quotaTitle: "할당량 잔여와 Token 사용량",
    reasoning: "Reasoning",
    recentSession: "최근 Session",
    refresh: "새로고침",
    remaining: "남음",
    remainingQuota: "남은 할당량",
    reset: "리셋",
    resetWindow: "리셋 기간",
    realtime: "실시간",
    realtimeCurve: "실시간 곡선",
    scanning: "스캔 중",
    shown: "개",
    stacked5Min: "5분 스택",
    systemLanguage: "시스템",
    today: "오늘",
    todayCurve: "오늘 곡선",
    todayCumulativeCurve: "오늘 누적 곡선",
    todayTotal: "오늘 합계",
    tokenStackLegend: "fresh input / cached / output / reasoning",
    totalToday: "오늘 합계",
    turns: "턴",
    theme: "테마",
    unknown: "알 수 없음",
    idealBurn: "이상적",
    lightTheme: "라이트",
    useDay: "USE DAY",
    used: "사용됨",
  },
  fr: {
    actualRemaining: "Restant réel",
    burnDownChart: "Consommation du quota",
    cached: "Cached",
    close: "Fermer",
    collapse: "Réduire",
    context: "Contexte",
    cumulative: "Cumul",
    currentRange: "Plage actuelle",
    curve: "Courbe",
    daysAgo: "j",
    darkTheme: "Sombre",
    doubleClickPanel: "double-clic panneau",
    fiveMin: "5 min",
    fiveMinShort: "5m",
    freshInput: "Fresh input",
    hoursAgo: "h",
    language: "Langue",
    last1h: "Dernière 1h",
    localCodexMonitor: "Local Codex Monitor",
    localDay: "jour local",
    minutesAgo: "min",
    noRateLimitData: "Aucun instantané rate limit trouvé.",
    noEvents: "Aucun événement token Codex trouvé.",
    now: "maintenant",
    opacity: "Opacité",
    output: "Output",
    peak5Min: "pic / 5 min",
    plan: "Plan",
    primaryQuotaRemaining: "Quota principal restant",
    quotaTitle: "Quota restant et usage Token",
    reasoning: "Reasoning",
    recentSession: "Sessions récentes",
    refresh: "Actualiser",
    remaining: "restant",
    remainingQuota: "Quota restant",
    reset: "Réinitialisation",
    resetWindow: "Fenêtre de réinitialisation",
    realtime: "Temps réel",
    realtimeCurve: "Courbe temps réel",
    scanning: "Analyse",
    shown: "affichées",
    stacked5Min: "Empilé 5 minutes",
    systemLanguage: "Système",
    today: "Aujourd'hui",
    todayCurve: "Courbe du jour",
    todayCumulativeCurve: "Courbe cumulée du jour",
    todayTotal: "Total du jour",
    tokenStackLegend: "fresh input / cached / output / reasoning",
    totalToday: "total du jour",
    turns: "tours",
    theme: "Thème",
    unknown: "inconnu",
    idealBurn: "Idéal",
    lightTheme: "Clair",
    useDay: "USE DAY",
    used: "utilisé",
  },
  de: {
    actualRemaining: "Tatsächlich übrig",
    burnDownChart: "Kontingent-Burndown",
    cached: "Cached",
    close: "Schließen",
    collapse: "Einklappen",
    context: "Kontext",
    cumulative: "Kumulativ",
    currentRange: "Aktueller Bereich",
    curve: "Kurve",
    daysAgo: "Tage zuvor",
    darkTheme: "Dunkel",
    doubleClickPanel: "Doppelklick Panel",
    fiveMin: "5 Min.",
    fiveMinShort: "5m",
    freshInput: "Fresh input",
    hoursAgo: "Std. zuvor",
    language: "Sprache",
    last1h: "Letzte 1h",
    localCodexMonitor: "Local Codex Monitor",
    localDay: "lokaler Tag",
    minutesAgo: "Min. zuvor",
    noRateLimitData: "Keine Rate-Limit-Snapshots gefunden.",
    noEvents: "Keine Codex token Ereignisse gefunden.",
    now: "jetzt",
    opacity: "Deckkraft",
    output: "Output",
    peak5Min: "Spitze / 5 Min.",
    plan: "Plan",
    primaryQuotaRemaining: "Primäres Kontingent übrig",
    quotaTitle: "Kontingent übrig & Token-Verbrauch",
    reasoning: "Reasoning",
    recentSession: "Letzte Sessions",
    refresh: "Aktualisieren",
    remaining: "übrig",
    remainingQuota: "Kontingent übrig",
    reset: "Reset",
    resetWindow: "Reset-Fenster",
    realtime: "Echtzeit",
    realtimeCurve: "Echtzeitkurve",
    scanning: "Scanne",
    shown: "angezeigt",
    stacked5Min: "5-Minuten-Stapel",
    systemLanguage: "System",
    today: "Heute",
    todayCurve: "Tageskurve",
    todayCumulativeCurve: "Kumulative Tageskurve",
    todayTotal: "Tagessumme",
    tokenStackLegend: "fresh input / cached / output / reasoning",
    totalToday: "heute gesamt",
    turns: "Turns",
    theme: "Design",
    unknown: "unbekannt",
    idealBurn: "Ideal",
    lightTheme: "Hell",
    useDay: "USE DAY",
    used: "genutzt",
  },
  es: {
    actualRemaining: "Restante real",
    burnDownChart: "Consumo de cuota",
    cached: "Cached",
    close: "Cerrar",
    collapse: "Contraer",
    context: "Contexto",
    cumulative: "Acumulado",
    currentRange: "Rango actual",
    curve: "Curva",
    daysAgo: "d atrás",
    darkTheme: "Oscuro",
    doubleClickPanel: "doble clic panel",
    fiveMin: "5 min",
    fiveMinShort: "5m",
    freshInput: "Fresh input",
    hoursAgo: "h atrás",
    language: "Idioma",
    last1h: "Última 1h",
    localCodexMonitor: "Local Codex Monitor",
    localDay: "día local",
    minutesAgo: "min atrás",
    noRateLimitData: "No se encontraron instantáneas de rate limit.",
    noEvents: "No se encontraron eventos token de Codex.",
    now: "ahora",
    opacity: "Opacidad",
    output: "Output",
    peak5Min: "pico / 5 min",
    plan: "Plan",
    primaryQuotaRemaining: "Cuota principal restante",
    quotaTitle: "Cuota restante y uso de Token",
    reasoning: "Reasoning",
    recentSession: "Sesiones recientes",
    refresh: "Actualizar",
    remaining: "restante",
    remainingQuota: "Cuota restante",
    reset: "Reinicio",
    resetWindow: "Ventana de reinicio",
    realtime: "Tiempo real",
    realtimeCurve: "Curva en tiempo real",
    scanning: "Escaneando",
    shown: "mostradas",
    stacked5Min: "Apilado de 5 minutos",
    systemLanguage: "Sistema",
    today: "Hoy",
    todayCurve: "Curva de hoy",
    todayCumulativeCurve: "Curva acumulada de hoy",
    todayTotal: "Total de hoy",
    tokenStackLegend: "fresh input / cached / output / reasoning",
    totalToday: "total de hoy",
    turns: "turnos",
    theme: "Tema",
    unknown: "desconocido",
    idealBurn: "Ideal",
    lightTheme: "Claro",
    useDay: "USE DAY",
    used: "usado",
  },
  "pt-BR": {
    actualRemaining: "Restante real",
    burnDownChart: "Queima da cota",
    cached: "Cached",
    close: "Fechar",
    collapse: "Recolher",
    context: "Contexto",
    cumulative: "Acumulado",
    currentRange: "Intervalo atual",
    curve: "Curva",
    daysAgo: "d atrás",
    darkTheme: "Escuro",
    doubleClickPanel: "duplo clique painel",
    fiveMin: "5 min",
    fiveMinShort: "5m",
    freshInput: "Fresh input",
    hoursAgo: "h atrás",
    language: "Idioma",
    last1h: "Última 1h",
    localCodexMonitor: "Local Codex Monitor",
    localDay: "dia local",
    minutesAgo: "min atrás",
    noRateLimitData: "Nenhum snapshot de rate limit encontrado.",
    noEvents: "Nenhum evento token do Codex encontrado.",
    now: "agora",
    opacity: "Opacidade",
    output: "Output",
    peak5Min: "pico / 5 min",
    plan: "Plano",
    primaryQuotaRemaining: "Cota principal restante",
    quotaTitle: "Cota restante e uso de Token",
    reasoning: "Reasoning",
    recentSession: "Sessões recentes",
    refresh: "Atualizar",
    remaining: "restante",
    remainingQuota: "Cota restante",
    reset: "Redefinir",
    resetWindow: "Janela de redefinição",
    realtime: "Tempo real",
    realtimeCurve: "Curva em tempo real",
    scanning: "Escaneando",
    shown: "exibidas",
    stacked5Min: "Empilhado de 5 minutos",
    systemLanguage: "Sistema",
    today: "Hoje",
    todayCurve: "Curva de hoje",
    todayCumulativeCurve: "Curva acumulada de hoje",
    todayTotal: "Total de hoje",
    tokenStackLegend: "fresh input / cached / output / reasoning",
    totalToday: "total de hoje",
    turns: "turnos",
    theme: "Tema",
    unknown: "desconhecido",
    idealBurn: "Ideal",
    lightTheme: "Claro",
    useDay: "USE DAY",
    used: "usado",
  },
  ru: {
    actualRemaining: "Фактический остаток",
    burnDownChart: "Сгорание квоты",
    cached: "Cached",
    close: "Закрыть",
    collapse: "Свернуть",
    context: "Контекст",
    cumulative: "Накопит.",
    currentRange: "Текущий диапазон",
    curve: "График",
    daysAgo: "дн. назад",
    darkTheme: "Темная",
    doubleClickPanel: "двойной клик: панель",
    fiveMin: "5 мин",
    fiveMinShort: "5м",
    freshInput: "Fresh input",
    hoursAgo: "ч назад",
    language: "Язык",
    last1h: "Последний 1ч",
    localCodexMonitor: "Local Codex Monitor",
    localDay: "локальный день",
    minutesAgo: "мин назад",
    noRateLimitData: "Снимки rate limit не найдены.",
    noEvents: "События token Codex не найдены.",
    now: "сейчас",
    opacity: "Прозрачность",
    output: "Output",
    peak5Min: "пик / 5 мин",
    plan: "План",
    primaryQuotaRemaining: "Основная квота осталась",
    quotaTitle: "Остаток квоты и расход Token",
    reasoning: "Reasoning",
    recentSession: "Последние Session",
    refresh: "Обновить",
    remaining: "осталось",
    remainingQuota: "Остаток квоты",
    reset: "Сброс",
    resetWindow: "Окно сброса",
    realtime: "Реальное время",
    realtimeCurve: "График реального времени",
    scanning: "Сканирование",
    shown: "показано",
    stacked5Min: "Стек за 5 минут",
    systemLanguage: "Система",
    today: "Сегодня",
    todayCurve: "График за сегодня",
    todayCumulativeCurve: "Накопительный график за сегодня",
    todayTotal: "Итого сегодня",
    tokenStackLegend: "fresh input / cached / output / reasoning",
    totalToday: "итого сегодня",
    turns: "ходов",
    theme: "Тема",
    unknown: "неизвестно",
    idealBurn: "Идеально",
    lightTheme: "Светлая",
    useDay: "USE DAY",
    used: "использовано",
  },
};

const state: {
  dashboard: UsageDashboard | null;
  expanded: boolean;
  compactMode: "tokens" | "curve";
  chartMode: "cumulative" | "realtime";
  language: LanguageChoice;
  theme: ThemeChoice;
  burnDays: BurnDay[];
  rangeMinutes: number;
  opacity: number;
  contextMenu: { x: number; y: number } | null;
  loading: boolean;
  error: string | null;
} = {
  dashboard: null,
  expanded: isPanelWindow,
  compactMode: "tokens",
  chartMode: "cumulative",
  language: readLanguage(),
  theme: readTheme(),
  burnDays: readBurnDays(),
  rangeMinutes: 360,
  opacity: readOpacity(),
  contextMenu: null,
  loading: true,
  error: null,
};

const ranges = [
  { label: "1h", minutes: 60 },
  { label: "6h", minutes: 360 },
  { label: "24h", minutes: 1440 },
  { label: "7d", minutes: 10080 },
];

async function refreshUsage() {
  state.loading = true;
  render();

  try {
    state.dashboard = await invoke<UsageDashboard>("scan_codex_usage");
    state.error = null;
  } catch (error) {
    state.error = String(error);
  } finally {
    state.loading = false;
    render();
  }
}

async function setExpanded(expanded: boolean) {
  try {
    if (expanded) {
      await invoke("open_panel");
    } else {
      await invoke("hide_panel");
    }
  } catch (error) {
    state.error = String(error);
    render();
  }
}

function render() {
  const dashboard = state.dashboard;
  app.className = `app ${state.expanded ? "expanded" : "compact"} theme-${activeTheme()}`;
  document.documentElement.dataset.theme = activeTheme();
  applyOpacity();

  app.innerHTML = state.expanded
    ? renderExpanded(dashboard)
    : renderCompact(dashboard);

  bindEvents();
}

function renderCompact(dashboard: UsageDashboard | null) {
  const remainingPercent = quotaRemainingPercent(dashboard);
  const fiveMinuteTotal = sumLastMinutes(dashboard, 5);
  const fiveMinuteAverage = Math.round(fiveMinuteTotal / 5);
  const today = sumToday(dashboard);
  const todaySeries = dashboard ? todayCumulativeSeries(dashboard) : [];

  return `
    <section class="shell shell-compact drag-region" aria-label="Codex token monitor" data-open-panel data-drag-window>
      <header class="compact-header">
        <div class="brand">
          <span class="status-dot ${state.loading ? "is-loading" : ""}"></span>
          <span>Codex</span>
        </div>
        <div class="window-actions">
          <button class="icon-button" type="button" data-action="refresh" aria-label="${t("refresh")}">R</button>
        </div>
      </header>
      <main class="compact-body">
        <div class="compact-monitor">
          <div class="today-metric">
            <div class="metric-label">${t("todayTotal")}</div>
            <div class="compact-value">${formatTokens(today)}</div>
            <div class="metric-sub">${t("remaining")} ${formatPercent(remainingPercent)}</div>
          </div>
          <div class="side-widget" data-mode-toggle data-no-drag role="button" tabindex="0" aria-label="${t("curve")}">
            ${
              state.compactMode === "tokens"
                ? `
                  <div class="side-label">${t("fiveMin")}</div>
                  <div class="side-value">${formatTokens(fiveMinuteTotal)}</div>
                  <div class="side-sub">${formatTokens(fiveMinuteAverage)} / min</div>
                `
                : `
                  <div class="side-label">${t("todayCurve")}</div>
                  ${renderCompactCumulativeSparkline(todaySeries)}
                  <div class="side-sub">${formatScannedAt(dashboard)}</div>
                `
            }
          </div>
        </div>
        <div class="compact-footline">
          <span>${formatScannedAt(dashboard)}</span>
        </div>
      </main>
      ${renderContextMenu()}
    </section>
  `;
}

function renderExpanded(dashboard: UsageDashboard | null) {
  const usedPercent = quotaUsedPercent(dashboard);
  const remainingPercent = quotaRemainingPercent(dashboard);
  const latest = dashboard?.latest ?? null;
  const today = sumToday(dashboard);
  const oneHour = sumLastMinutes(dashboard, 60);
  const selectedTotal = sumLastMinutes(dashboard, state.rangeMinutes);
  const stackedSeries = dashboard ? bucketedSeries(dashboard, state.rangeMinutes, 5) : [];
  const cumulativeSeries = dashboard ? todayCumulativeSeries(dashboard) : [];
  const cumulativeTotal = cumulativeSeries.at(-1)?.total_tokens ?? 0;
  const activeChartTitle = state.chartMode === "cumulative" ? t("todayCumulativeCurve") : t("realtimeCurve");
  const activeChartMeta =
    state.chartMode === "cumulative"
      ? `${formatTokens(cumulativeTotal)} ${t("totalToday")}`
      : `${formatTokens(maxTotal(stackedSeries))} ${t("peak5Min")}`;
  const activeChart =
    state.chartMode === "cumulative"
      ? renderCumulativeChart(cumulativeSeries)
      : renderLineChart(stackedSeries);
  const burnDownMeta = formatBurnDownWindow(dashboard);

  return `
    <section class="shell shell-expanded" aria-label="Codex quota monitor">
      <header class="panel-header drag-region" data-drag-window>
        <div class="title-block">
          <div class="eyebrow">${t("localCodexMonitor")}</div>
          <h1>${t("quotaTitle")}</h1>
        </div>
        <div class="window-actions">
          ${renderLanguageSelect()}
          ${renderThemeSelect()}
          <button class="ghost-button" type="button" data-action="refresh">${state.loading ? t("scanning") : t("refresh")}</button>
          <button class="icon-button close-button" type="button" data-action="collapse" aria-label="${t("close")}" title="${t("close")}">×</button>
        </div>
      </header>

      <main class="panel-content">
        ${renderError(dashboard)}
        <section class="quota-strip">
          <div class="quota-visual">
            ${renderQuotaRing(remainingPercent, 112)}
            <div>
              <div class="quota-value">${formatPercent(remainingPercent)}</div>
              <div class="metric-label">${t("primaryQuotaRemaining")}</div>
            </div>
          </div>
          <div class="quota-meta">
            <div>
              <span class="metric-label">${t("plan")}</span>
              <strong>${escapeHtml(latest?.rate_limit?.plan_type ?? t("unknown"))}</strong>
            </div>
            <div>
              <span class="metric-label">${t("reset")}</span>
              <strong>${formatReset(latest?.rate_limit?.resets_at ?? null)}</strong>
            </div>
            <div>
              <span class="metric-label">${t("context")}</span>
              <strong>${formatTokens(latest?.model_context_window ?? 0)}</strong>
            </div>
          </div>
        </section>

        <section class="stats-grid">
          ${metricCard(t("remainingQuota"), formatPercent(remainingPercent), `${t("used")} ${formatPercent(usedPercent)}`)}
          ${metricCard(t("today"), formatTokens(today), t("localDay"))}
          ${metricCard(t("last1h"), formatTokens(oneHour), `${countEvents(dashboard, 60)} ${t("turns")}`)}
          ${metricCard(t("currentRange"), formatTokens(selectedTotal), rangeLabel())}
        </section>

        <section class="chart-section burn-section">
          <div class="section-heading">
            <h2>${t("burnDownChart")}</h2>
            <span>${burnDownMeta}</span>
          </div>
          ${renderUseDayControl()}
          ${renderBurnDownChart(dashboard)}
          <div class="legend burn-legend">
            <span class="legend-item"><i class="legend-line legend-line-actual"></i>${t("actualRemaining")}</span>
            <span class="legend-item"><i class="legend-line legend-line-ideal"></i>${t("idealBurn")}</span>
          </div>
        </section>

        <section class="chart-toolbar">
          <div class="segmented" role="group" aria-label="时间范围">
            ${ranges
              .map(
                (range) => `
                  <button class="${state.rangeMinutes === range.minutes ? "active" : ""}" type="button" data-range="${range.minutes}">
                    ${range.label}
                  </button>
                `,
              )
              .join("")}
          </div>
          <div class="segmented" role="group" aria-label="曲线类型">
            <button class="${state.chartMode === "cumulative" ? "active" : ""}" type="button" data-chart-mode="cumulative">
              ${t("cumulative")}
            </button>
            <button class="${state.chartMode === "realtime" ? "active" : ""}" type="button" data-chart-mode="realtime">
              ${t("realtime")}
            </button>
          </div>
          <div class="range-total">${formatTokens(selectedTotal)} / ${rangeLabel()}</div>
        </section>

        <section class="chart-section">
          <div class="section-heading">
            <h2>${activeChartTitle}</h2>
            <span>${activeChartMeta}</span>
          </div>
          ${activeChart}
        </section>

        <section class="chart-section">
          <div class="section-heading">
            <h2>${t("stacked5Min")}</h2>
            <span>${t("tokenStackLegend")}</span>
          </div>
          ${renderStackedChart(stackedSeries)}
          <div class="legend">
            ${legendItem("fresh", t("freshInput"))}
            ${legendItem("cached", t("cached"))}
            ${legendItem("output", t("output"))}
            ${legendItem("reasoning", t("reasoning"))}
          </div>
        </section>

        <section class="sessions-section">
          <div class="section-heading">
            <h2>${t("recentSession")}</h2>
            <span>${dashboard?.sessions.length ?? 0} ${t("shown")}</span>
          </div>
          ${renderSessions(dashboard)}
        </section>

        <footer class="data-footer">
          <span>${escapeHtml(dashboard?.codex_sessions_path ?? "")}</span>
          <span>${escapeHtml(dashboard?.cache_path ?? "")}</span>
        </footer>
      </main>
    </section>
  `;
}

function bindEvents() {
  const shell = app.querySelector<HTMLElement>(".shell");
  shell?.addEventListener("dblclick", (event) => {
    if (!state.expanded && !isInteractiveTarget(event.target)) {
      void setExpanded(true);
    }
  });
  shell?.addEventListener("contextmenu", (event) => {
    if (isPanelWindow) {
      return;
    }
    event.preventDefault();
    state.contextMenu = menuPosition(event.clientX, event.clientY);
    render();
  });
  shell?.addEventListener("click", (event) => {
    if (state.contextMenu && !(event.target instanceof Element && event.target.closest(".context-menu"))) {
      state.contextMenu = null;
      render();
    }
  });

  app.querySelectorAll<HTMLElement>("[data-drag-window]").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || isInteractiveTarget(event.target)) {
        return;
      }

      const startX = event.clientX;
      const startY = event.clientY;
      let dragging = false;

      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
      };

      const onMove = (moveEvent: PointerEvent) => {
        if (dragging) return;
        const distance = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
        if (distance < 5) return;

        dragging = true;
        cleanup();
        void currentWindow.startDragging().catch(() => {});
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", cleanup, { once: true });
      window.addEventListener("pointercancel", cleanup, { once: true });
    });
  });

  app.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      if (action === "expand") void setExpanded(true);
      if (action === "collapse") void setExpanded(false);
      if (action === "refresh") void refreshUsage();
    });
  });

  app.querySelectorAll<HTMLElement>("[data-mode-toggle]").forEach((button) => {
    const toggleMode = () => {
      state.compactMode = state.compactMode === "tokens" ? "curve" : "tokens";
      render();
    };

    button.addEventListener("click", toggleMode);
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleMode();
      }
    });
  });

  app.querySelectorAll<HTMLButtonElement>("[data-chart-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.chartMode;
      if (mode === "cumulative" || mode === "realtime") {
        state.chartMode = mode;
        render();
      }
    });
  });

  app.querySelectorAll<HTMLSelectElement>("[data-language]").forEach((select) => {
    select.addEventListener("change", () => {
      const value = select.value;
      if (isLanguageChoice(value)) {
        state.language = value;
        localStorage.setItem(languageStorageKey, value);
        render();
      }
    });
  });

  app.querySelectorAll<HTMLSelectElement>("[data-theme]").forEach((select) => {
    select.addEventListener("change", () => {
      const value = select.value;
      if (isThemeChoice(value)) {
        state.theme = value;
        localStorage.setItem(themeStorageKey, value);
        render();
      }
    });
  });

  app.querySelectorAll<HTMLInputElement>("[data-burn-day]").forEach((input) => {
    input.addEventListener("change", () => {
      const day = Number(input.dataset.burnDay);
      if (!isBurnDay(day)) return;

      const nextDays = new Set(state.burnDays);
      if (input.checked) {
        nextDays.add(day);
      } else {
        nextDays.delete(day);
      }

      if (!nextDays.size) {
        input.checked = true;
        return;
      }

      state.burnDays = [...nextDays].sort((left, right) => left - right) as BurnDay[];
      localStorage.setItem(burnDaysStorageKey, JSON.stringify(state.burnDays));
      render();
    });
  });

  app.querySelectorAll<HTMLInputElement>("[data-opacity]").forEach((input) => {
    input.addEventListener("input", () => {
      const value = clamp(Number(input.value) / 100, 0.35, 1);
      setOpacity(value);
      const label = app.querySelector<HTMLElement>("[data-opacity-value]");
      if (label) {
        label.textContent = formatPercent(value * 100);
      }
    });
  });

  app.querySelectorAll<HTMLButtonElement>("[data-range]").forEach((button) => {
    button.addEventListener("click", () => {
      const minutes = Number(button.dataset.range);
      if (Number.isFinite(minutes)) {
        state.rangeMinutes = minutes;
        render();
      }
    });
  });

  app.querySelectorAll<HTMLButtonElement>("[data-opacity-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      const value = Number(button.dataset.opacityChoice);
      if (Number.isFinite(value)) {
        setOpacity(value);
        state.contextMenu = null;
        render();
      }
    });
  });
}

function renderError(dashboard: UsageDashboard | null) {
  const messages = [
    state.error,
    ...(dashboard?.errors ?? []),
  ].filter(Boolean);

  if (!messages.length) {
    return "";
  }

  return `
    <div class="error-bar">
      ${messages.map((message) => `<span>${escapeHtml(String(message))}</span>`).join("")}
    </div>
  `;
}

function renderContextMenu() {
  if (isPanelWindow || !state.contextMenu) {
    return "";
  }

  const choices = [0.4, 0.55, 0.7, 0.82, 1];

  return `
    <div class="context-menu" style="left: ${state.contextMenu.x}px; top: ${state.contextMenu.y}px;" data-no-drag>
      <div class="context-menu-title">${t("opacity")}</div>
      ${choices
        .map(
          (choice) => `
            <button class="${Math.abs(state.opacity - choice) < 0.01 ? "active" : ""}" type="button" data-opacity-choice="${choice}">
              ${formatPercent(choice * 100)}
            </button>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderLanguageSelect() {
  return `
    <label class="language-control" data-no-drag>
      <span>${t("language")}</span>
      <select class="language-select" data-language aria-label="${t("language")}">
        <option value="system" ${state.language === "system" ? "selected" : ""}>${t("systemLanguage")}</option>
        ${locales
          .map(
            (locale) => `
              <option value="${locale.code}" ${state.language === locale.code ? "selected" : ""}>
                ${locale.label}
              </option>
            `,
          )
          .join("")}
      </select>
    </label>
  `;
}

function renderThemeSelect() {
  return `
    <label class="theme-control" data-no-drag>
      <span>${t("theme")}</span>
      <select class="theme-select" data-theme aria-label="${t("theme")}">
        <option value="system" ${state.theme === "system" ? "selected" : ""}>${t("systemLanguage")}</option>
        <option value="dark" ${state.theme === "dark" ? "selected" : ""}>${t("darkTheme")}</option>
        <option value="light" ${state.theme === "light" ? "selected" : ""}>${t("lightTheme")}</option>
      </select>
    </label>
  `;
}

function renderUseDayControl() {
  return `
    <div class="use-day-control" data-no-drag>
      <span>${t("useDay")}</span>
      <div class="weekday-list">
        ${allBurnDays
          .map((day) => {
            const checked = state.burnDays.includes(day);
            return `
              <label class="weekday-toggle ${checked ? "active" : ""}">
                <input type="checkbox" data-burn-day="${day}" ${checked ? "checked" : ""}>
                <span>${escapeHtml(weekdayLabel(day))}</span>
              </label>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function metricCard(label: string, value: string, sub: string) {
  return `
    <article class="metric-card">
      <div class="metric-label">${escapeHtml(label)}</div>
      <strong>${escapeHtml(value)}</strong>
      <span>${escapeHtml(sub)}</span>
    </article>
  `;
}

function renderQuotaRing(percent: number, size = 76) {
  const stroke = size > 80 ? 10 : 7;
  const radius = (size - stroke) / 2;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = clamp(percent, 0, 100);
  const dash = (clamped / 100) * circumference;

  return `
    <svg class="quota-ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Quota remaining ${formatPercent(percent)}">
      <circle class="ring-track" cx="${center}" cy="${center}" r="${radius}" fill="none" stroke-width="${stroke}"></circle>
      <circle class="ring-value" cx="${center}" cy="${center}" r="${radius}" fill="none" stroke-width="${stroke}"
        stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" stroke-linecap="round"
        transform="rotate(-90 ${center} ${center})"></circle>
    </svg>
  `;
}

function renderSparkline(series: SeriesBucket[]) {
  const data = compressSeries(series, 64);
  const width = 250;
  const height = 56;
  const max = Math.max(1, ...data.map((bucket) => bucket.total_tokens));
  const points = data.map((bucket, index) => {
    const x = data.length <= 1 ? 0 : (index / (data.length - 1)) * width;
    const y = height - (bucket.total_tokens / max) * (height - 6) - 3;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  return `
    <svg class="sparkline" viewBox="0 0 ${width} ${height}" role="img" aria-label="Last hour token trend">
      <polyline points="${points.join(" ")}" fill="none" stroke="currentColor" stroke-width="2"></polyline>
    </svg>
  `;
}

function renderCompactCumulativeSparkline(series: CumulativePoint[]) {
  const data = compressCumulativeSeries(series, 48);
  const width = 96;
  const height = 52;
  const max = Math.max(1, ...data.map((point) => point.total_tokens));
  const points = data.map((point, index) => {
    const x = data.length <= 1 ? 0 : (index / (data.length - 1)) * width;
    const y = height - (point.total_tokens / max) * (height - 8) - 4;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  return `
    <svg class="compact-cumulative" viewBox="0 0 ${width} ${height}" role="img" aria-label="Today cumulative token trend">
      <polyline points="${points.join(" ")}" fill="none" stroke="currentColor" stroke-width="2"></polyline>
    </svg>
  `;
}

function renderMiniBars(series: SeriesBucket[]) {
  const data = series.slice(-5);
  const width = 86;
  const height = 46;
  const max = Math.max(1, ...data.map((bucket) => bucket.total_tokens));
  const gap = 4;
  const barWidth = (width - gap * Math.max(0, data.length - 1)) / Math.max(data.length, 1);

  return `
    <svg class="mini-bars" viewBox="0 0 ${width} ${height}" role="img" aria-label="Last 5 minute token usage bars">
      ${data
        .map((bucket, index) => {
          const barHeight = Math.max(2, (bucket.total_tokens / max) * (height - 4));
          const x = index * (barWidth + gap);
          const y = height - barHeight;
          return `
            <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" rx="2">
              <title>${formatShortTime(bucket.ms)} ${formatTokens(bucket.total_tokens)}</title>
            </rect>
          `;
        })
        .join("")}
    </svg>
  `;
}

function renderLineChart(series: SeriesBucket[]) {
  const data = compressSeries(series, 220);
  const width = 760;
  const height = 236;
  const margin = { top: 16, right: 20, bottom: 34, left: 64 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const max = Math.max(1, ...data.map((bucket) => bucket.total_tokens));
  const points = data.map((bucket, index) => {
    const x = margin.left + (data.length <= 1 ? 0 : (index / (data.length - 1)) * innerWidth);
    const y = margin.top + innerHeight - (bucket.total_tokens / max) * innerHeight;
    return { x, y, bucket };
  });
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");
  const ticks = yTicks(max, 4);
  const xTicks = xAxisTicks(data, 5);

  return `
    <svg class="chart line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Token usage line chart">
      <g class="grid">
        ${ticks
          .map((tick) => {
            const y = margin.top + innerHeight - (tick / max) * innerHeight;
            return `<line x1="${margin.left}" y1="${y.toFixed(2)}" x2="${width - margin.right}" y2="${y.toFixed(2)}"></line>
              <text x="${margin.left - 10}" y="${(y + 4).toFixed(2)}" text-anchor="end">${formatAxisNumber(tick)}</text>`;
          })
          .join("")}
      </g>
      <path class="line-path" d="${path}"></path>
      ${points
        .filter((_, index) => index === points.length - 1 || data.length < 40)
        .map(
          (point) => `
            <circle class="line-dot" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="3">
              <title>${formatShortTime(point.bucket.ms)} ${formatTokens(point.bucket.total_tokens)}</title>
            </circle>
          `,
        )
        .join("")}
      <g class="axis">
        <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}"></line>
        ${xTicks
          .map(
            ({ x, label }) => `
              <text x="${x.toFixed(2)}" y="${height - 12}" text-anchor="middle">${escapeHtml(label)}</text>
            `,
          )
          .join("")}
      </g>
    </svg>
  `;
}

function renderCumulativeChart(series: CumulativePoint[]) {
  const data = compressCumulativeSeries(series, 220);
  const width = 760;
  const height = 236;
  const margin = { top: 16, right: 20, bottom: 34, left: 64 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const max = Math.max(1, ...data.map((point) => point.total_tokens));
  const points = data.map((point, index) => {
    const x = margin.left + (data.length <= 1 ? 0 : (index / (data.length - 1)) * innerWidth);
    const y = margin.top + innerHeight - (point.total_tokens / max) * innerHeight;
    return { x, y, point };
  });
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");
  const ticks = yTicks(max, 4);
  const xTicks = xAxisTicks(data, 5, formatClockTime);

  return `
    <svg class="chart line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Today cumulative token usage line chart">
      <g class="grid">
        ${ticks
          .map((tick) => {
            const y = margin.top + innerHeight - (tick / max) * innerHeight;
            return `<line x1="${margin.left}" y1="${y.toFixed(2)}" x2="${width - margin.right}" y2="${y.toFixed(2)}"></line>
              <text x="${margin.left - 10}" y="${(y + 4).toFixed(2)}" text-anchor="end">${formatAxisNumber(tick)}</text>`;
          })
          .join("")}
      </g>
      <path class="line-path" d="${path}"></path>
      ${points
        .filter((_, index) => index === points.length - 1 || data.length < 40)
        .map(
          (point) => `
            <circle class="line-dot" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="3">
              <title>${formatClockTime(point.point.ms)} ${formatTokens(point.point.total_tokens)}</title>
            </circle>
          `,
        )
        .join("")}
      <g class="axis">
        <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}"></line>
        ${xTicks
          .map(
            ({ x, label }) => `
              <text x="${x.toFixed(2)}" y="${height - 12}" text-anchor="middle">${escapeHtml(label)}</text>
            `,
          )
          .join("")}
      </g>
    </svg>
  `;
}

function renderBurnDownChart(dashboard: UsageDashboard | null) {
  const windowRange = burnDownWindow(dashboard);
  if (!windowRange) {
    return `<div class="empty-state">${t("noRateLimitData")}</div>`;
  }

  const data = compressBurnDownSeries(burnDownSeries(dashboard, windowRange), 220);
  if (!data.length) {
    return `<div class="empty-state">${t("noRateLimitData")}</div>`;
  }

  const width = 760;
  const height = 236;
  const margin = { top: 16, right: 20, bottom: 34, left: 64 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const spanMs = Math.max(1, windowRange.endMs - windowRange.startMs);
  const xFor = (ms: number) => margin.left + clamp((ms - windowRange.startMs) / spanMs, 0, 1) * innerWidth;
  const yFor = (remaining: number) => margin.top + ((100 - clamp(remaining, 0, 100)) / 100) * innerHeight;
  const actualPath = data
    .map((point, index) => `${index === 0 ? "M" : "L"} ${xFor(point.ms).toFixed(2)} ${yFor(point.remaining_percent).toFixed(2)}`)
    .join(" ");
  const idealPath = idealBurnDownSeries(windowRange)
    .map((point, index) => `${index === 0 ? "M" : "L"} ${xFor(point.ms).toFixed(2)} ${yFor(point.remaining_percent).toFixed(2)}`)
    .join(" ");
  const yTicks = [100, 75, 50, 25, 0];
  const xTicks = [
    { ms: windowRange.startMs, label: formatDateTimeTick(windowRange.startMs), anchor: "start" },
    { ms: windowRange.nowMs, label: t("now"), anchor: "middle" },
    { ms: windowRange.endMs, label: t("reset"), anchor: "end" },
  ];

  return `
    <svg class="chart burn-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${t("burnDownChart")}">
      <g class="grid">
        ${yTicks
          .map((tick) => {
            const y = yFor(tick);
            return `<line x1="${margin.left}" y1="${y.toFixed(2)}" x2="${width - margin.right}" y2="${y.toFixed(2)}"></line>
              <text x="${margin.left - 10}" y="${(y + 4).toFixed(2)}" text-anchor="end">${tick}%</text>`;
          })
          .join("")}
      </g>
      <path class="burn-ideal" d="${idealPath}"></path>
      <path class="burn-actual" d="${actualPath}"></path>
      <line class="burn-now-line" x1="${xFor(windowRange.nowMs).toFixed(2)}" y1="${margin.top}" x2="${xFor(windowRange.nowMs).toFixed(2)}" y2="${(height - margin.bottom).toFixed(2)}"></line>
      ${data
        .filter((_, index) => index === data.length - 1 || data.length < 40)
        .map(
          (point) => `
            <circle class="burn-dot" cx="${xFor(point.ms).toFixed(2)}" cy="${yFor(point.remaining_percent).toFixed(2)}" r="3">
              <title>${formatDateTimeTick(point.ms)} ${formatPercent(point.remaining_percent)}</title>
            </circle>
          `,
        )
        .join("")}
      <g class="axis">
        <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}"></line>
        ${xTicks
          .map(
            ({ ms, label, anchor }) => `
              <text x="${xFor(ms).toFixed(2)}" y="${height - 12}" text-anchor="${anchor}">${escapeHtml(label)}</text>
            `,
          )
          .join("")}
      </g>
    </svg>
  `;
}

function renderStackedChart(series: SeriesBucket[]) {
  const data = compressSeries(series, 132);
  const width = 760;
  const height = 260;
  const margin = { top: 16, right: 20, bottom: 36, left: 64 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const max = Math.max(1, ...data.map((bucket) => bucket.total_tokens));
  const gap = 2;
  const barWidth = Math.max(2, innerWidth / Math.max(data.length, 1) - gap);
  const ticks = yTicks(max, 4);
  const xTicks = xAxisTicks(data, 5);

  return `
    <svg class="chart stacked-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Token usage stacked chart">
      <g class="grid">
        ${ticks
          .map((tick) => {
            const y = margin.top + innerHeight - (tick / max) * innerHeight;
            return `<line x1="${margin.left}" y1="${y.toFixed(2)}" x2="${width - margin.right}" y2="${y.toFixed(2)}"></line>
              <text x="${margin.left - 10}" y="${(y + 4).toFixed(2)}" text-anchor="end">${formatAxisNumber(tick)}</text>`;
          })
          .join("")}
      </g>
      <g class="bars">
        ${data
          .map((bucket, index) => {
            const x = margin.left + index * (innerWidth / Math.max(data.length, 1));
            let y = margin.top + innerHeight;
            const segments = [
              ["fresh", bucket.fresh_input_tokens],
              ["cached", bucket.cached_input_tokens],
              ["output", bucket.visible_output_tokens],
              ["reasoning", bucket.reasoning_output_tokens],
            ] as const;

            return segments
              .map(([name, value]) => {
                const segmentHeight = (value / max) * innerHeight;
                y -= segmentHeight;
                if (segmentHeight <= 0) return "";
                return `
                  <rect class="segment-${name}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${segmentHeight.toFixed(2)}">
                    <title>${formatShortTime(bucket.ms)} ${name}: ${formatTokens(value)}</title>
                  </rect>
                `;
              })
              .join("");
          })
          .join("")}
      </g>
      <g class="axis">
        <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}"></line>
        ${xTicks
          .map(
            ({ x, label }) => `
              <text x="${x.toFixed(2)}" y="${height - 12}" text-anchor="middle">${escapeHtml(label)}</text>
            `,
          )
          .join("")}
      </g>
    </svg>
  `;
}

function renderSessions(dashboard: UsageDashboard | null) {
  const sessions = dashboard?.sessions ?? [];
  if (!sessions.length) {
    return `<div class="empty-state">${t("noEvents")}</div>`;
  }

  return `
    <div class="session-list">
      ${sessions
        .map(
          (session) => `
            <div class="session-row">
              <span class="session-id">${escapeHtml(shortSessionId(session.id))}</span>
              <span>${formatTokens(session.total_tokens)}</span>
              <span>${session.events} ${t("turns")}</span>
              <span>${formatRelativeTime(session.last_seen)}</span>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function legendItem(name: string, label: string) {
  return `<span class="legend-item"><i class="legend-swatch segment-${escapeHtml(name)}"></i>${escapeHtml(label)}</span>`;
}

function normalizedSeries(dashboard: UsageDashboard, rangeMinutes: number): SeriesBucket[] {
  const map = new Map<number, MinuteBucket>();
  for (const bucket of dashboard.buckets) {
    const ms = parseMinute(bucket.minute);
    if (Number.isFinite(ms)) {
      map.set(ms, bucket);
    }
  }

  const end = Math.floor((dashboard.scanned_at_ms || Date.now()) / 60000) * 60000;
  const start = end - (rangeMinutes - 1) * 60000;
  const series: SeriesBucket[] = [];

  for (let ms = start; ms <= end; ms += 60000) {
    const bucket = map.get(ms);
    const counts = bucket ?? {
      minute: new Date(ms).toISOString().slice(0, 16) + ":00Z",
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
      events: 0,
    };
    series.push(enrichBucket(counts, ms));
  }

  return series;
}

function bucketedSeries(dashboard: UsageDashboard, rangeMinutes: number, bucketMinutes: number): SeriesBucket[] {
  const interval = bucketMinutes * 60000;
  const bucketsBySlot = new Map<number, MinuteBucket>();

  for (const bucket of dashboard.buckets) {
    const ms = parseMinute(bucket.minute);
    if (!Number.isFinite(ms)) continue;
    const slot = Math.floor(ms / interval) * interval;
    const aggregate = bucketsBySlot.get(slot) ?? {
      minute: new Date(slot).toISOString().slice(0, 16) + ":00Z",
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
      events: 0,
    };

    aggregate.input_tokens += bucket.input_tokens;
    aggregate.cached_input_tokens += bucket.cached_input_tokens;
    aggregate.output_tokens += bucket.output_tokens;
    aggregate.reasoning_output_tokens += bucket.reasoning_output_tokens;
    aggregate.total_tokens += bucket.total_tokens;
    aggregate.events += bucket.events;
    bucketsBySlot.set(slot, aggregate);
  }

  const endMinute = Math.floor((dashboard.scanned_at_ms || Date.now()) / 60000) * 60000;
  const end = Math.floor(endMinute / interval) * interval;
  const pointCount = Math.max(1, Math.ceil(rangeMinutes / bucketMinutes));
  const start = end - (pointCount - 1) * interval;
  const series: SeriesBucket[] = [];

  for (let ms = start; ms <= end; ms += interval) {
    const bucket = bucketsBySlot.get(ms) ?? {
      minute: new Date(ms).toISOString().slice(0, 16) + ":00Z",
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
      events: 0,
    };
    series.push(enrichBucket(bucket, ms));
  }

  return series;
}

function todayCumulativeSeries(dashboard: UsageDashboard): CumulativePoint[] {
  const interval = 5 * 60000;
  const scanMs = dashboard.scanned_at_ms || Date.now();
  const startDate = new Date(scanMs);
  startDate.setHours(0, 0, 0, 0);
  const startMs = startDate.getTime();
  const endMs = Math.floor(scanMs / interval) * interval;
  const increments = new Map<number, number>();

  for (const bucket of dashboard.buckets) {
    const ms = parseMinute(bucket.minute);
    if (!Number.isFinite(ms) || ms < startMs || ms > scanMs) continue;
    const slot = Math.floor(ms / interval) * interval;
    increments.set(slot, (increments.get(slot) ?? 0) + bucket.total_tokens);
  }

  const series: CumulativePoint[] = [];
  let total = 0;

  for (let ms = startMs; ms <= endMs; ms += interval) {
    total += increments.get(ms) ?? 0;
    series.push({
      ms,
      minute: new Date(ms).toISOString().slice(0, 16) + ":00Z",
      total_tokens: total,
    });
  }

  return series;
}

function burnDownWindow(dashboard: UsageDashboard | null) {
  const rateLimit = dashboard?.latest?.rate_limit ?? null;
  const resetsAt = rateLimit?.resets_at ?? null;
  const windowMinutes = rateLimit?.window_minutes ?? null;
  if (!resetsAt || !windowMinutes) return null;

  const endMs = resetsAt * 1000;
  const startMs = endMs - windowMinutes * 60000;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;

  const scanMs = dashboard?.scanned_at_ms || Date.now();
  return {
    startMs,
    endMs,
    nowMs: clamp(scanMs, startMs, endMs),
  };
}

function burnDownSeries(
  dashboard: UsageDashboard | null,
  windowRange: { startMs: number; endMs: number; nowMs: number },
): BurnDownPoint[] {
  const points = new Map<number, number>();
  const resetAt = dashboard?.latest?.rate_limit?.resets_at ?? null;

  for (const point of dashboard?.rate_limit_points ?? []) {
    const ms = parseMinute(point.minute);
    if (!Number.isFinite(ms) || ms < windowRange.startMs || ms > windowRange.endMs) continue;
    if (resetAt && point.resets_at && point.resets_at !== resetAt) continue;
    points.set(ms, remainingPercentFromRateLimitPoint(point));
  }

  if (dashboard?.latest?.rate_limit?.used_percent !== undefined) {
    points.set(windowRange.nowMs, quotaRemainingPercent(dashboard));
  }

  return [...points.entries()]
    .sort(([left], [right]) => left - right)
    .map(([ms, remainingPercent]) => ({
      ms,
      remaining_percent: remainingPercent,
    }));
}

function idealBurnDownSeries(windowRange: { startMs: number; endMs: number }): BurnDownPoint[] {
  const totalActiveMs = activeDurationBetween(windowRange.startMs, windowRange.endMs);
  const spanMs = Math.max(1, windowRange.endMs - windowRange.startMs);
  const interval = Math.max(15 * 60000, Math.floor(spanMs / 240));
  const points: BurnDownPoint[] = [];

  for (let ms = windowRange.startMs; ms <= windowRange.endMs; ms += interval) {
    points.push({
      ms,
      remaining_percent: idealRemainingAt(ms, windowRange, totalActiveMs),
    });
  }

  if (!points.length || points[points.length - 1].ms !== windowRange.endMs) {
    points.push({
      ms: windowRange.endMs,
      remaining_percent: idealRemainingAt(windowRange.endMs, windowRange, totalActiveMs),
    });
  }

  return points;
}

function idealRemainingAt(
  ms: number,
  windowRange: { startMs: number; endMs: number },
  totalActiveMs: number,
) {
  if (totalActiveMs <= 0) {
    const spanMs = Math.max(1, windowRange.endMs - windowRange.startMs);
    return 100 - (clamp(ms, windowRange.startMs, windowRange.endMs) - windowRange.startMs) / spanMs * 100;
  }

  const activeElapsedMs = activeDurationBetween(windowRange.startMs, clamp(ms, windowRange.startMs, windowRange.endMs));
  return 100 - (activeElapsedMs / totalActiveMs) * 100;
}

function activeDurationBetween(startMs: number, endMs: number) {
  if (endMs <= startMs) return 0;
  const useDays = new Set(state.burnDays);
  let cursor = startMs;
  let total = 0;

  while (cursor < endMs) {
    const segmentEnd = Math.min(endMs, nextLocalDayStart(cursor));
    if (useDays.has(new Date(cursor).getDay() as BurnDay)) {
      total += segmentEnd - cursor;
    }
    cursor = segmentEnd;
  }

  return total;
}

function nextLocalDayStart(ms: number) {
  const date = new Date(ms);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

function remainingPercentFromRateLimitPoint(point: RateLimitPoint) {
  const remaining =
    typeof point.remaining_percent === "number" && Number.isFinite(point.remaining_percent)
      ? point.remaining_percent
      : 100 - (point.used_percent ?? 0);
  return Math.floor(clamp(remaining, 0, 100));
}

function compressSeries(series: SeriesBucket[], maxPoints: number): SeriesBucket[] {
  if (series.length <= maxPoints) {
    return series;
  }

  const groupSize = Math.ceil(series.length / maxPoints);
  const compressed: SeriesBucket[] = [];

  for (let index = 0; index < series.length; index += groupSize) {
    const group = series.slice(index, index + groupSize);
    const first = group[0];
    const aggregate: MinuteBucket = {
      minute: first.minute,
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
      events: 0,
    };

    for (const bucket of group) {
      aggregate.input_tokens += bucket.input_tokens;
      aggregate.cached_input_tokens += bucket.cached_input_tokens;
      aggregate.output_tokens += bucket.output_tokens;
      aggregate.reasoning_output_tokens += bucket.reasoning_output_tokens;
      aggregate.total_tokens += bucket.total_tokens;
      aggregate.events += bucket.events;
    }

    compressed.push(enrichBucket(aggregate, first.ms));
  }

  return compressed;
}

function compressCumulativeSeries(series: CumulativePoint[], maxPoints: number): CumulativePoint[] {
  if (series.length <= maxPoints) {
    return series;
  }

  const groupSize = Math.ceil(series.length / maxPoints);
  const compressed: CumulativePoint[] = [];

  for (let index = 0; index < series.length; index += groupSize) {
    const group = series.slice(index, index + groupSize);
    compressed.push(group[group.length - 1]);
  }

  return compressed;
}

function compressBurnDownSeries(series: BurnDownPoint[], maxPoints: number): BurnDownPoint[] {
  if (series.length <= maxPoints) {
    return series;
  }

  const groupSize = Math.ceil(series.length / maxPoints);
  const compressed: BurnDownPoint[] = [];

  for (let index = 0; index < series.length; index += groupSize) {
    const group = series.slice(index, index + groupSize);
    compressed.push(group[group.length - 1]);
  }

  return compressed;
}

function enrichBucket(bucket: MinuteBucket, ms: number): SeriesBucket {
  const cached = Math.min(bucket.cached_input_tokens, bucket.input_tokens);
  const reasoning = Math.min(bucket.reasoning_output_tokens, bucket.output_tokens);

  return {
    ...bucket,
    ms,
    fresh_input_tokens: Math.max(0, bucket.input_tokens - cached),
    visible_output_tokens: Math.max(0, bucket.output_tokens - reasoning),
  };
}

function quotaUsedPercent(dashboard: UsageDashboard | null) {
  return dashboard?.latest?.rate_limit?.used_percent ?? 0;
}

function quotaRemainingPercent(dashboard: UsageDashboard | null) {
  return Math.floor(clamp(100 - quotaUsedPercent(dashboard), 0, 100));
}

function sumToday(dashboard: UsageDashboard | null) {
  if (!dashboard) return 0;
  const now = new Date(dashboard.scanned_at_ms || Date.now());
  return dashboard.buckets.reduce((total, bucket) => {
    const date = new Date(parseMinute(bucket.minute));
    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    return sameDay ? total + bucket.total_tokens : total;
  }, 0);
}

function sumLastMinutes(dashboard: UsageDashboard | null, minutes: number) {
  if (!dashboard) return 0;
  const cutoff = (dashboard.scanned_at_ms || Date.now()) - minutes * 60000;
  return dashboard.buckets.reduce((total, bucket) => {
    const ms = parseMinute(bucket.minute);
    return ms >= cutoff ? total + bucket.total_tokens : total;
  }, 0);
}

function countEvents(dashboard: UsageDashboard | null, minutes: number) {
  if (!dashboard) return 0;
  const cutoff = (dashboard.scanned_at_ms || Date.now()) - minutes * 60000;
  return dashboard.buckets.reduce((total, bucket) => {
    const ms = parseMinute(bucket.minute);
    return ms >= cutoff ? total + bucket.events : total;
  }, 0);
}

function maxTotal(series: SeriesBucket[]) {
  return Math.max(0, ...series.map((bucket) => bucket.total_tokens));
}

function parseMinute(minute: string) {
  return new Date(minute).getTime();
}

function yTicks(max: number, count: number) {
  const ticks: number[] = [];
  for (let index = 0; index <= count; index += 1) {
    ticks.push(Math.round((max / count) * index));
  }
  return ticks;
}

function xAxisTicks(
  data: Array<SeriesBucket | CumulativePoint>,
  count: number,
  labelFormatter: (ms: number) => string = formatShortTime,
) {
  if (!data.length) return [];
  const ticks: { x: number; label: string }[] = [];
  const width = 760;
  const margin = { left: 64, right: 20 };
  const innerWidth = width - margin.left - margin.right;

  for (let index = 0; index < count; index += 1) {
    const dataIndex = Math.round((index / (count - 1)) * (data.length - 1));
    const x = margin.left + (data.length <= 1 ? 0 : (dataIndex / (data.length - 1)) * innerWidth);
    ticks.push({ x, label: labelFormatter(data[dataIndex].ms) });
  }

  return ticks;
}

function rangeLabel() {
  return ranges.find((range) => range.minutes === state.rangeMinutes)?.label ?? `${state.rangeMinutes}m`;
}

function formatTokens(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return Math.round(value).toLocaleString();
}

function formatAxisNumber(value: number) {
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "0%";
  return `${clamp(value, 0, 999).toFixed(value < 10 ? 1 : 0)}%`;
}

function formatReset(value: number | null) {
  if (!value) return t("unknown");
  const diffMs = value * 1000 - Date.now();
  if (diffMs <= 0) return t("now");
  const minutes = Math.ceil(diffMs / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h ${minutes % 60}m`;
}

function formatBurnDownWindow(dashboard: UsageDashboard | null) {
  const windowRange = burnDownWindow(dashboard);
  if (!windowRange) return t("unknown");
  return `${t("resetWindow")} ${formatDateTimeTick(windowRange.startMs)} - ${formatDateTimeTick(windowRange.endMs)}`;
}

function formatDateTimeTick(ms: number) {
  const date = new Date(ms);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

function formatShortTime(ms: number) {
  const date = new Date(ms);
  if (state.rangeMinutes >= 1440) {
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatClockTime(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatRelativeTime(value?: string | null) {
  if (!value) return t("unknown");
  const diff = Date.now() - new Date(value).getTime();
  if (diff < 60000) return t("now");
  if (diff < 3600000) return `${Math.floor(diff / 60000)} ${t("minutesAgo")}`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} ${t("hoursAgo")}`;
  return `${Math.floor(diff / 86400000)} ${t("daysAgo")}`;
}

function formatScannedAt(dashboard: UsageDashboard | null) {
  if (!dashboard) return "no data";
  return new Date(dashboard.scanned_at_ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortSessionId(id: string) {
  return id.length > 12 ? id.slice(0, 8) : id;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isInteractiveTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("button, a, input, select, textarea, [data-no-drag]"));
}

function t(key: TranslationKey) {
  const locale = activeLocale();
  return translations[locale][key] ?? translations.en[key];
}

function activeLocale(): Locale {
  return state.language === "system" ? systemLocale() : state.language;
}

function activeTheme(): Theme {
  if (state.theme !== "system") return state.theme;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function systemLocale(): Locale {
  const candidates = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const candidate of candidates) {
    const normalized = normalizeLocale(candidate);
    if (normalized) return normalized;
  }
  return "en";
}

function normalizeLocale(value: string | undefined): Locale | null {
  if (!value) return null;
  const locale = value.toLowerCase();
  if (locale.startsWith("zh")) {
    return locale.includes("tw") || locale.includes("hk") || locale.includes("mo") ? "zh-TW" : "zh-CN";
  }
  if (locale.startsWith("pt")) return "pt-BR";
  const language = locale.split("-")[0];
  const match = locales.find((item) => item.code.toLowerCase() === language);
  return match?.code ?? null;
}

function readLanguage(): LanguageChoice {
  const raw = localStorage.getItem(languageStorageKey);
  return isLanguageChoice(raw) ? raw : "system";
}

function isLanguageChoice(value: unknown): value is LanguageChoice {
  return value === "system" || locales.some((locale) => locale.code === value);
}

function readTheme(): ThemeChoice {
  const raw = localStorage.getItem(themeStorageKey);
  return isThemeChoice(raw) ? raw : "system";
}

function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "system" || value === "dark" || value === "light";
}

function readBurnDays(): BurnDay[] {
  const raw = localStorage.getItem(burnDaysStorageKey);
  if (!raw) return [...allBurnDays];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...allBurnDays];
    const uniqueDays = [...new Set(parsed.filter(isBurnDay))].sort((left, right) => left - right) as BurnDay[];
    return uniqueDays.length ? uniqueDays : [...allBurnDays];
  } catch {
    return [...allBurnDays];
  }
}

function isBurnDay(value: unknown): value is BurnDay {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 6;
}

function weekdayLabel(day: BurnDay) {
  const baseDate = new Date(2026, 6, 12 + day);
  return new Intl.DateTimeFormat(activeLocale(), { weekday: "short" }).format(baseDate);
}

function menuPosition(x: number, y: number) {
  return {
    x: clamp(x, 8, Math.max(8, window.innerWidth - 144)),
    y: clamp(y, 8, Math.max(8, window.innerHeight - 132)),
  };
}

function setOpacity(value: number) {
  if (isPanelWindow) {
    applyOpacity();
    return;
  }
  state.opacity = clamp(value, 0.35, 1);
  localStorage.setItem(opacityStorageKey, String(state.opacity));
  applyOpacity();
}

function readOpacity() {
  const raw = localStorage.getItem(opacityStorageKey);
  const value = raw ? Number(raw) : 0.82;
  return clamp(Number.isFinite(value) ? value : 0.82, 0.35, 1);
}

function applyOpacity() {
  const alpha = isPanelWindow ? "1.00" : state.opacity.toFixed(2);
  app.style.opacity = alpha;
  app.style.setProperty("--panel-alpha", "1.00");
  document.documentElement.style.setProperty("--panel-alpha", "1.00");
}

async function listenForOpacityChanges() {
  await listen<number>("opacity-change", (event) => {
    const value = Number(event.payload);
    if (Number.isFinite(value) && !isPanelWindow) {
      setOpacity(value);
      render();
    }
  });
}

void listenForOpacityChanges();
void refreshUsage();
window.setInterval(() => void refreshUsage(), 30_000);
