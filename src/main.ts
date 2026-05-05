import { EMOJI_BY_ID, TABLER_CODEPOINT_BY_ID } from "./generated/icon-data";

type DisplayMode = "Text" | "Icon + Text" | "Icon";

const logseq = (window as unknown as { logseq: any }).logseq;

type PluginSettings = {
  displayMode?: DisplayMode;
};

type EntityRef =
  | number
  | string
  | {
      id?: number;
      ":db/id"?: number;
      "db/id"?: number;
      dbId?: number;
      value?: number | string;
      uuid?: string;
      ":block/uuid"?: string;
      "block/uuid"?: string;
      name?: string;
      originalName?: string;
    };

type PageEntity = {
  id?: number;
  ":db/id"?: number;
  "db/id"?: number;
  uuid?: string;
  ":block/uuid"?: string;
  "block/uuid"?: string;
  name?: string;
  originalName?: string;
  title?: unknown;
  ":block/title"?: unknown;
  "block/title"?: unknown;
  ":block/journal-day"?: unknown;
  "block/journal-day"?: unknown;
  journalDay?: unknown;
  parent?: EntityRef;
  namespace?: EntityRef;
  refs?: EntityRef[];
  ":block/refs"?: EntityRef[];
  "block/refs"?: EntityRef[];
  properties?: Record<string, unknown>;
  icon?: unknown;
  [key: string]: unknown;
};

type PageView = {
  display: string;
  title: string;
  parentTitle: string;
  childTitle: string;
  pageId?: number;
  pageUuid?: string;
  parentId?: number;
  parentUuid?: string;
  renderText: string;
  renderSuffix?: string;
  renderFontFamily?: string;
};

type HostMarkerPayload = {
  version: number;
  views: PageView[];
};

type OffHook = (() => void) | { off?: () => void } | undefined;

type ResolvedIcon =
  | { kind: "emoji"; value: string }
  | { kind: "tabler"; value: string };

const CURRENT_PAGE_BLOCKS_QUERY = `
[:find (pull ?b [* {:block/refs [* {:block/parent [*]}]}])
 :in $ ?page
 :where [?b :block/page ?page]]
`;
const RECENT_JOURNAL_BLOCKS_QUERY = `
[:find (pull ?b [* {:block/refs [* {:block/parent [*]}]}])
 :in $ ?min-day ?max-day
 :where
 [?page :block/journal-day ?day]
 [(>= ?day ?min-day)]
 [(<= ?day ?max-day)]
 [?b :block/page ?page]
 [?b :block/refs ?ref]]
`;
const BLOCK_BY_ID_QUERY = `
[:find (pull ?b [* {:block/refs [* {:block/parent [*]}]}]) .
 :in $ ?b]
`;
const ENTITY_BY_ID_QUERY = `
[:find (pull ?e [* {:block/parent [*]}]) .
 :in $ ?e]
`;
const ENTITY_BY_UUID_QUERY = `
[:find (pull ?e [* {:block/parent [*]}]) .
 :in $ ?uuid
 :where [?e :block/uuid ?uuid]]
`;

let refreshVersion = 0;
let refreshTimer: number | undefined;
let refreshRunning = false;
let refreshQueued = false;
let offDbChanged: OffHook;
let offRouteChanged: OffHook;
let offSettingsChanged: OffHook;
let emptyRefreshRetries = 0;
let startupRefreshTimers: number[] = [];
let hostMarkerScriptLoad: Promise<void> | undefined;
let lastHostMarkerSignature = "";
const PAGE_SEPARATOR = " / ";
const HOST_MARKER_KEY = "logseq-library-display-payload";
const HOST_MARKER_STYLE = `
.library-display-rendered-reference-icon{font-family:tabler-icons!important;}
`;

function hostDocument(): Document {
  try {
    const hostScope = logseq.Experiments?.ensureHostScope?.();
    return hostScope?.document ?? window.top?.document ?? window.parent?.document ?? document;
  } catch {
    return document;
  }
}

function encodePayload(payload: HostMarkerPayload): string {
  return window.btoa(encodeURIComponent(JSON.stringify(payload)));
}

function addHostMarkerView(views: Map<string, PageView>, view: PageView): void {
  const key =
    view.pageUuid ??
    (typeof view.pageId === "number" ? `id:${view.pageId}` : view.title);

  if (!views.has(key)) {
    views.set(key, view);
  }
}

