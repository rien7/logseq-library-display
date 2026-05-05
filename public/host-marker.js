(function () {
  var PAYLOAD_ID = "logseq-library-display-payload";
  var MARKER_VERSION = 8;
  var PARENTED_ATTR = "data-library-display-parented";
  var CONTAINS_ATTR = "data-library-display-contains-parented-reference";
  var PARENTED_CLASS = "library-display-parented-reference";
  var CONTAINS_CLASS = "library-display-contains-parented-reference";
  var DISPLAY_CLASS = "library-display-rendered-reference";
  var ICON_CLASS = "library-display-rendered-reference-icon";
  var TEXT_FALLBACK_ATTR = "data-library-display-original-text";
  var HREF_ATTR = "data-library-display-href";
  var REFERENCE_SHELL_SELECTOR = "a.page-ref,a[href*='#/page/'],.page-ref,[data-testid='page-ref']";
  var REFERENCE_ANCHOR_SELECTOR = "a.page-ref,a[href*='#/page/']";
  var MARKED_SELECTOR =
    "[" + PARENTED_ATTR + "],[" + CONTAINS_ATTR + "]," +
    "." + PARENTED_CLASS + ",." + CONTAINS_CLASS + ",." + DISPLAY_CLASS;
  var METADATA_ATTRS = [
    PARENTED_ATTR,
    CONTAINS_ATTR,
    "data-library-display-page-id",
    "data-library-display-page-uuid",
    "data-library-display-page-title",
    "data-library-display-parent-id",
    "data-library-display-parent-uuid",
    "data-library-display-parent-title",
    "data-library-display-title",
    "data-library-display-value",
    "data-library-display-original-html",
    TEXT_FALLBACK_ATTR,
    HREF_ATTR,
  ];

  if (window.__logseqLibraryDisplayHostMarker) {
    if (window.__logseqLibraryDisplayHostMarker.version === MARKER_VERSION) {
      window.__logseqLibraryDisplayHostMarker.refresh();
      return;
    }

    window.__logseqLibraryDisplayHostMarker.disconnect();
  }

  var state = {
    views: [],
    byId: {},
    byUuid: {},
    byTitle: {},
    timer: 0,
    marking: false,
    needsClear: false,
    lastSignature: "",
    pulseTimer: 0,
    pulseStopTimer: 0,
  };

  function setAttribute(element, name, value) {
    if (value === undefined || value === null || value === "") {
      element.removeAttribute(name);
      return;
    }

    var next = String(value);
    if (element.getAttribute(name) !== next) {
      element.setAttribute(name, next);
    }
  }

  function htmlFragment(html) {
    var template = document.createElement("template");
    template.innerHTML = html;
    return template.content;
  }

  function clearElement(element) {
    var originalText = element.getAttribute(TEXT_FALLBACK_ATTR);
    if (originalText !== null) {
      element.replaceWith(document.createTextNode(originalText));
      return;
    }

    if (element.classList.contains(DISPLAY_CLASS)) {
      var originalHtml = element.getAttribute("data-library-display-original-html");
      if (originalHtml !== null) {
        if (element.parentElement && element.parentElement.matches(".page-ref, a[href*='#/page/'], [data-testid='page-ref']")) {
          element.replaceWith(htmlFragment(originalHtml));
        } else {
          element.innerHTML = originalHtml;
        }
      }
    }

    for (var i = 0; i < METADATA_ATTRS.length; i += 1) {
      element.removeAttribute(METADATA_ATTRS[i]);
    }
    element.classList.remove(PARENTED_CLASS, CONTAINS_CLASS, DISPLAY_CLASS);
  }

  function clearMarkedElements() {
    var elements = document.querySelectorAll(MARKED_SELECTOR);
    for (var i = 0; i < elements.length; i += 1) {
      clearElement(elements[i]);
    }
  }

  function decodePayload(value) {
    return JSON.parse(decodeURIComponent(window.atob(value.trim())));
  }

  function payloadElement() {
    return (
      document.getElementById(PAYLOAD_ID) ||
      document.querySelector('[data-injected-ui$="--' + PAYLOAD_ID + '"]') ||
      document.querySelector('[id$="--' + PAYLOAD_ID + '"]')
    );
  }

  function isPayloadElement(node) {
    return (
      node &&
      node.nodeType === 1 &&
      (node.id === PAYLOAD_ID ||
        node.id === "logseq-library-display--" + PAYLOAD_ID ||
        String(node.getAttribute("data-injected-ui") || "").endsWith("--" + PAYLOAD_ID))
    );
  }

  function readPayload() {
    var element = payloadElement();
    if (!element) return;

    try {
      var payload = decodePayload(element.textContent || "");
      state.views = Array.isArray(payload.views) ? payload.views : [];
      rebuildIndexes();
      state.needsClear = true;
      state.lastSignature = "";
      scheduleMark();
      if (state.views.length > 0) {
        startPulse();
      }
    } catch (error) {
      console.warn("[logseq-library-display] failed to read host marker payload", error);
    }
  }

  function lower(value) {
    return String(value).trim().toLocaleLowerCase();
  }

  function addTitle(view, value) {
    var title = String(value || "").trim();
    if (!title) return;

    state.byTitle[lower(title)] = view;

    var parts = title.split("/");
    if (parts.length > 1) {
      state.byTitle[lower(parts[parts.length - 1])] = view;
    }
  }

  function rebuildIndexes() {
    state.byId = {};
    state.byUuid = {};
    state.byTitle = {};

    for (var i = 0; i < state.views.length; i += 1) {
      var view = state.views[i];

      if (view.pageUuid) {
        state.byUuid[String(view.pageUuid)] = view;
      }

      if (view.pageId !== undefined && view.pageId !== null) {
        state.byId[String(view.pageId)] = view;
      }

      addTitle(view, view.title);
      addTitle(view, view.childTitle);
    }
  }

  function titleVariants(view) {
    var values = [];
    if (view.title) values.push(view.title);
    if (view.childTitle) values.push(view.childTitle);

    var normalized = [];
    for (var i = 0; i < values.length; i += 1) {
      var value = String(values[i]).trim();
      if (!value) continue;
      normalized.push(value);
      normalized.push(lower(value));
      var parts = value.split("/");
      if (parts.length > 1) {
        var last = parts[parts.length - 1].trim();
        if (last) {
          normalized.push(last);
          normalized.push(lower(last));
        }
      }
    }

    return Array.prototype.filter.call(normalized, function (value, index) {
      return normalized.indexOf(value) === index;
    });
  }

  function pageHref(view) {
    var name = view.pageUuid || view.childTitle || view.title;
    return name ? "#/page/" + encodeURIComponent(name) : undefined;
  }

  function setReferenceMetadata(element, view) {
    setAttribute(element, "data-library-display-page-id", view.pageId);
    setAttribute(element, "data-library-display-page-uuid", view.pageUuid);
    setAttribute(element, "data-library-display-page-title", view.childTitle || view.title);
    setAttribute(element, "data-library-display-parent-id", view.parentId);
    setAttribute(element, "data-library-display-parent-uuid", view.parentUuid);
    setAttribute(element, "data-library-display-parent-title", view.parentTitle);
    setAttribute(element, "data-library-display-title", view.title);
    setAttribute(element, "data-library-display-value", view.display);
  }

  function appendReferenceContent(element, view) {
    element.textContent = "";

    if (view.renderFontFamily === "tabler-icons") {
      var icon = document.createElement("span");
      icon.className = ICON_CLASS;
      icon.textContent = view.renderText || "";
      element.appendChild(icon);
      element.appendChild(document.createTextNode(view.renderSuffix || ""));
    } else {
      element.textContent = view.renderText || view.display;
    }
  }

  function renderedChild(element) {
    for (var i = 0; i < element.children.length; i += 1) {
      if (element.children[i].classList.contains(DISPLAY_CLASS)) return element.children[i];
    }
    return undefined;
  }

  function shouldPreserveReferenceShell(element) {
    return element.matches(REFERENCE_SHELL_SELECTOR);
  }

  function hasNativeAnchor(element) {
    return element.matches(REFERENCE_ANCHOR_SELECTOR) || Boolean(element.querySelector(REFERENCE_ANCHOR_SELECTOR));
  }

  function displayTargetForShell(element) {
    var child = renderedChild(element);
    if (child) return child;

    child = document.createElement("span");
    setAttribute(child, "data-library-display-original-html", element.innerHTML);
    element.textContent = "";
    element.appendChild(child);
    return child;
  }

  function renderTextReference(element, view) {
    var target = element;
    if (shouldPreserveReferenceShell(element)) {
      target = displayTargetForShell(element);
      setAttribute(target, HREF_ATTR, hasNativeAnchor(element) ? undefined : pageHref(view));
    } else if (!element.classList.contains(DISPLAY_CLASS)) {
      setAttribute(element, "data-library-display-original-html", element.innerHTML);
    }

    appendReferenceContent(target, view);
    setReferenceMetadata(target, view);
    target.classList.add(DISPLAY_CLASS);
  }

  function nativeReferenceTarget(element, pageReference, pageRef) {
    var anchor = element.matches(REFERENCE_ANCHOR_SELECTOR)
      ? element
      : element.closest(REFERENCE_ANCHOR_SELECTOR);
    if (anchor) return anchor;

    if (pageReference) {
      anchor = pageReference.querySelector(REFERENCE_ANCHOR_SELECTOR);
      if (anchor) return anchor;
    }

    return pageRef || element;
  }

  function markReference(element, view) {
    var targets = [element];
    var pageReference = element.matches(".page-reference")
      ? element
      : element.closest(".page-reference[data-ref], .page-reference");
    var pageRef = element.matches(".page-ref")
      ? element
      : element.closest("a.page-ref, span.page-ref, .page-ref") ||
        (pageReference && pageReference.querySelector("a.page-ref, span.page-ref, .page-ref"));

    if (pageReference) targets.push(pageReference);
    if (pageRef) targets.push(pageRef);

    for (var i = 0; i < targets.length; i += 1) {
      var target = targets[i];
      if (shouldPreserveReferenceShell(target)) continue;
      setAttribute(target, PARENTED_ATTR, "true");
      setReferenceMetadata(target, view);
      target.classList.add(PARENTED_CLASS);
    }

    var renderTarget = nativeReferenceTarget(element, pageReference, pageRef);
    renderTextReference(renderTarget, view);

    var container = element.closest(
      ".block-content, .block-main-container, .ls-block, .page-reference, p, div",
    );
    if (container) {
      setAttribute(container, CONTAINS_ATTR, "true");
      setAttribute(container, "data-library-display-title", view.title);
      setAttribute(container, "data-library-display-value", view.display);
      container.classList.add(CONTAINS_CLASS);
    }
  }

  function referenceElements() {
    return document.querySelectorAll(
      ".page-reference,a.page-ref,span.page-ref,.page-ref,[data-testid='page-ref']," +
        "[data-ref-name],[data-page-id],[data-entity-id]",
    );
  }

  function hrefValues(element) {
    var href = element.getAttribute("href");
    if (!href) return [];

    var values = [href];
    try {
      values.push(decodeURIComponent(href));
    } catch (_) {
      // Keep the raw href when it is not URI-encoded.
    }

    var uuidMatches = href.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g);
    if (uuidMatches) {
      values = values.concat(uuidMatches);
    }

    return values;
  }

  function attributeValues(element) {
    var values = [
      element.getAttribute("data-ref"),
      element.getAttribute("data-page-uuid"),
      element.getAttribute("data-block-uuid"),
      element.getAttribute("data-page-id"),
      element.getAttribute("data-entity-id"),
      element.getAttribute("data-ref-name"),
      element.getAttribute("data-page"),
      element.getAttribute("data-page-name"),
    ].concat(hrefValues(element));

    if (!element.classList.contains(DISPLAY_CLASS)) {
      values.push(element.textContent);
    }

    return values.filter(function (value) {
      return value && String(value).trim();
    });
  }

  function viewForElement(element) {
    var sources = [element];
    var pageReference = element.matches(".page-reference")
      ? element
      : element.closest(".page-reference[data-ref], .page-reference");
    var pageRef = element.matches(".page-ref")
      ? element
      : element.closest("a.page-ref, span.page-ref, .page-ref");

    if (pageReference && pageReference !== element) sources.push(pageReference);
    if (pageRef && pageRef !== element) sources.push(pageRef);

    for (var i = 0; i < sources.length; i += 1) {
      var values = attributeValues(sources[i]);

      for (var j = 0; j < values.length; j += 1) {
        var value = String(values[j]).trim();
        var byUuid = state.byUuid[value];
        if (byUuid) return byUuid;

        var byId = state.byId[value];
        if (byId) return byId;
      }

      for (var k = 0; k < values.length; k += 1) {
        var byTitle = state.byTitle[lower(values[k])];
        if (byTitle) return byTitle;
      }
    }

    return undefined;
  }

  function eventElement(event) {
    var target = event.target;
    if (!target) return undefined;

    var element = target.nodeType === 3 ? target.parentElement : target;
    if (!element || !element.closest) return undefined;

    return element;
  }

  function navigationTarget(event) {
    var element = eventElement(event);
    if (!element) return undefined;

    var selector = "." + DISPLAY_CLASS + "[" + HREF_ATTR + "]";
    return element.closest(selector) || (element.querySelector && element.querySelector(selector));
  }

  function navigateTarget(target) {
    var href = target.getAttribute(HREF_ATTR);
    if (!href || href.indexOf("#/page/") !== 0) return;

    window.location.hash = href.slice(1);
  }

  function onNavigationPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;

    var target = navigationTarget(event);
    if (!target) return;

    event.preventDefault();
    event.stopPropagation();
    navigateTarget(target);
  }

  function stopNavigationEdit(event) {
    if (!navigationTarget(event)) return;

    event.preventDefault();
    event.stopPropagation();
  }

  function onNavigationClick(event) {
    if (event.button !== undefined && event.button !== 0) return;

    var target = navigationTarget(event);
    if (!target) return;

    event.preventDefault();
    event.stopPropagation();
    navigateTarget(target);
  }

  function onNavigationKeydown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;

    var target = navigationTarget(event);
    if (!target) return;

    event.preventDefault();
    event.stopPropagation();
    navigateTarget(target);
  }

  function textView(value) {
    var title = String(value || "")
      .replace(/^\s*\[\[\s*/, "")
      .replace(/\s*\]\]\s*$/, "")
      .trim();

    return title ? state.byTitle[lower(title)] || state.byUuid[title] || state.byId[title] : undefined;
  }

  function textNodeAllowed(node) {
    var parent = node.parentElement;
    if (!parent) return false;

    return !parent.closest(
      "script,style,textarea,input,select,option,#" + PAYLOAD_ID + ",." + DISPLAY_CLASS,
    );
  }

  function renderTextFallbackSpan(originalText, view) {
    var span = document.createElement("span");
    setAttribute(span, TEXT_FALLBACK_ATTR, originalText);
    setAttribute(span, HREF_ATTR, pageHref(view));
    setAttribute(span, PARENTED_ATTR, "true");
    setReferenceMetadata(span, view);
    span.classList.add(PARENTED_CLASS, DISPLAY_CLASS);

    if (view.renderFontFamily === "tabler-icons") {
      var icon = document.createElement("span");
      icon.className = ICON_CLASS;
      icon.textContent = view.renderText || "";
      span.appendChild(document.createTextNode("[[ "));
      span.appendChild(icon);
      span.appendChild(document.createTextNode((view.renderSuffix || "") + " ]]"));
    } else {
      span.textContent = "[[ " + (view.renderText || view.display) + " ]]";
    }

    return span;
  }

  function markTextNode(node) {
    if (!textNodeAllowed(node)) return false;

    var text = node.nodeValue || "";
    if (text.indexOf("[[") === -1) return false;

    var pattern = /\[\[\s*([^\]]+?)\s*\]\]/g;
    var lastIndex = 0;
    var changed = false;
    var fragment = document.createDocumentFragment();
    var match;

    while ((match = pattern.exec(text))) {
      var view = textView(match[1]);
      if (!view) continue;

      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      fragment.appendChild(renderTextFallbackSpan(match[0], view));
      lastIndex = pattern.lastIndex;
      changed = true;
    }

    if (!changed) return false;

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    node.parentNode.replaceChild(fragment, node);
    return true;
  }

  function textReferenceContainers() {
    var containers = document.querySelectorAll(
      ".block-content,.block-main-container,.ls-block,.references-blocks",
    );
    return containers.length ? containers : [document.body];
  }

  function hasUnmarkedTextReference() {
    var containers = textReferenceContainers();

    for (var i = 0; i < containers.length; i += 1) {
      var walker = document.createTreeWalker(containers[i], NodeFilter.SHOW_TEXT);
      var node;

      while ((node = walker.nextNode())) {
        if (!textNodeAllowed(node)) continue;

        var text = node.nodeValue || "";
        if (text.indexOf("[[") === -1) continue;

        var pattern = /\[\[\s*([^\]]+?)\s*\]\]/g;
        var match;
        while ((match = pattern.exec(text))) {
          if (textView(match[1])) return true;
        }
      }
    }

    return false;
  }

  function markTextReferences() {
    var containers = textReferenceContainers();

    for (var i = 0; i < containers.length; i += 1) {
      var walker = document.createTreeWalker(containers[i], NodeFilter.SHOW_TEXT);
      var nodes = [];
      var node;

      while ((node = walker.nextNode())) {
        nodes.push(node);
      }

      for (var j = 0; j < nodes.length; j += 1) {
        markTextNode(nodes[j]);
      }
    }
  }

  function elementSignature(element) {
    return attributeValues(element).join("|");
  }

  function signatureForElements(elements) {
    var values = [String(state.views.length)];
    for (var i = 0; i < elements.length; i += 1) {
      values.push(elementSignature(elements[i]));
    }
    return values.join(";");
  }

  function hasUnmarkedReference(elements) {
    for (var i = 0; i < elements.length; i += 1) {
      if (shouldPreserveReferenceShell(elements[i]) && renderedChild(elements[i])) continue;
      if (!elements[i].hasAttribute(PARENTED_ATTR) && viewForElement(elements[i])) return true;
    }
    return false;
  }

  function mark() {
    state.marking = true;
    try {
      if (state.views.length === 0) {
        if (state.needsClear) {
          clearMarkedElements();
          state.needsClear = false;
          state.lastSignature = "";
        }
        return;
      }

      var elements = referenceElements();
      var signature = signatureForElements(elements);
      var hasTextReference = hasUnmarkedTextReference();
      if (
        !state.needsClear &&
        signature === state.lastSignature &&
        !hasUnmarkedReference(elements) &&
        !hasTextReference
      ) {
        return;
      }

      if (state.needsClear) {
        clearMarkedElements();
        state.needsClear = false;
      }

      for (var i = 0; i < elements.length; i += 1) {
        var view = viewForElement(elements[i]);
        if (view) markReference(elements[i], view);
      }
      markTextReferences();
      state.lastSignature = signature;
    } finally {
      window.setTimeout(function () {
        state.marking = false;
      }, 0);
    }
  }

  function scheduleMark() {
    if (state.views.length === 0 && !state.needsClear) return;

    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(mark, 80);
  }

  function startPulse() {
    window.clearInterval(state.pulseTimer);
    window.clearTimeout(state.pulseStopTimer);
    state.pulseTimer = window.setInterval(mark, 700);
    state.pulseStopTimer = window.setTimeout(function () {
      window.clearInterval(state.pulseTimer);
      state.pulseTimer = 0;
    }, 4000);
  }

  var observer = new MutationObserver(function (mutations) {
    if (state.marking) return;

    for (var i = 0; i < mutations.length; i += 1) {
      var mutation = mutations[i];
      if (isPayloadElement(mutation.target)) {
        readPayload();
        return;
      }

      if (mutation.type === "childList") {
        for (var j = 0; j < mutation.addedNodes.length; j += 1) {
          var node = mutation.addedNodes[j];
          if (isPayloadElement(node)) {
            readPayload();
            return;
          }
        }
        if (state.views.length > 0) {
          scheduleMark();
        }
        return;
      }

      if (
        mutation.type === "characterData" &&
        mutation.target &&
        mutation.target.parentElement &&
        isPayloadElement(mutation.target.parentElement)
      ) {
        readPayload();
        return;
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  document.addEventListener("pointerdown", onNavigationPointerDown, true);
  document.addEventListener("mousedown", stopNavigationEdit, true);
  document.addEventListener("click", onNavigationClick, true);
  document.addEventListener("keydown", onNavigationKeydown, true);

  window.__logseqLibraryDisplayHostMarker = {
    version: MARKER_VERSION,
    refresh: readPayload,
    mark: mark,
    disconnect: function () {
      observer.disconnect();
      document.removeEventListener("pointerdown", onNavigationPointerDown, true);
      document.removeEventListener("mousedown", stopNavigationEdit, true);
      document.removeEventListener("click", onNavigationClick, true);
      document.removeEventListener("keydown", onNavigationKeydown, true);
      window.clearTimeout(state.timer);
      window.clearInterval(state.pulseTimer);
      window.clearTimeout(state.pulseStopTimer);
      state.lastSignature = "";
      clearMarkedElements();
      delete window.__logseqLibraryDisplayHostMarker;
    },
  };

  readPayload();
})();
