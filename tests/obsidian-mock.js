window.obsidianMock = (function () {
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

  return { Plugin, Notice, PluginSettingTab, Setting, MarkdownView, setIcon };
})();

module.exports = window.obsidianMock;