async function loadHostMarkerScript(): Promise<void> {
  if (!hostMarkerScriptLoad) {
    hostMarkerScriptLoad = (async () => {
      const callApi = logseq._execCallableAPIAsync;
      const pluginId = logseq.baseInfo?.id ?? "logseq-library-display";
      const resolvedScriptUrl = logseq.resolveResourceFullUrl?.("dist/host-marker.js");
      const scriptUrl = resolvedScriptUrl
        ? `${resolvedScriptUrl}${resolvedScriptUrl.includes("?") ? "&" : "?"}v=${encodeURIComponent(
            String(refreshVersion),
          )}`
        : undefined;

      if (typeof callApi !== "function" || !scriptUrl) {
        return;
      }

      await callApi.call(logseq, "exper_load_scripts", pluginId, scriptUrl);
    })().catch((error: unknown) => {
      hostMarkerScriptLoad = undefined;
      console.warn("[logseq-library-display] failed to load host marker", error);
    });
  }

  await hostMarkerScriptLoad;
}

function publishHostMarkerPayload(views: PageView[]): void {
  const signature = JSON.stringify(views);
  if (signature === lastHostMarkerSignature) return;

  lastHostMarkerSignature = signature;
  const payload = encodePayload({
    version: refreshVersion,
    views,
  });

  void loadHostMarkerScript().then(() => {
    logseq.provideUI({
      key: HOST_MARKER_KEY,
      path: "body",
      template: `<div id="${HOST_MARKER_KEY}" style="display:none!important" data-version="${refreshVersion}">${payload}</div>`,
    });
  });
}

function settings(): Required<PluginSettings> {
  const value = (logseq.settings ?? {}) as PluginSettings;
  return {
    displayMode: value.displayMode ?? "Text",
  };
}

function lastPathSegment(value: string): string {
  const parts = value.split("/");
  return parts[parts.length - 1]?.trim() || value.trim();
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join("").trim() || undefined;

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return textValue(
      record.value ??
        record.content ??
        record.text ??
        record.title ??
        record.name ??
        record.originalName,
    );
  }

  return undefined;
}

function dbId(entity: unknown): number | undefined {
  if (!entity || typeof entity !== "object") return undefined;
  const record = entity as Record<string, unknown>;
  return entityId(record.id ?? record[":db/id"] ?? record["db/id"] ?? record.dbId);
}

function journalDay(page: PageEntity | undefined): number | undefined {
  const value =
    page?.[":block/journal-day"] ??
    page?.["block/journal-day"] ??
    page?.journalDay;

  return typeof value === "number" ? value : undefined;
}

function dateFromJournalDay(day: number): Date {
  const value = String(day).padStart(8, "0");
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const date = Number(value.slice(6, 8));

  return new Date(year, month - 1, date);
}

function journalDayFromDate(date: Date): number {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return Number(`${year}${month}${day}`);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function entityUuidValue(entity: unknown): string | undefined {
  if (!entity || typeof entity !== "object") return undefined;
  const record = entity as Record<string, unknown>;
  return entityUuid(record.uuid ?? record[":block/uuid"] ?? record["block/uuid"]);
}

function pageTitle(page: PageEntity): string {
  return lastPathSegment(
    textValue(
      page[":block/title"] ??
        page["block/title"] ??
        page.title ??
        page.originalName ??
        page.name ??
        page[":block/name"] ??
        page["block/name"],
    ) ?? "",
  );
}

function normalizeIconType(value: string | undefined): string | undefined {
  return value?.replace(/^:/, "").trim();
}

function kebabIconId(value: string): string {
  return value
    .trim()
    .replace(/^Icon/, "")
    .replace(/_/g, "-")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLocaleLowerCase();
}

function resolveEmojiIcon(id: string | undefined): ResolvedIcon | undefined {
  if (!id) return undefined;

  const value = EMOJI_BY_ID[id] ?? EMOJI_BY_ID[id.replace(/-/g, "_")];
  return value ? { kind: "emoji", value } : undefined;
}

function resolveTablerIcon(id: string | undefined): ResolvedIcon | undefined {
  if (!id) return undefined;

  const candidates = new Set([id.trim(), kebabIconId(id)]);
  for (const candidate of candidates) {
    const value = TABLER_CODEPOINT_BY_ID[candidate];
    if (value) return { kind: "tabler", value };
  }

  return undefined;
}

function resolveIcon(value: unknown): ResolvedIcon | undefined {
  if (typeof value === "string" && value.trim()) {
    const id = value.trim();
    return resolveEmojiIcon(id) ?? resolveTablerIcon(id) ?? { kind: "emoji", value: id };
  }

  if (Array.isArray(value)) return value.map(resolveIcon).find(Boolean);

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const id = textValue(record.id);
    const type = normalizeIconType(textValue(record.type));

    if (type === "emoji") {
      return (
        resolveEmojiIcon(id) ??
        resolveIcon(record.native ?? record.emoji ?? record.value ?? record.content ?? record.text)
      );
    }

    if (type === "tabler-icon" || type === "tabler" || type === "icon") {
      return (
        resolveTablerIcon(id) ??
        resolveIcon(record.native ?? record.emoji ?? record.value ?? record.content ?? record.text)
      );
    }

    return resolveIcon(record.native ?? record.emoji ?? record.value ?? record.content ?? record.text ?? record.icon);
  }

  return undefined;
}

