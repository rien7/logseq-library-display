(function () {
  var PAYLOAD_ID = "logseq-library-display-payload";
  var PARENTED_ATTR = "data-library-display-parented";
  var CONTAINS_ATTR = "data-library-display-contains-parented-reference";
  var PARENTED_CLASS = "library-display-parented-reference";
  var CONTAINS_CLASS = "library-display-contains-parented-reference";
  var MARKED_SELECTOR =
    "[" + PARENTED_ATTR + "],[" + CONTAINS_ATTR + "]," +
    "." + PARENTED_CLASS + ",." + CONTAINS_CLASS;
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
  ];

  if (window.__logseqLibraryDisplayHostMarker) {
    window.__logseqLibraryDisplayHostMarker.refresh();
    return;
  }

  var state = {
    views: [],
    timer: 0,
    marking: false,
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

  function clearElement(element) {
    for (var i = 0; i < METADATA_ATTRS.length; i += 1) {
      element.removeAttribute(METADATA_ATTRS[i]);
    }
    element.classList.remove(PARENTED_CLASS, CONTAINS_CLASS);
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

  function readPayload() {
    var element = document.getElementById(PAYLOAD_ID);
    if (!element) return;

    try {
      var payload = decodePayload(element.textContent || "");
      state.views = Array.isArray(payload.views) ? payload.views : [];
      scheduleMark();
      startPulse();
    } catch (error) {
      console.warn("[logseq-library-display] failed to read host marker payload", error);
    }
  }

  function attr(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function query(selector) {
    try {
      return Array.prototype.slice.call(document.querySelectorAll(selector));
    } catch (_) {
      return [];
    }
  }

  function addMatches(matches, selector) {
    var elements = query(selector);
    for (var i = 0; i < elements.length; i += 1) {
      matches.push(elements[i]);
    }
  }

  function lower(value) {
    return String(value).trim().toLocaleLowerCase();
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

  function matchesForView(view) {
    var matches = [];

    if (view.pageUuid) {
      addMatches(matches, "[data-ref=\"" + attr(view.pageUuid) + "\"]");
      addMatches(matches, "[data-page-uuid=\"" + attr(view.pageUuid) + "\"]");
      addMatches(matches, "[data-block-uuid=\"" + attr(view.pageUuid) + "\"]");
    }

    if (view.pageId !== undefined && view.pageId !== null) {
      addMatches(matches, "[data-ref=\"" + attr(view.pageId) + "\"]");
      addMatches(matches, "[data-page-id=\"" + attr(view.pageId) + "\"]");
      addMatches(matches, "[data-entity-id=\"" + attr(view.pageId) + "\"]");
    }

    var titles = titleVariants(view);
    for (var i = 0; i < titles.length; i += 1) {
      addMatches(matches, "a.page-ref[data-ref=\"" + attr(titles[i]) + "\"]");
      addMatches(matches, "span.page-ref[data-ref=\"" + attr(titles[i]) + "\"]");
      addMatches(matches, ".page-reference[data-ref=\"" + attr(titles[i]) + "\"]");
      addMatches(matches, "[data-ref-name=\"" + attr(titles[i]) + "\"]");
      addMatches(matches, "[data-page=\"" + attr(titles[i]) + "\"]");
      addMatches(matches, "[data-page-name=\"" + attr(titles[i]) + "\"]");
    }

    return Array.prototype.filter.call(matches, function (element, index) {
      return matches.indexOf(element) === index;
    });
  }

  function markReference(element, view) {
    var targets = [element];
    var pageReference = element.closest(".page-reference[data-ref], .page-reference");
    var pageRef = element.closest("a.page-ref, span.page-ref, .page-ref");

    if (pageReference) targets.push(pageReference);
    if (pageRef) targets.push(pageRef);

    for (var i = 0; i < targets.length; i += 1) {
      var target = targets[i];
      setAttribute(target, PARENTED_ATTR, "true");
      setAttribute(target, "data-library-display-page-id", view.pageId);
      setAttribute(target, "data-library-display-page-uuid", view.pageUuid);
      setAttribute(target, "data-library-display-page-title", view.childTitle || view.title);
      setAttribute(target, "data-library-display-parent-id", view.parentId);
      setAttribute(target, "data-library-display-parent-uuid", view.parentUuid);
      setAttribute(target, "data-library-display-parent-title", view.parentTitle);
      setAttribute(target, "data-library-display-title", view.title);
      setAttribute(target, "data-library-display-value", view.display);
      target.classList.add(PARENTED_CLASS);
    }

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

  function mark() {
    state.marking = true;
    try {
      clearMarkedElements();
      for (var i = 0; i < state.views.length; i += 1) {
        var view = state.views[i];
        var matches = matchesForView(view);
        for (var j = 0; j < matches.length; j += 1) {
          markReference(matches[j], view);
        }
      }
    } finally {
      window.setTimeout(function () {
        state.marking = false;
      }, 0);
    }
  }

  function scheduleMark() {
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(mark, 80);
  }

  function startPulse() {
    window.clearInterval(state.pulseTimer);
    window.clearTimeout(state.pulseStopTimer);
    state.pulseTimer = window.setInterval(mark, 500);
    state.pulseStopTimer = window.setTimeout(function () {
      window.clearInterval(state.pulseTimer);
      state.pulseTimer = 0;
    }, 8000);
  }

  var observer = new MutationObserver(function (mutations) {
    if (state.marking) return;

    for (var i = 0; i < mutations.length; i += 1) {
      var mutation = mutations[i];
      if (mutation.target && mutation.target.id === PAYLOAD_ID) {
        readPayload();
        return;
      }

      if (mutation.type === "childList") {
        for (var j = 0; j < mutation.addedNodes.length; j += 1) {
          var node = mutation.addedNodes[j];
          if (node.nodeType === 1 && node.id === PAYLOAD_ID) {
            readPayload();
            return;
          }
        }
        scheduleMark();
        return;
      }

      if (
        mutation.type === "attributes" &&
        !String(mutation.attributeName || "").startsWith("data-library-display")
      ) {
        scheduleMark();
        return;
      }
    }
  });

  observer.observe(document.documentElement, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  });

  window.__logseqLibraryDisplayHostMarker = {
    refresh: readPayload,
    mark: mark,
    disconnect: function () {
      observer.disconnect();
      window.clearTimeout(state.timer);
      window.clearInterval(state.pulseTimer);
      window.clearTimeout(state.pulseStopTimer);
      clearMarkedElements();
      delete window.__logseqLibraryDisplayHostMarker;
    },
  };

  readPayload();
})();
