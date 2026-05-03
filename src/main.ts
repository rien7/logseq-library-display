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
  cssBefore?: string;
  cssAfter?: string;
  cssBeforeFontFamily?: string;
};

type OffHook = (() => void) | { off?: () => void } | undefined;

type ResolvedIcon =
  | { kind: "emoji"; value: string }
  | { kind: "tabler"; value: string };

const REF_SELECTOR = [
  "a.page-ref",
  "span.page-ref",
  "a.page-reference",
  "span.page-reference",
  "[data-testid='page-ref']",
  "[data-ref]",
  "[data-ref-name]",
  "[data-page]",
  "[data-page-name]",
  "[data-page-id]",
  "[data-entity-id]",
  "a[href*='/page/']",
  "a[href*='page=']",
].join(",");

const ORIGINAL_ATTR = "data-library-display-original";
const PATCHED_ATTR = "data-library-display-patched";
const CURRENT_PAGE_BLOCKS_QUERY = `
[:find (pull ?b [* {:block/refs [* {:block/parent [*]}]}])
 :in $ ?page
 :where [?b :block/page ?page]]
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
const ENTITIES_WITH_PARENT_QUERY = `
[:find (pull ?e [* {:block/parent [*]}])
 :where
 [?e :block/title ?title]
 [?e :block/parent ?parent]
 [?parent :block/title ?parent-title]]