function entityId(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(entityId).find((item) => typeof item === "number");

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return entityId(record.id ?? record[":db/id"] ?? record["db/id"] ?? record.dbId ?? record.value);
  }

  return undefined;
}

function entityUuid(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) return value.map(entityUuid).find(Boolean);

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return entityUuid(
      record.uuid ??
        record[":block/uuid"] ??
        record["block/uuid"] ??
        record.name ??
        record.originalName ??
        record.value,
    );
  }

  return undefined;
}

function parentRef(page: PageEntity): unknown {
  return (
    page[":block/parent"] ??
    page["block/parent"] ??
    page.parent ??
    page.namespace ??
    page.properties?.[":block/parent"] ??
    page.properties?.["block/parent"]
  );
}

function refsForBlock(block: PageEntity): unknown[] {
  const refs =
    block[":block/refs"] ??
    block["block/refs"] ??
    block.refs ??
    block.properties?.[":block/refs"] ??
    block.properties?.["block/refs"];

  if (!refs) return [];
  return Array.isArray(refs) ? refs : [refs];
}

function parentIcon(page: PageEntity): ResolvedIcon | undefined {
  return [
    page[":logseq.property/icon"],
    page["logseq.property/icon"],
    page.properties?.[":logseq.property/icon"],
    page.properties?.["logseq.property/icon"],
    page.icon,
    page.properties?.icon,
    page.properties?.["page-icon"],
    page.properties?.pageIcon,
  ].map(resolveIcon).find(Boolean);
}

async function getPageByRef(
  ref: unknown,
  cache: Map<string, Promise<PageEntity | undefined>>,
): Promise<PageEntity | undefined> {
  if (ref && typeof ref === "object") {
    const entity = ref as PageEntity;
    if (pageTitle(entity)) {
      return entity;
    }
  }

  const id = entityId(ref);
  const uuid = entityUuid(ref);
  const key = id ? `id:${id}` : uuid ? `uuid:${uuid}` : "";

  if (!key) return undefined;

  if (!cache.has(key)) {
    cache.set(
      key,
      pullEntity(id, uuid).then((page: unknown) => (page ?? undefined) as PageEntity | undefined),
    );
  }

  return cache.get(key);
}

async function pullEntity(
  id: number | undefined,
  uuid: string | undefined,
): Promise<PageEntity | undefined> {
  try {
    if (typeof id === "number") {
      const entity = await logseq.DB.datascriptQuery(ENTITY_BY_ID_QUERY, id);
      if (entity) return entity as PageEntity;
    }

    if (uuid) {
      const entity = await logseq.DB.datascriptQuery(ENTITY_BY_UUID_QUERY, uuid);
      if (entity) return entity as PageEntity;
    }
  } catch (error) {
    console.warn("[logseq-library-display] failed to pull entity", error);
  }

  if (id || uuid) {
    return ((await logseq.Editor.getPage((id ?? uuid) as number | string)) ??
      undefined) as PageEntity | undefined;
  }

  return undefined;
}

async function parentForEntity(
  entity: PageEntity,
  cache: Map<string, Promise<PageEntity | undefined>>,
): Promise<PageEntity | undefined> {
  return getPageByRef(parentRef(entity), cache);
}

