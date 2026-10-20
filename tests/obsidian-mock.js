window.obsidianMock = (function () {
  // Give a JSDOM element the createEl/createDiv helpers Obsidian augments HTMLElements with.
  function enhanceElement(el) {
    el.createEl = (tag, attrs) => {
      const child = document.createElement(tag);
      if (attrs && attrs.text !== undefined) child.textContent = attrs.text;
      if (attrs && attrs.cls) child.className = attrs.cls;
      el.appendChild(child);
      return child;
    };
    el.createDiv = (attrs) => el.createEl('div', attrs);
    el.empty = () => {
      el.innerHTML = '';
    };
    return el;
  }
  globalThis.__openedModals = globalThis.__openedModals || [];
  globalThis.__shownMenus = globalThis.__shownMenus || [];
  class Plugin {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest;
    }
    addCommand() {}
    addRibbonIcon() {
      return document.createElement('div');
    }
    addSettingTab() {}
    registerMarkdownPostProcessor(cb) {
      this.postProcessors = this.postProcessors || [];
      this.postProcessors.push(cb);
    }
    registerDomEvent(el, type, cb) {
      this.domEvents = this.domEvents || [];
      this.domEvents.push({ el, type, cb });
    }
    async loadData() {
      return {};
    }
    async saveData() {}
  }
  class Notice {
    constructor(message) {
      console.log('[Notice] ' + message);
    }
    hide() {}
    remove() {}
  }
  class PluginSettingTab {
    constructor(app, plugin) {
      this.app = app;
      this.plugin = plugin;
      this.containerEl = document.createElement('div');
    }
  }

  class Setting {
    constructor(el) {
      this.containerEl = el || document.createElement('div');
    }
    setName(n) {
      const div = document.createElement('div');
      if (typeof n === 'object') div.innerHTML = `<strong>${n.text}</strong>`;
      else div.textContent = n;
      this.containerEl.appendChild(div);
      return this;
    }
    setDesc(d) {
      const desc = document.createElement('div');
      desc.className = 'setting-item-description'; // Simulate Obsidian styling class
      if (typeof d === 'object') desc.innerHTML = `<span>${d.text}</span>`;
      else desc.textContent = d;
      this.containerEl.appendChild(desc);
      return this;
    }
    addDropdown(cb) {
      const dropdown = {
        addOption(k, v) {
          dropdown[k] = v;
          return this;
        },
        setValue(v) {
          dropdown.value = v;
          return { onChange: () => {} };
        },
        getValue() {
          return dropdown.value;
        },
      };
      cb(dropdown);
      // Render a hidden select for DOM test compatibility
      const sel = document.createElement('select');
      sel.textContent = 'v';
      this.containerEl.appendChild(sel);
      return this;
    }
    addSlider(cb) {
      const slider = {
        setLimits: (min, max) => ({ setValue: (v) => ({ setDynamicTooltip: () => ({ onChange: () => {} }) }) }),
        value: 10,
      };
      cb(slider);
      return this;
    }
    addText(cb) {
      const input = { setPlaceholder: (p) => ({ setValue: (v) => ({ onChange: () => {} }) }) };
      cb(input);
      const inp = document.createElement('input');
      this.containerEl.appendChild(inp);
      return this;
    }
    removeCta() {}

    addButton(cb) {
      globalThis._capturedBtns = globalThis._capturedBtns || [];

      // Create actual DOM element for existing tests expecting .innerHTML!
      const btnRow = document.createElement('button');
      btnRow.textContent = 'Button';
      this.containerEl.appendChild(btnRow);
      btnRow.className = 'clickable-button mod-cta';

      const btn = { containerEl: btnRow, setDisabled: () => btn, setWarning: () => btn };
      btn.setButtonText = (t) => {
        if (t !== undefined) btnRow.textContent = t;
        return btn;
      };

      // Intercept the click handler assignment exactly where Obsidian UI does it!
      btn.onClick = function (fn) {
        globalThis._capturedBtns.push({ btn, handler: fn });
        return btn;
      };

      cb(btn);
      return this;
    }
  }

  class MarkdownView {}
  function setIcon() {}

  class Modal {
    constructor(app) {
      this.app = app;
      this.contentEl = enhanceElement(document.createElement('div'));
    }
    open() {
      globalThis.__openedModals.push(this);
    }
    close() {
      if (this.onClose) {
        this.onClose();
      }
    }
  }

  class Menu {
    constructor() {
      this.items = [];
    }
    addItem(cb) {
      const item = {
        setTitle(title) {
          item.title = title;
          return item;
        },
        setIcon(icon) {
          item.icon = icon;
          return item;
        },
        onClick(fn) {
          item.handler = fn;
          return item;
        },
      };
      this.items.push(item);
      cb(item);
      return this;
    }
    showAtMouseEvent() {
      globalThis.__shownMenus.push(this);
      return this;
    }
  }

  class FuzzySuggestModal {
    constructor(app) {
      this.app = app;
    }
    open() {
      globalThis.__openedModals.push(this);
    }
    close() {}
    getItems() {
      return [];
    }
    getItemText(item) {
      return String(item);
    }
    onChooseItem() {}
  }

  return { Plugin, Notice, PluginSettingTab, Setting, MarkdownView, setIcon, Modal, Menu, FuzzySuggestModal };
})();

module.exports = window.obsidianMock;
