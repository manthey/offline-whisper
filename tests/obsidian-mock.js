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
  }
  class PluginSettingTab {
    constructor(app, plugin) {
      this.app = app;
      this.plugin = plugin;
      this.containerEl = document.createElement('div');
    }
  }
  class Setting {
    constructor() {}
    setName() {
      return this;
    }
    setDesc() {
      return this;
    }
    addDropdown() {
      return this;
    }
    addSlider() {
      return this;
    }
    addButton() {
      return this;
    }
  }
  class MarkdownView {}
  function setIcon() {}
  return { Plugin, Notice, PluginSettingTab, Setting, MarkdownView, setIcon };
})();