`;

let viewsById = new Map<number, PageView>();
let viewsByUuid = new Map<string, PageView>();
let viewsByTitle = new Map<string, PageView>();
let viewsByBlockTitle = new Map<string, Map<string, PageView>>();
let styleRulesByKey = new Map<string, string>();
let dataReady = false;
let refreshVersion = 0;
let refreshTimer: number | undefined;
let renderTimer: number | undefined;
let observer: MutationObserver | undefined;
let offDbChanged: OffHook;
let offRouteChanged: OffHook;
let offSettingsChanged: OffHook;
let originalTextNodes = new WeakMap<Text, string>();
let emptyRefreshRetries = 0;
let startupRefreshTimers: number[] = [];
const PAGE_SEPARATOR = " / ";

function hostDocument(): Document {
  try {
    const hostScope = logseq.Experiments?.ensureHostScope?.();
    return hostScope?.document ?? window.top?.document ?? window.parent?.document ?? document;
  } catch {
    return document;
  }
}

function settings(): Required<PluginSettings> {
  const value = (logseq.settings ?? {}) as PluginSettings;
  return {
    displayMode: value.displayMode ?? "Text",
  };
}

function normalizeTitle(value: string): string {
  return value.trim().replace(/^#+/, "").toLocaleLowerCase();
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

function pageTitleCandidates(page: PageEntity): string[] {
  return [
    textValue(page[":block/title"] ?? page["block/title"] ?? page.title),
    page.originalName,
    page.name,
    textValue(page[":block/name"] ?? page["block/name"]),
    pageTitle(page),
  ]
    .filter((value): value is string => Boolean(value?.trim()));
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

  if (mode === "Icon" && icon) {
    if (icon.kind === "tabler") {
      return {
        display: text,
        title: text,
        cssBefore: icon.value,
        cssAfter: `${PAGE_SEPARATOR}${childTitle}`,
        cssBeforeFontFamily: "tabler-icons",
      };
    }

    return {
      display: `${icon.value}${PAGE_SEPARATOR}${childTitle}`,
      title: text,
      cssBefore: `${icon.value}${PAGE_SEPARATOR}${childTitle}`,
    };
  }

  if (mode === "Icon + Text" && icon) {
    if (icon.kind === "tabler") {
      return {
        display: text,
        title: text,
        cssBefore: icon.value,
        cssAfter: ` ${text}`,
        cssBeforeFontFamily: "tabler-icons",
      };
    }

    return {
      display: `${icon.value} ${text}`,
      title: text,
      cssBefore: `${icon.value} ${text}`,
    };
  }

  return { display: text, title: text, cssBefore: text };
}

function pagePrefix(page: PageEntity, parent: PageEntity): string {
  const parentTitle = pageTitle(parent);
  const childTitle = pageTitle(page);
  const view = pageView(page, parent);

  if (!childTitle || !view.display.endsWith(childTitle)) {
    return `${parentTitle}${PAGE_SEPARATOR}`;
  }

  return view.display.slice(0, -childTitle.length);
}

function bracketedPageView(page: PageEntity, parent: PageEntity): string {
  return `[[${pageView(page, parent).display}]]`;
}

function cssString(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\003c ");
}

function cssAttrValue(value: string | number): string {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function linkReferenceSelectors(entity: PageEntity, includeTitles = true): string[] {
  const id = dbId(entity);
  const uuid = entityUuidValue(entity);
  const selectors = new Set<string>();

  if (uuid) {
    selectors.add(`a[href*="${cssAttrValue(uuid)}"]`);
  }

  if (typeof id === "number") {
    selectors.add(`a[href*="${id}"]`);
  }

  if (includeTitles) {
    for (const title of pageTitleCandidates(entity)) {
      for (const value of encodedTitleValues(title.trim())) {
        selectors.add(`a[href*="${cssAttrValue(value)}"]`);
      }
    }
  }

  return Array.from(selectors);
}

function wrapperReferenceSelectors(entity: PageEntity): string[] {
  const selectors = new Set<string>();

  for (const link of linkReferenceSelectors(entity)) {
    selectors.add(`${link}:has(.page-ref)`);
    selectors.add(`${link}:has(.page-reference)`);
    selectors.add(`${link}:has([data-ref])`);
    selectors.add(`${link}:has([data-ref-name])`);
    selectors.add(`${link}:has([data-page])`);
    selectors.add(`${link}:has([data-page-name])`);
    selectors.add(`${link}:has(.codemirror-ref)`);
  }

  return Array.from(selectors);
}

function blockScopeSelectors(block: PageEntity): string[] {
  const id = dbId(block);
  const uuid = entityUuidValue(block);
  const selectors: string[] = [];

  if (uuid) {
    const value = cssAttrValue(uuid);
    selectors.push(
      `[blockid="${value}"]`,
      `[data-blockid="${value}"]`,
      `[data-block-id="${value}"]`,
      `[data-block-uuid="${value}"]`,
      `[data-uuid="${value}"]`,
    );
  }

  if (typeof id === "number") {
    selectors.push(`[data-block-id="${id}"]`, `[data-entity-id="${id}"]`);
  }

  return selectors;
}

function blockKeys(block: PageEntity): string[] {
  const keys = new Set<string>();
  const id = dbId(block);
  const uuid = entityUuidValue(block);

  if (uuid) keys.add(uuid);
  if (typeof id === "number") keys.add(String(id));

  return Array.from(keys);
}

function closestBlockKey(node: Node): string | undefined {
  const element =
    node instanceof Element ? node : node.parentElement;
  const block = element?.closest(
    "[blockid],[data-blockid],[data-block-id],[data-block-uuid],[data-uuid]",
  );

  return (
    block?.getAttribute("blockid") ??
    block?.getAttribute("data-blockid") ??
    block?.getAttribute("data-block-id") ??
    block?.getAttribute("data-block-uuid") ??
    block?.getAttribute("data-uuid") ??
    undefined
  );
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

function addBlockTitleView(
  block: PageEntity,
  page: PageEntity,
  view: PageView,
  nextByBlockTitle: Map<string, Map<string, PageView>>,
  blockTitleConflicts: Map<string, Set<string>>,
): void {
  for (const blockKey of blockKeys(block)) {
    let blockViews = nextByBlockTitle.get(blockKey);
    if (!blockViews) {
      blockViews = new Map<string, PageView>();
      nextByBlockTitle.set(blockKey, blockViews);
    }

    let conflicts = blockTitleConflicts.get(blockKey);
    if (!conflicts) {
      conflicts = new Set<string>();
      blockTitleConflicts.set(blockKey, conflicts);
    }

    for (const title of pageTitleCandidates(page)) {
      for (const candidate of [title, lastPathSegment(title)]) {
        const key = normalizeTitle(candidate);
        if (!key || conflicts.has(key)) continue;

        const existing = blockViews.get(key);
        if (existing && existing.title !== view.title) {
          blockViews.delete(key);
          conflicts.add(key);
          continue;
        }

        blockViews.set(key, view);
      }
    }
  }
}

function encodedTitleValues(title: string): string[] {
  const values = new Set<string>([title]);

  try {
    values.add(encodeURIComponent(title));
  } catch {
    // Keep the raw title selector if encoding fails for an unexpected value.
  }

  return Array.from(values).filter(Boolean);
}

function titleReferenceSelectors(entity: PageEntity): string[] {
  const selectors = new Set<string>();

  for (const title of pageTitleCandidates(entity)) {
    const cleanTitle = title.trim();
    if (!cleanTitle) continue;

    const attr = cssAttrValue(cleanTitle);
    selectors.add(`.page-ref[data-ref="${attr}"]`);
    selectors.add(`.page-ref[data-ref-name="${attr}"]`);
    selectors.add(`.page-ref[data-page="${attr}"]`);
    selectors.add(`.page-ref[data-page-name="${attr}"]`);
    selectors.add(`.page-reference[data-ref="${attr}"]`);
    selectors.add(`.page-reference[data-ref-name="${attr}"]`);
    selectors.add(`.page-reference[data-page="${attr}"]`);
    selectors.add(`.page-reference[data-page-name="${attr}"]`);
    selectors.add(`[data-ref="${attr}"] .page-ref`);
    selectors.add(`[data-ref-name="${attr}"] .page-ref`);
    selectors.add(`[data-page="${attr}"] .page-ref`);
    selectors.add(`[data-page-name="${attr}"] .page-ref`);

    for (const value of encodedTitleValues(cleanTitle)) {
      selectors.add(`a[href*="${cssAttrValue(value)}"] .page-ref`);
      selectors.add(`a[href*="${cssAttrValue(value)}"] .page-reference`);
    }
  }

  return Array.from(selectors);
}

function fullReferenceSelectors(entity: PageEntity): string[] {
  const id = dbId(entity);
  const uuid = entityUuidValue(entity);
  const selectors = new Set<string>(linkReferenceSelectors(entity, false));

  if (uuid) {
    const value = cssAttrValue(uuid);
    selectors.add(`[data-ref*="${value}"]`);
    selectors.add(`[data-page*="${value}"]`);
    selectors.add(`[data-page-id="${value}"]`);
    selectors.add(`[data-entity-id="${value}"]`);
  }

  if (typeof id === "number") {
    selectors.add(`[data-page-id="${id}"]`);
    selectors.add(`[data-entity-id="${id}"]`);
  }

  return Array.from(selectors);
}

function replacementDeclarations(selectors: string[], display: string): string[] {
  if (selectors.length === 0) return [];

  return [
    `${selectors.join(",")}{font-size:0!important;}`,
    `${selectors.map((selector) => `${selector} *`).join(",")}{font-size:0!important;}`,
    `${selectors
      .map((selector) => `${selector}::before`)
      .join(",")}{content:${cssString(display)};font-size:var(--ls-page-text-size,1rem)!important;}`,
  ];
}

function pageReferenceTextSelector(entity: PageEntity): string | undefined {
  const uuid = entityUuidValue(entity);
  if (!uuid) return undefined;

  return `.page-reference[data-ref="${cssAttrValue(uuid)}"] a.page-ref > span`;
}

function addPageReferenceTextRule(
  entity: PageEntity,
  parent: PageEntity,
  rules: Map<string, string>,
): void {
  const selector = pageReferenceTextSelector(entity);
  const key = entityUuidValue(entity) ?? String(dbId(entity) ?? "");
  if (!selector || !key) return;

  const view = pageView(entity, parent);
  const before = view.cssBefore ?? view.display;
  const beforeFontFamily = view.cssBeforeFontFamily
    ? `font-family:${view.cssBeforeFontFamily}!important;`
    : "";
  const afterRule = view.cssAfter
    ? `${selector}::after{content:${cssString(view.cssAfter)};font-size:1rem!important;}`
    : "";

  rules.set(
    `entity:${key}`,
    `${selector}{font-size:0!important;}` +
      `${selector}::before{content:${cssString(before)};${beforeFontFamily}font-size:1rem!important;}` +
      afterRule,
  );
}

function addReferenceReplacementRule(
  entity: PageEntity,
  parent: PageEntity,
  rules: Map<string, string>,
): void {
  const fullRef = bracketedPageView(entity, parent);
  const key = entityUuidValue(entity) ?? String(dbId(entity) ?? "");
  const selectors = fullReferenceSelectors(entity);

  if (!key || selectors.length === 0) return;

  rules.set(`entity:${key}`, replacementDeclarations(selectors, fullRef).join("\n"));
}

function scopedReferenceSelectors(scopes: string[], refs: string[]): string[] {
  const selectors: string[] = [];

  for (const scope of scopes) {
    for (const ref of refs) {
      selectors.push(`${scope} ${ref}`);
    }
  }

  return selectors;
}

function addBlockStyleRule(
  block: PageEntity,
  entity: PageEntity,
  parent: PageEntity,
  rules: Map<string, string>,
): void {
  const prefix = pagePrefix(entity, parent);
  const fullRef = bracketedPageView(entity, parent);
  const blockKey = entityUuidValue(block) ?? String(dbId(block) ?? "");
  const entityKey = entityUuidValue(entity) ?? String(dbId(entity) ?? pageTitle(entity));
  const scopes = blockScopeSelectors(block);
  const wrapperSelectors = scopedReferenceSelectors(scopes, wrapperReferenceSelectors(entity));
  const titleSelectors = scopedReferenceSelectors(
    scopes,
    [
      ...linkReferenceSelectors(entity).flatMap((selector) => [
        `${selector} .page-ref`,
        `${selector} .page-reference`,
        `${selector} [data-ref]`,
        `${selector} [data-ref-name]`,
        `${selector} [data-page]`,
        `${selector} [data-page-name]`,
      ]),
      ...titleReferenceSelectors(entity),
    ],
  );
  const declarations: string[] = [];

  if (!blockKey || !entityKey || !prefix || scopes.length === 0) return;

  if (wrapperSelectors.length > 0) {
    declarations.push(...replacementDeclarations(wrapperSelectors, fullRef));
  }

  if (titleSelectors.length > 0) {
    declarations.push(
      `${titleSelectors.map((selector) => `${selector}::before`).join(",")}{content:${cssString(prefix)};}`,
    );
  }

  if (declarations.length > 0) {
    rules.set(`block:${blockKey}:${entityKey}`, declarations.join("\n"));
  }
}

function addTitleView(
  title: string,
  view: PageView,
  nextByTitle: Map<string, PageView>,
  titleConflicts: Set<string>,
): void {
  const key = normalizeTitle(title);
  if (!key || titleConflicts.has(key)) return;

  const existing = nextByTitle.get(key);
  if (existing && existing.title !== view.title) {
    nextByTitle.delete(key);
    titleConflicts.add(key);
    return;
  }

  nextByTitle.set(key, view);
}

function addView(
  page: PageEntity,
  view: PageView,
  nextById: Map<number, PageView>,
  nextByUuid: Map<string, PageView>,
  nextByTitle: Map<string, PageView>,
  titleConflicts: Set<string>,
): void {
  if (typeof page.id === "number") nextById.set(page.id, view);
  const id = dbId(page);
  const uuid = entityUuidValue(page);
  if (typeof id === "number") nextById.set(id, view);
  if (uuid) nextByUuid.set(uuid, view);

  for (const title of pageTitleCandidates(page)) {
    addTitleView(title, view, nextByTitle, titleConflicts);
    addTitleView(lastPathSegment(title), view, nextByTitle, titleConflicts);
  }
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

async function refreshReferenceViews(): Promise<void> {
  const version = ++refreshVersion;
  const currentPage = ((await logseq.Editor.getCurrentPage()) ?? undefined) as PageEntity | undefined;

  const nextById = new Map<number, PageView>();
  const nextByUuid = new Map<string, PageView>();
  const nextByTitle = new Map<string, PageView>();
  const nextByBlockTitle = new Map<string, Map<string, PageView>>();
  const nextStyleRules = new Map<string, string>();
  const titleConflicts = new Set<string>();
  const blockTitleConflicts = new Map<string, Set<string>>();
  const entityCache = new Map<string, Promise<PageEntity | undefined>>();

  if (currentPage) {
    const blocks = await currentPageBlocks(currentPage);

    for (const block of blocks) {
      for (const ref of refsForBlock(block)) {
        const referenced = await getPageByRef(ref, entityCache);
        if (!referenced) continue;

        const parent = await parentForEntity(referenced, entityCache);
        if (!parent) continue;

        addView(referenced, pageView(referenced, parent), nextById, nextByUuid, nextByTitle, titleConflicts);
        addPageReferenceTextRule(referenced, parent, nextStyleRules);
        addBlockTitleView(
          block,
          referenced,
          pageView(referenced, parent),
          nextByBlockTitle,
          blockTitleConflicts,
        );
      }
    }
  }

  for (const block of await visibleBlocks()) {
    for (const ref of refsForBlock(block)) {
      const referenced = await getPageByRef(ref, entityCache);
      if (!referenced) continue;

      const parent = await parentForEntity(referenced, entityCache);
      if (!parent) continue;

      const view = pageView(referenced, parent);
      addView(referenced, view, nextById, nextByUuid, nextByTitle, titleConflicts);
      addPageReferenceTextRule(referenced, parent, nextStyleRules);
      addBlockTitleView(
        block,
        referenced,
        view,
        nextByBlockTitle,
        blockTitleConflicts,
      );
    }
  }

  try {
    const parentedEntities = queryEntities(
      await logseq.DB.datascriptQuery(ENTITIES_WITH_PARENT_QUERY),
    );

    for (const entity of parentedEntities) {
      const parent = parentRef(entity) as PageEntity | undefined;
      if (!parent || !pageTitle(parent)) continue;

      addView(entity, pageView(entity, parent), nextById, nextByUuid, nextByTitle, titleConflicts);
      addPageReferenceTextRule(entity, parent, nextStyleRules);
    }
  } catch (error) {
    console.warn("[logseq-library-display] failed to query parented entities", error);
  }

  if (version !== refreshVersion) return;

  viewsById = nextById;
  viewsByUuid = nextByUuid;
  viewsByTitle = nextByTitle;
  viewsByBlockTitle = nextByBlockTitle;
  styleRulesByKey = nextStyleRules;
  dataReady = true;
  logseq.provideStyle(Array.from(styleRulesByKey.values()).join("\n"));

  const hasViews =
    viewsById.size > 0 ||
    viewsByUuid.size > 0 ||
    viewsByTitle.size > 0 ||
    viewsByBlockTitle.size > 0;

  if (!hasViews && emptyRefreshRetries < 5) {
    emptyRefreshRetries += 1;
    scheduleRefresh(600 * emptyRefreshRetries);
  } else if (hasViews) {
    emptyRefreshRetries = 0;
  }
}

function hrefNames(element: Element): string[] {
  const href = element.getAttribute("href");
  if (!href) return [];

  const decoded = decodeURIComponent(href);
  const values: string[] = [];
  const pageParam = decoded.match(/[?&]page=([^&]+)/)?.[1];
  const pagePath = decoded.match(/\/page\/([^?#]+)/)?.[1];

  if (pageParam) values.push(pageParam);
  if (pagePath) values.push(pagePath);

  return values;
}

function referenceNameCandidates(value: string): string[] {
  const clean = value.trim().replace(/^#+/, "");
  const last = lastPathSegment(clean);
  return [clean, last].filter(Boolean);
}

function viewForElement(element: Element): PageView | undefined {
  const idCandidates = [
    element.getAttribute("data-page-id"),
    element.getAttribute("data-entity-id"),
  ].filter((value): value is string => Boolean(value?.trim()));

  for (const rawId of idCandidates) {
    const id = Number(rawId);
    if (Number.isFinite(id)) {
      const view = viewsById.get(id);
      if (view) return view;
    }

    const uuidView = viewsByUuid.get(rawId.trim());
    if (uuidView) return uuidView;
  }

  const textCandidates = [
    element.getAttribute(ORIGINAL_ATTR),
    element.getAttribute("data-ref"),
    element.getAttribute("data-ref-name"),
    element.getAttribute("data-page"),
    element.getAttribute("data-page-name"),
    ...hrefNames(element),
    element.textContent,
  ].filter((value): value is string => Boolean(value?.trim()));

  for (const raw of textCandidates) {
    for (const candidate of referenceNameCandidates(raw)) {
      const view = viewsByTitle.get(normalizeTitle(candidate));
      if (view) return view;
    }
  }

  return undefined;
}

function originalText(element: Element): string {
  return element.getAttribute(ORIGINAL_ATTR) || element.textContent?.trim() || "";
}

function patchReference(element: Element): void {
  if (!dataReady || element.closest("textarea,input,[contenteditable='true']")) return;

  const view = viewForElement(element);
  const original = originalText(element);

  if (!view) {
    if (element.getAttribute(PATCHED_ATTR) === "true") {
      element.textContent = original;
      element.removeAttribute(PATCHED_ATTR);
      element.removeAttribute("title");
    }
    return;
  }

  if (!element.getAttribute(ORIGINAL_ATTR)) {
    element.setAttribute(ORIGINAL_ATTR, original);
  }

  if (element.textContent?.trim() !== view.display) {
    element.textContent = view.display;
  }

  element.setAttribute(PATCHED_ATTR, "true");
  element.setAttribute("title", view.title);
}

function compact(value: string): string {
  return value.replace(/\s+/g, "");
}

function siblingText(node: Node, direction: "previous" | "next"): string {
  let current =
    direction === "previous" ? node.previousSibling : node.nextSibling;
  let value = "";

  while (current && value.length < 80) {
    const text = current.textContent ?? "";
    value =
      direction === "previous" ? `${text}${value}` : `${value}${text}`;

    if (direction === "previous") {
      current = current.previousSibling;
    } else {
      current = current.nextSibling;
    }
  }

  return value;
}

function isBracketedReferenceText(node: Text, value: string): boolean {
  const before = compact(siblingText(node, "previous"));
  const after = compact(siblingText(node, "next"));

  if (before.endsWith("[[") && after.startsWith("]]")) return true;

  let current = node.parentElement;
  const needle = `[[${compact(value)}]]`;

  for (let depth = 0; current && depth < 6; depth += 1) {
    if (compact(current.textContent ?? "").includes(needle)) return true;
    current = current.parentElement;
  }

  return false;
}

function shouldPatchTextNode(node: Text, value: string): boolean {
  const parent = node.parentElement;
  if (!parent) return false;
  if (parent.closest("textarea,input,[contenteditable='true'],script,style")) return false;

  return isBracketedReferenceText(node, value);
}

function viewForTitleInNode(node: Node, title: string): PageView | undefined {
  const blockKey = closestBlockKey(node);
  const titleCandidates = referenceNameCandidates(title);

  if (blockKey) {
    const blockViews = viewsByBlockTitle.get(blockKey);
    if (blockViews) {
      for (const candidate of titleCandidates) {
        const view = blockViews.get(normalizeTitle(candidate));
        if (view) return view;
      }
    }
  }

  for (const candidate of titleCandidates) {
    const view = viewsByTitle.get(normalizeTitle(candidate));
    if (view) return view;
  }

  return undefined;
}

function replaceBracketedReferences(value: string, node: Node): string {
  return value.replace(/\[\[\s*([^\]]+?)\s*\]\]/g, (match, title: string) => {
    const view = viewForTitleInNode(node, title);
    return view ? match.replace(title, view.display) : match;
  });
}

function patchTextReference(node: Text): void {
  if (!dataReady) return;

  const original = originalTextNodes.get(node) ?? node.textContent ?? "";
  if (!original) return;

  const bracketed = replaceBracketedReferences(original, node);

  if (bracketed !== original) {
    if (!originalTextNodes.has(node)) {
      originalTextNodes.set(node, original);
    }

    if (node.textContent !== bracketed) {
      node.textContent = bracketed;
    }

    return;
  }

  const trimmed = original.trim();
  const view = viewForTitleInNode(node, trimmed);

  if (!view) {
    if (originalTextNodes.has(node)) {
      node.textContent = originalTextNodes.get(node) ?? node.textContent;
      originalTextNodes.delete(node);
    }
    return;
  }

  if (!shouldPatchTextNode(node, trimmed)) return;

  if (!originalTextNodes.has(node)) {
    originalTextNodes.set(node, original);
  }

  if (node.textContent?.trim() !== view.display) {
    node.textContent = original.replace(trimmed, view.display);
  }
}

function renderTextReferences(root: ParentNode): void {
  const rootNode = root as Node;
  const ownerDocument =
    rootNode.nodeType === 9 ? (rootNode as Document) : rootNode.ownerDocument ?? document;
  const tree = ownerDocument.createTreeWalker(rootNode, 4);
  let node = tree.nextNode();

  while (node) {
    patchTextReference(node as Text);
    node = tree.nextNode();
  }
}

function renderReferences(root: ParentNode = hostDocument()): void {
  const elements: Element[] = [];

  if (root instanceof Element && root.matches(REF_SELECTOR)) {
    elements.push(root);
  }

  elements.push(...Array.from(root.querySelectorAll(REF_SELECTOR)));

  for (const element of elements) {
    patchReference(element);
  }

  renderTextReferences(root);
}

function scheduleRender(root?: ParentNode): void {
  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => renderReferences(root ?? hostDocument()), 80);
}

function runRefresh(): void {
  window.clearTimeout(refreshTimer);
  void refreshReferenceViews()
    .then(() => scheduleRender())
    .catch((error: unknown) => {
    console.error("[logseq-library-display] failed to refresh", error);
    });
}

function scheduleRefresh(delay = 180): void {
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

  const host = hostDocument();
  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        scheduleRender(mutation.target instanceof Element ? mutation.target : host);
        return;
      }
    }
  });

  observer.observe(host.body ?? host.documentElement, {
    childList: true,
    subtree: true,
  });

  offDbChanged = logseq.DB.onChanged(() => {
    dataReady = false;
    emptyRefreshRetries = 0;
    originalTextNodes = new WeakMap<Text, string>();
    scheduleRefresh();
  });

  offRouteChanged = logseq.App.onRouteChanged(() => {
    dataReady = false;
    emptyRefreshRetries = 0;
    originalTextNodes = new WeakMap<Text, string>();
    scheduleRefresh();
  });

  offSettingsChanged = logseq.onSettingsChanged(() => {
    dataReady = false;
    emptyRefreshRetries = 0;
    originalTextNodes = new WeakMap<Text, string>();
    scheduleRefresh();
  });

  logseq.beforeunload(async () => {
    observer?.disconnect();
    disposeHook(offDbChanged);
    disposeHook(offRouteChanged);
    disposeHook(offSettingsChanged);
    window.clearTimeout(refreshTimer);
    window.clearTimeout(renderTimer);
    startupRefreshTimers.forEach((timer) => window.clearTimeout(timer));
  });

  scheduleStartupRefreshes();
}

logseq.ready(boot).catch((error: unknown) => {
  console.error("[logseq-library-display] failed to start", error);
});