function pageView(page: PageEntity, parent: PageEntity): PageView {
  const parentTitle = pageTitle(parent);
  const childTitle = pageTitle(page);
  const text = `${parentTitle}${PAGE_SEPARATOR}${childTitle}`;
  const icon = parentIcon(parent);
  const mode = settings().displayMode;
  const metadata = {
    parentTitle,
    childTitle,
    pageId: dbId(page),
    pageUuid: entityUuidValue(page),
    parentId: dbId(parent),
    parentUuid: entityUuidValue(parent),
  };

  if (mode === "Icon" && icon) {
    if (icon.kind === "tabler") {
      return {
        display: text,
        title: text,
        ...metadata,
        renderText: icon.value,
        renderSuffix: `${PAGE_SEPARATOR}${childTitle}`,
        renderFontFamily: "tabler-icons",
      };
    }

    return {
      display: `${icon.value}${PAGE_SEPARATOR}${childTitle}`,
      title: text,
      ...metadata,
      renderText: `${icon.value}${PAGE_SEPARATOR}${childTitle}`,
    };
  }

  if (mode === "Icon + Text" && icon) {
    if (icon.kind === "tabler") {
      return {
        display: text,
        title: text,
        ...metadata,
        renderText: icon.value,
        renderSuffix: ` ${text}`,
        renderFontFamily: "tabler-icons",
      };
    }

    return {
      display: `${icon.value} ${text}`,
      title: text,
      ...metadata,
      renderText: `${icon.value} ${text}`,
    };
  }

  return { display: text, title: text, ...metadata, renderText: text };
}

function visibleBlockUuids(): string[] {
  const document = hostDocument();
  const uuids = new Set<string>();

  for (const element of Array.from(document.querySelectorAll("[blockid]"))) {
    const value = element.getAttribute("blockid");
    if (value) uuids.add(value);
  }

  return Array.from(uuids);
}

function flattenBlocks(blocks: unknown[]): PageEntity[] {
  const result: PageEntity[] = [];

  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;

    const entity = block as PageEntity;
    result.push(entity);

    const children = Array.isArray(entity.children) ? entity.children : [];
    result.push(...flattenBlocks(children));
  }

  return result;
}

function queryEntities(result: unknown): PageEntity[] {
  if (!Array.isArray(result)) return [];

  return result
    .map((row) => (Array.isArray(row) ? row[0] : row))
    .filter((entity): entity is PageEntity => Boolean(entity && typeof entity === "object"));
}

function uniqueEntityKey(entity: PageEntity): string | undefined {
  const uuid = entityUuidValue(entity);
  if (uuid) return `uuid:${uuid}`;

  const id = dbId(entity);
  if (typeof id === "number") return `id:${id}`;

  const title = pageTitle(entity);
  return title ? `title:${title}` : undefined;
}

function uniqueEntities(entities: PageEntity[]): PageEntity[] {
  const result: PageEntity[] = [];
  const seen = new Set<string>();

  for (const entity of entities) {
    const key = uniqueEntityKey(entity);
    if (key && seen.has(key)) continue;

    if (key) seen.add(key);
    result.push(entity);
  }

  return result;
}

async function currentPageBlocks(currentPage: PageEntity | undefined): Promise<PageEntity[]> {
  const pageId = dbId(currentPage);

  if (pageId) {
    try {
      const queryResult = await logseq.DB.datascriptQuery(CURRENT_PAGE_BLOCKS_QUERY, pageId);
      const queriedBlocks = queryEntities(queryResult);

      if (queriedBlocks.length > 0) {
        return currentPage ? [currentPage, ...queriedBlocks] : queriedBlocks;
      }
    } catch (error) {
      console.warn("[logseq-library-display] failed to query current page blocks", error);
    }
  }

  const blocks = ((await logseq.Editor.getCurrentPageBlocksTree()) ?? []) as unknown[];
  return currentPage ? [currentPage, ...flattenBlocks(blocks)] : flattenBlocks(blocks);
}

async function recentJournalBlocks(currentPage: PageEntity | undefined): Promise<PageEntity[]> {
  const currentJournalDay = journalDay(currentPage);
  if (!currentJournalDay) return [];

  const currentDate = dateFromJournalDay(currentJournalDay);
  const minDay = journalDayFromDate(addDays(currentDate, -14));
  const maxDay = journalDayFromDate(addDays(currentDate, 3));

  try {
    return queryEntities(
      await logseq.DB.datascriptQuery(RECENT_JOURNAL_BLOCKS_QUERY, minDay, maxDay),
    );
  } catch (error) {
    console.warn("[logseq-library-display] failed to query recent journal blocks", error);
    return [];
  }
}

async function visibleBlocks(): Promise<PageEntity[]> {
  const uuids = visibleBlockUuids();
  if (uuids.length === 0) return [];

  const blocks: PageEntity[] = [];

  for (const uuid of uuids) {
    try {
      const block = ((await logseq.Editor.getBlock(uuid)) ?? undefined) as
        | PageEntity
        | undefined;
      const id = dbId(block);

      if (typeof id === "number") {
        const entity = await logseq.DB.datascriptQuery(BLOCK_BY_ID_QUERY, id);
        if (entity) {
          blocks.push(entity as PageEntity);
          continue;
        }
      }

      if (block) blocks.push(block);
    } catch (error) {
      console.warn("[logseq-library-display] failed to query visible block", uuid, error);
    }
  }

  return blocks;
}

async function addViewsFromBlocks(
  blocks: PageEntity[],
  views: Map<string, PageView>,
  cache: Map<string, Promise<PageEntity | undefined>>,
): Promise<void> {
  for (const block of blocks) {
    for (const ref of refsForBlock(block)) {
      const referenced = await getPageByRef(ref, cache);
      if (!referenced) continue;

      const parent = await parentForEntity(referenced, cache);
      if (!parent) continue;

      addHostMarkerView(views, pageView(referenced, parent));
    }
  }
}

async function refreshReferenceViews(): Promise<void> {
  const version = ++refreshVersion;
  const currentPage = ((await logseq.Editor.getCurrentPage()) ?? undefined) as PageEntity | undefined;

  const nextHostMarkerViews = new Map<string, PageView>();
  const entityCache = new Map<string, Promise<PageEntity | undefined>>();
  const blocks = await currentPageBlocks(currentPage);
  blocks.push(...await recentJournalBlocks(currentPage));
  blocks.push(...await visibleBlocks());

  await addViewsFromBlocks(uniqueEntities(blocks), nextHostMarkerViews, entityCache);

  if (version !== refreshVersion) return;

  const views = Array.from(nextHostMarkerViews.values());
  publishHostMarkerPayload(views);

  if (views.length === 0 && emptyRefreshRetries < 5) {
    emptyRefreshRetries += 1;
    scheduleRefresh(600 * emptyRefreshRetries);
  } else if (views.length > 0) {
    emptyRefreshRetries = 0;
  }
}

function runRefresh(): void {
  window.clearTimeout(refreshTimer);
  if (refreshRunning) {
    refreshQueued = true;
    return;
  }

  refreshRunning = true;
  void refreshReferenceViews()
    .catch((error: unknown) => {
      console.error("[logseq-library-display] failed to refresh", error);
    })
    .finally(() => {
      refreshRunning = false;
      if (refreshQueued) {
        refreshQueued = false;
        scheduleRefresh();
      }
    });
}

function scheduleRefresh(delay = 450): void {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(runRefresh, delay);
}

function scheduleStartupRefreshes(): void {
  startupRefreshTimers = [180, 800, 1800, 3500].map((delay) =>
    window.setTimeout(runRefresh, delay),
  );
}

function disposeHook(hook: OffHook): void {
  if (typeof hook === "function") {
    hook();
    return;
  }

  hook?.off?.();
}

function registerSettings(): void {
  logseq.useSettingsSchema([
    {
      key: "displayMode",
      type: "enum",
      title: "Display mode",
      description: "How to render the parent prefix.",
      default: "Text",
      enumChoices: ["Text", "Icon + Text", "Icon"],
      enumPicker: "select",
    },
  ]);
}

async function boot(): Promise<void> {
  registerSettings();
  logseq.provideStyle(HOST_MARKER_STYLE);

  offDbChanged = logseq.DB.onChanged(() => {
    emptyRefreshRetries = 0;
    scheduleRefresh();
  });

  offRouteChanged = logseq.App.onRouteChanged(() => {
    emptyRefreshRetries = 0;
    scheduleRefresh();
  });

  offSettingsChanged = logseq.onSettingsChanged(() => {
    emptyRefreshRetries = 0;
    scheduleRefresh();
  });

  logseq.beforeunload(async () => {
    disposeHook(offDbChanged);
    disposeHook(offRouteChanged);
    disposeHook(offSettingsChanged);
    window.clearTimeout(refreshTimer);
    startupRefreshTimers.forEach((timer) => window.clearTimeout(timer));
  });

  scheduleStartupRefreshes();
}

logseq.ready(boot).catch((error: unknown) => {
  console.error("[logseq-library-display] failed to start", error);
});
